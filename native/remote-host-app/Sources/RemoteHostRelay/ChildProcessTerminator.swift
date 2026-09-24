import Darwin
import Dispatch

/** Bounded synchronous termination followed by an owned asynchronous reap when needed. */
enum ChildProcessTerminator {
  typealias Operation = @Sendable (pid_t, @escaping @Sendable () -> Void) -> Bool
  static let gracefulPollAttempts = 250
  static let forcedPollAttempts = 250
  static let pollMicroseconds: useconds_t = 1_000
  static let deferredPollMicroseconds: useconds_t = 10_000

  @discardableResult static func terminate(
    _ pid: pid_t,
    sendSignal: (Int32) -> Int32,
    wait: () -> pid_t,
    pause: () -> Void
  ) -> Bool {
    guard pid > 0 else { return true }
    if poll(pid, attempts: 1, wait: wait, pause: pause) { return true }
    _ = sendSignal(SIGTERM)
    if poll(pid, attempts: gracefulPollAttempts, wait: wait, pause: pause) { return true }
    _ = sendSignal(SIGKILL)
    return poll(pid, attempts: forcedPollAttempts, wait: wait, pause: pause)
  }

  private static func poll(_ pid: pid_t, attempts: Int, wait: () -> pid_t, pause: () -> Void) -> Bool {
    for attempt in 0..<attempts {
      errno = 0
      let result = wait()
      if result == pid || (result == -1 && errno == ECHILD) { return true }
      if attempt + 1 < attempts { pause() }
    }
    return false
  }

  @discardableResult static func terminate(_ pid: pid_t) -> Bool {
    return terminate(
      pid,
      sendSignal: { kill(pid, $0) },
      wait: {
        var status: Int32 = 0
        return waitpid(pid, &status, WNOHANG)
      },
      pause: { usleep(pollMicroseconds) }
    )
  }

  /**
   Returns within the same bounded TERM/KILL window. If the child has still not
   been reaped, a retained background job keeps polling until waitpid confirms
   the exit; `onReaped` lets the supervisor release its PID ownership then.
   */
  @discardableResult static func terminateAndContinue(
    _ pid: pid_t,
    sendSignal: @escaping @Sendable (Int32) -> Int32,
    wait: @escaping @Sendable () -> pid_t,
    pause: @escaping @Sendable () -> Void,
    deferredPause: @escaping @Sendable () -> Void,
    schedule: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void,
    onReaped: @escaping @Sendable () -> Void
  ) -> Bool {
    guard !terminate(pid, sendSignal: sendSignal, wait: wait, pause: pause) else { return true }
    schedule {
      waitUntilReaped(pid, wait: wait, pause: deferredPause)
      onReaped()
    }
    return false
  }

  @discardableResult static func terminateAndContinue(
    _ pid: pid_t,
    onReaped: @escaping @Sendable () -> Void
  ) -> Bool {
    terminateAndContinue(
      pid,
      sendSignal: { kill(pid, $0) },
      wait: {
        var status: Int32 = 0
        return waitpid(pid, &status, WNOHANG)
      },
      pause: { usleep(pollMicroseconds) },
      deferredPause: { usleep(deferredPollMicroseconds) },
      schedule: { work in DispatchQueue.global(qos: .utility).async(execute: work) },
      onReaped: onReaped
    )
  }

  private static func waitUntilReaped(
    _ pid: pid_t,
    wait: @Sendable () -> pid_t,
    pause: @Sendable () -> Void
  ) {
    while true {
      errno = 0
      let result = wait()
      if result == pid || (result == -1 && errno == ECHILD) { return }
      pause()
    }
  }
}
