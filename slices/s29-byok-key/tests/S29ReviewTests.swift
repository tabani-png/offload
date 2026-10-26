import Foundation
import Testing

// S29 review round 1 (PR #36, Codex P2 x2). Written before the fix.
// 1. Cancel / "Skip for now" / Remove during the Anthropic check: the stale answer is dropped; nothing is saved and the
//    brain is not restarted (onChange does not fire).
// 2. Replacing a key never loses the working one: a Keychain that refuses keeps the old key, Settings keeps saying
//    what is really stored, and the brain is not restarted. Status always comes from the store after a write.
// The keys below are made-up test strings, not real keys.

private let newKey = "sk-ant-api03-" + String(repeating: "n", count: 80) + "NEW1"
private let oldKey = "sk-ant-api03-" + String(repeating: "o", count: 80) + "OLD1"

/// A Keychain with update-in-place semantics: a refused write leaves the stored value as it was.
private final class ReviewStore: ClaudeKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  var refuseSave = false
  var refuseRemove = false
  private(set) var saves = 0
  init(_ v: String? = nil) { value = v }
  var stored: String? { lock.withLock { value } }
  func save(_ key: String, last4: String) throws {
    if refuseSave { throw SecretStoreError.failed("The Keychain did not save the key. Your old key is unchanged.") }
    lock.withLock { value = key; saves += 1 }
  }
  func remove() throws {
    if refuseRemove { throw SecretStoreError.failed("The Keychain did not remove the key.") }
    lock.withLock { value = nil }
  }
  func status() -> ClaudeKeyStatus { lock.withLock { value.map { .set(last4: String($0.suffix(4))) } ?? .missing } }
}

/// Holds the check open until released, then answers. Ignores cancellation on purpose (like a request already sent).
private final class GatedValidator: ClaudeKeyValidator, @unchecked Sendable {
  private let lock = NSLock()
  private var gate: CheckedContinuation<Void, Never>?
  private var opened = false
  let answer: ClaudeKeyCheck
  init(_ a: ClaudeKeyCheck = .valid) { answer = a }
  var started: Bool { lock.withLock { gate != nil } }
  func check(_ key: String) async -> ClaudeKeyCheck {
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      let resumeNow: Bool = lock.withLock { if opened { return true }; gate = c; return false }
      if resumeNow { c.resume() }
    }
    return answer
  }
  func release() {
    let g: CheckedContinuation<Void, Never>? = lock.withLock { opened = true; let g = gate; gate = nil; return g }
    g?.resume()
  }
}

@MainActor
private func waitUntil(_ cond: () -> Bool) async {
  for _ in 0..<2000 where !cond() { try? await Task.sleep(nanoseconds: 1_000_000) }
}

@MainActor
struct S29ReviewCancelTests {
  @Test("CANCEL: Cancel during the check drops Anthropic's late 'valid': nothing saved, no restart")
  func cancelMidCheck() async {
    let store = ReviewStore()
    let v = GatedValidator(.valid)
    let c = ClaudeKeyController(store: store, validator: v)
    var changes = 0
    c.onChange = { _ in changes += 1 }
    c.beginReplace()
    c.edit(newKey)
    let t = c.submit()
    await waitUntil { v.started }
    #expect(c.flow.isChecking)
    c.cancel()
    v.release()
    await t?.value
    #expect(store.saves == 0 && store.stored == nil)
    #expect(changes == 0)
    #expect(c.flow.status == .missing && c.flow.phase == .idle)
  }

  @Test("CANCEL: Remove during a replace check keeps the removal; the late answer does not bring a key back")
  func removeMidCheck() async {
    let store = ReviewStore(oldKey)
    let v = GatedValidator(.valid)
    let c = ClaudeKeyController(store: store, validator: v)
    var changes: [ClaudeKeyStatus] = []
    c.onChange = { changes.append($0) }
    c.beginReplace()
    c.edit(newKey)
    let t = c.submit()
    await waitUntil { v.started }
    c.remove()
    v.release()
    await t?.value
    #expect(store.stored == nil && store.saves == 0)
    #expect(changes == [.missing])
    #expect(c.flow.status == .missing)
  }

