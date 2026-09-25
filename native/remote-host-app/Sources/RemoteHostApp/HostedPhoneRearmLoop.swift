import Foundation

/** Keeps an explicitly activated phone route listening across sequential transports. */
final class HostedPhoneRearmLoop: @unchecked Sendable {
  private let lock = NSLock()
  private let activate: @Sendable () async throws -> Void
  private let retryDelay: @Sendable () async throws -> Void
  private var armed = false
  private var generation: UInt64 = 0
  private var pending = false
  private var worker: Task<Void, Never>?

  init(
    activate: @escaping @Sendable () async throws -> Void,
    retryDelay: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(2)) }
  ) {
    self.activate = activate
    self.retryDelay = retryDelay
  }

  func arm() {
    lock.withLock { armed = true }
  }

  func request() {
    lock.withLock {
      guard armed else { return }
      pending = true
      if worker == nil {
        worker = Task { [weak self] in await self?.run() }
      }
    }
  }

  func disarm() {
    let task = lock.withLock {
      armed = false
      generation &+= 1
      pending = false
      return worker
    }
    task?.cancel()
  }

  private func run() async {
    defer {
      let restart = lock.withLock {
        worker = nil
        return armed && pending
      }
      if restart { request() }
    }
    while !Task.isCancelled {
      let token: UInt64? = lock.withLock {
        guard armed, pending else { return nil }
        pending = false
        return generation
      }
      guard let token else { return }
      do {
        try await activate()
      } catch {
        let retry = lock.withLock {
          guard armed, generation == token else { return false }
          pending = true
          return true
        }
        guard retry else { continue }
        do { try await retryDelay() }
        catch { return }
      }
    }
  }
}
