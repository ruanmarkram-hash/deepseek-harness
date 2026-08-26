import Foundation

/**
 Native owner-presence state for one protected identity. Completion and clearing
 share one lock so an authentication result cannot restore a session that has
 already been cleared by disconnect or app backgrounding.
 */
final class DshPresenceSession<Identity> {
  private let lock = NSLock()
  private var active: Identity?
  private var generation = 0

  func begin() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return generation
  }

  func complete(_ identity: Identity, generation requestedGeneration: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard generation == requestedGeneration else { return false }
    active = identity
    return true
  }

  func current() -> Identity? {
    lock.lock()
    defer { lock.unlock() }
    return active
  }

  func clear() {
    lock.lock()
    generation = generation &+ 1
    active = nil
    lock.unlock()
  }
}