  @Test("CANCEL: a new submit after a cancel is the one that counts; the first one's answer is dropped")
  func staleGeneration() async {
    let store = ReviewStore()
    let first = GatedValidator(.valid)
    let c = ClaudeKeyController(store: store, validator: first)
    var changes = 0
    c.onChange = { _ in changes += 1 }
    c.edit(newKey)
    let t1 = c.submit()
    await waitUntil { first.started }
    c.cancel()
    c.edit(oldKey)
    let t2 = c.submit()   // the same gated validator: both answers arrive on release, the first one stale
    first.release()
    await t1?.value
    await t2?.value
    #expect(store.stored == oldKey && store.saves == 1)
    #expect(changes == 1)
    #expect(c.flow.status == .set(last4: "OLD1"))
  }

  @Test("CANCEL: a valid check that is not cancelled saves once and restarts once")
  func happyPath() async {
    let store = ReviewStore()
    let v = GatedValidator(.valid)
    let c = ClaudeKeyController(store: store, validator: v)
    var changes: [ClaudeKeyStatus] = []
    c.onChange = { changes.append($0) }
    c.edit(newKey)
    let t = c.submit()
    await waitUntil { v.started }
    v.release()
    await t?.value
    #expect(store.stored == newKey)
    #expect(changes == [.set(last4: "NEW1")])
  }
}

@MainActor
struct S29ReviewReplaceTests {
  @Test("REPLACE: a Keychain that refuses the new key keeps the old one; Settings still says the old key; no restart")
  func refusedReplace() async {
    let store = ReviewStore(oldKey)
    store.refuseSave = true
    let v = GatedValidator(.valid)
    let c = ClaudeKeyController(store: store, validator: v)
    var changes = 0
    c.onChange = { _ in changes += 1 }
    c.beginReplace()
    c.edit(newKey)
    let t = c.submit()
    await waitUntil { v.started }
    v.release()
    await t?.value
    #expect(store.stored == oldKey)
    #expect(c.flow.status == .set(last4: "OLD1"))
    #expect(changes == 0)
    guard case .failed(let why) = c.flow.phase else { Issue.record("expected failed, got \(c.flow.phase)"); return }
    #expect(why.contains("Keychain"))
  }

  @Test("REPLACE: 'Save without checking' that the Keychain refuses keeps the old key and does not restart")
  func refusedUnverified() async {
    let store = ReviewStore(oldKey)
    let v = GatedValidator(.unreachable("Offline."))
    let c = ClaudeKeyController(store: store, validator: v)
    var changes = 0
    c.onChange = { _ in changes += 1 }
    c.beginReplace()
    c.edit(newKey)
    let t = c.submit()
    await waitUntil { v.started }
    v.release()
    await t?.value
    #expect(c.flow.canSaveWithoutChecking)
    store.refuseSave = true
    c.saveWithoutChecking()
    #expect(store.stored == oldKey && c.flow.status == .set(last4: "OLD1") && changes == 0)
  }

  @Test("REPLACE: a refused Remove keeps the key, Settings still says set, no restart")
  func refusedRemove() {
    let store = ReviewStore(oldKey)
    store.refuseRemove = true
    let v = GatedValidator()
    let c = ClaudeKeyController(store: store, validator: v)
    var changes = 0
    c.onChange = { _ in changes += 1 }
    c.remove()
    #expect(store.stored == oldKey && c.flow.status == .set(last4: "OLD1") && changes == 0)
    guard case .failed = c.flow.phase else { Issue.record("expected failed, got \(c.flow.phase)"); return }
  }

  @Test("REPLACE: after a write the status is read back from the store, not assumed")
  func statusFromStore() {
    let store = ReviewStore()
    var f = ClaudeKeyFlow(status: .missing)
    f.edit(newKey)
    guard let k = f.begin() else { Issue.record("begin refused a good key"); return }
    f.apply(.valid, key: k, store: store)
    #expect(f.status == store.status())
    f.remove(store: store)
    #expect(f.status == store.status() && f.status == .missing)
  }
}
