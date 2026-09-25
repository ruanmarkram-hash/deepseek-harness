import Foundation
import Testing
@testable import RemoteHostApp

private actor RearmAttempts {
  private var count = 0
  private var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
  func record() -> Int {
    count += 1
    let ready = waiters.filter { count >= $0.0 }
    waiters.removeAll { count >= $0.0 }
    for (_, waiter) in ready { waiter.resume() }
    return count
  }
  func waitFor(_ target: Int) async {
    if count >= target { return }
    await withCheckedContinuation { waiters.append((target, $0)) }
  }
  func current() -> Int { count }
}

private enum RearmTestFailure: Error { case firstAttempt }

@Test("an armed Host retries a failed relay wait without another menu action")
func hostedPhoneRearmRetries() async {
  let attempts = RearmAttempts()
  let loop = HostedPhoneRearmLoop(activate: {
    if await attempts.record() == 1 { throw RearmTestFailure.firstAttempt }
  }, retryDelay: {})
  loop.arm()
  loop.request()
  await attempts.waitFor(2)
  #expect(await attempts.current() == 2)
  loop.disarm()
}

@Test("Host stop disarms an in-flight reconnect before a second attempt")
func hostedPhoneRearmDisarms() async {
  let attempts = RearmAttempts()
  let retryEntered = RearmAttempts()
  let loop = HostedPhoneRearmLoop(activate: {
    _ = await attempts.record()
    throw RearmTestFailure.firstAttempt
  }, retryDelay: {
    _ = await retryEntered.record()
    try await Task.sleep(for: .seconds(10))
  })
  loop.arm()
  loop.request()
  await retryEntered.waitFor(1)
  loop.disarm()
  try? await Task.sleep(for: .milliseconds(10))
  #expect(await attempts.current() == 1)
}
