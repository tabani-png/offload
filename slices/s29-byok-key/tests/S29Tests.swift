import Foundation
import Testing

// S29: bring your own Claude key. Onboarding and Settings store it in the login Keychain (service offload.anthropic,
// account api-key); the brain is told the item's NAME only (OFFLOAD_ANTHROPIC_KEYCHAIN) and reads it itself.
// Written before the code (slices/s29-byok-key/SPEC.md). A fake Keychain and a fake validator: nothing here touches
// the real Keychain or the network. The keys below are made-up test strings, not real keys.

private let goodKey = "sk-ant-api03-" + String(repeating: "a", count: 80) + "WXYZ"

/// The fake Keychain: one item, counts writes, can be told to refuse.
private final class FakeKeyStore: ClaudeKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  private var tail: String?
  var refuse = false
  private(set) var saves = 0
  private(set) var removes = 0

  init(value: String? = nil) {
    self.value = value
    self.tail = value.map { String($0.suffix(4)) }
  }

  var stored: String? { lock.withLock { value } }

  func save(_ key: String, last4: String) throws {
    if refuse { throw SecretStoreError.failed("The Keychain did not save it.") }
    lock.withLock { value = key; tail = last4; saves += 1 }
  }

  func remove() throws {
    if refuse { throw SecretStoreError.failed("The Keychain did not remove it.") }
    lock.withLock { value = nil; tail = nil; removes += 1 }
  }

  func status() -> ClaudeKeyStatus { lock.withLock { tail.map { .set(last4: $0) } ?? .missing } }
}

/// The fake validator: a fixed answer, and the keys it was asked about.
private final class FakeValidator: ClaudeKeyValidator, @unchecked Sendable {
  let answer: ClaudeKeyCheck
  private let lock = NSLock()
  private var seen: [String] = []
  init(_ answer: ClaudeKeyCheck) { self.answer = answer }
  var calls: Int { lock.withLock { seen.count } }
  func check(_ key: String) async -> ClaudeKeyCheck {
    lock.withLock { seen.append(key) }
    return answer
  }
}

/// Records the one request the real validator would send, and answers with a status code.
private final class FakeHTTP: @unchecked Sendable {
  let code: Int
  let fail: Bool
  private let lock = NSLock()
  private var reqs: [URLRequest] = []
  init(code: Int, fail: Bool = false) { self.code = code; self.fail = fail }
  var requests: [URLRequest] { lock.withLock { reqs } }
  func send(_ r: URLRequest) async throws -> (Data, URLResponse) {
    lock.withLock { reqs.append(r) }
    if fail { throw URLError(.notConnectedToInternet) }
    return (Data("{}".utf8), HTTPURLResponse(url: r.url!, statusCode: code, httpVersion: nil, headerFields: nil)!)
  }
}

struct S29FormatTests {
  @Test("FORMAT: a key-shaped string has no problem; the last four are what Settings shows")
  func good() {
    #expect(ClaudeKeyFormat.problem(goodKey) == nil)
    #expect(ClaudeKeyFormat.problem("  \(goodKey)\n") == nil)   // pasted with a stray newline: trimmed
    #expect(ClaudeKeyFormat.last4(goodKey) == "WXYZ")
  }

  @Test("FORMAT: empty, spaces, wrong prefix, too short, odd characters are each a plain sentence")
  func bad() {
    for bad in ["", "   ", "sk-ant-api03-abc def" + String(repeating: "x", count: 40), "sk-proj-" + String(repeating: "x", count: 60),
                "sk-ant-short", "sk-ant-api03-" + String(repeating: "x", count: 40) + "!$%", String(repeating: "x", count: 5000)] {
      let p = ClaudeKeyFormat.problem(bad)
      #expect(p != nil, "\(bad.prefix(20)) should be refused")
      #expect(p?.hasSuffix(".") == true)
      // The sentence never repeats what was pasted.
      if bad.count > 8 { #expect(p?.contains(bad.trimmingCharacters(in: .whitespaces)) == false) }
    }
  }
}

struct S29ValidateTests {
  @Test("VALIDATE: one GET to api.anthropic.com/v1/models, the key in x-api-key only, never in the URL")
  func request() async {
    let http = FakeHTTP(code: 200)
    let v = AnthropicKeyValidator(send: { try await http.send($0) })
    #expect(await v.check(goodKey) == .valid)
    #expect(http.requests.count == 1)
    let r = http.requests[0]
    #expect(r.httpMethod == "GET")
    #expect(r.url?.scheme == "https" && r.url?.host == "api.anthropic.com" && r.url?.path == "/v1/models")
    #expect(r.url?.absoluteString.contains(goodKey) == false)
    #expect(r.value(forHTTPHeaderField: "x-api-key") == goodKey)
    #expect(r.value(forHTTPHeaderField: "anthropic-version") != nil)
    #expect(r.httpBody == nil)
  }

  @Test("VALIDATE: 401 and 403 are rejected, 5xx/429 and no network are 'could not check'; no message holds the key")
  func answers() async {
    for code in [401, 403] {
      let r = await AnthropicKeyValidator(send: { try await FakeHTTP(code: code).send($0) }).check(goodKey)
      guard case .rejected(let why) = r else { Issue.record("\(code) should be rejected, got \(r)"); continue }
      #expect(!why.contains(goodKey) && !why.isEmpty)
    }
    for code in [429, 500, 529] {
      let r = await AnthropicKeyValidator(send: { try await FakeHTTP(code: code).send($0) }).check(goodKey)
      guard case .unreachable(let why) = r else { Issue.record("\(code) should be unreachable, got \(r)"); continue }
      #expect(!why.contains(goodKey))
    }
    let off = await AnthropicKeyValidator(send: { try await FakeHTTP(code: 0, fail: true).send($0) }).check(goodKey)
    guard case .unreachable = off else { Issue.record("no network should be unreachable, got \(off)"); return }
  }
}

struct S29FlowTests {
  @Test("FLOW: a valid key is checked once, saved to the Keychain with its last four, and the field is cleared")
  func validSaves() async {
    let store = FakeKeyStore()
    let v = FakeValidator(.valid)
    var f = ClaudeKeyFlow(status: store.status())
    f.beginReplace()
    f.edit(goodKey)
    f = await ClaudeKeyFlow.submit(f, validator: v, store: store)
    #expect(v.calls == 1)
    #expect(store.stored == goodKey && store.saves == 1)
    #expect(f.status == .set(last4: "WXYZ"))
    #expect(f.phase == .saved)
    #expect(f.text.isEmpty)
    #expect(!String(describing: f).contains(goodKey))
  }

  @Test("FLOW: a malformed key is never sent to Anthropic and never saved")
  func badFormat() async {
    let store = FakeKeyStore()
    let v = FakeValidator(.valid)
    var f = ClaudeKeyFlow(status: .missing)
    f.edit("not a key")
    f = await ClaudeKeyFlow.submit(f, validator: v, store: store)
    #expect(v.calls == 0 && store.saves == 0)
    guard case .failed = f.phase else { Issue.record("expected failed, got \(f.phase)"); return }
    #expect(f.status == .missing)
  }

  @Test("FLOW: a key Anthropic rejects is not saved, and the old key stays")
  func rejected() async {
    let old = "sk-ant-api03-" + String(repeating: "b", count: 80) + "OLD1"
    let store = FakeKeyStore(value: old)
    var f = ClaudeKeyFlow(status: store.status())
    f.beginReplace()
    f.edit(goodKey)
    f = await ClaudeKeyFlow.submit(f, validator: FakeValidator(.rejected("Anthropic did not accept that key.")), store: store)
    #expect(store.stored == old && store.saves == 0)
    #expect(f.phase == .failed("Anthropic did not accept that key."))
    #expect(f.status == .set(last4: "OLD1"))
  }

  @Test("FLOW: when Anthropic cannot be reached the person may save without checking")
  func unverified() async {
    let store = FakeKeyStore()
    var f = ClaudeKeyFlow(status: .missing)
    f.edit(goodKey)
    f = await ClaudeKeyFlow.submit(f, validator: FakeValidator(.unreachable("Could not reach Anthropic.")), store: store)
    guard case .unverified = f.phase else { Issue.record("expected unverified, got \(f.phase)"); return }
    #expect(store.saves == 0)
    #expect(!String(describing: f).contains(goodKey))
    f.saveWithoutChecking(store: store)
    #expect(store.stored == goodKey && f.status == .set(last4: "WXYZ") && f.phase == .saved)
    // Only once: a second call does nothing.
    f.saveWithoutChecking(store: store)
    #expect(store.saves == 1)
  }

  @Test("FLOW: a Keychain that refuses is a sentence, not a crash, and nothing is marked set")
  func storeRefuses() async {
    let store = FakeKeyStore()
    store.refuse = true
    var f = ClaudeKeyFlow(status: .missing)
    f.edit(goodKey)
    f = await ClaudeKeyFlow.submit(f, validator: FakeValidator(.valid), store: store)
    guard case .failed(let why) = f.phase else { Issue.record("expected failed, got \(f.phase)"); return }
    #expect(why.contains("Keychain"))
    #expect(f.status == .missing)
  }

  @Test("FLOW: Remove deletes the item; Cancel leaves the stored key alone")
  func removeAndCancel() {
    let store = FakeKeyStore(value: goodKey)
    var f = ClaudeKeyFlow(status: store.status())
    f.beginReplace()
    f.edit("sk-ant-half")
    f.cancel()
    #expect(f.phase == .idle && f.text.isEmpty && store.stored == goodKey)
    f.remove(store: store)
    #expect(store.removes == 1 && store.stored == nil && f.status == .missing)
  }
}

struct S29SettingsTests {
  @Test("SETTINGS: 'Key set (…last 4)' with Replace and Remove; 'No key yet' with Add")
  func lines() {
    let set = ClaudeKeyFlow(status: .set(last4: "WXYZ"))
    #expect(set.status.settingsLine == "Key set (…WXYZ)")
    #expect(set.actions == [.replace, .remove])
    #expect(ClaudeKeyFlow.Action.replace.title == "Replace key" && ClaudeKeyFlow.Action.remove.title == "Remove key")
    let none = ClaudeKeyFlow(status: .missing)
    #expect(none.status.settingsLine == "No key yet")
    #expect(none.actions == [.add])
    #expect(ClaudeKeyFlow.Action.add.title == "Add key")
  }

  @Test("SETTINGS: no key -> one plain notice pointing to Settings; a key -> no notice")
  func notice() {
    let n = ClaudeKeyStatus.missing.notice
    #expect(n != nil && n!.contains("Settings") && n!.contains("Claude"))
    #expect(ClaudeKeyStatus.set(last4: "WXYZ").notice == nil)
  }
}

struct S29LaunchTests {
  let loc = BrainLocation(bun: URL(fileURLWithPath: "/A/Offload.app/Contents/Helpers/bun"),
                          root: URL(fileURLWithPath: "/A/Offload.app/Contents/Resources/offload"), bundled: true)

  @Test("LAUNCH: the Keychain item is offload.anthropic / api-key, referenced as service/account")
  func item() {
    #expect(ClaudeKeyItem.service == "offload.anthropic")
    #expect(ClaudeKeyItem.account == "api-key")
    #expect(ClaudeKeyItem.reference == "offload.anthropic/api-key")
  }

  @Test("LAUNCH: with a key the brain gets the item's NAME, loses an inherited ANTHROPIC_API_KEY, and no argv or env holds the key")
  func withKey() {
    let base = ["PATH": "/usr/bin:/bin", "ANTHROPIC_API_KEY": "sk-ant-from-shell-" + String(repeating: "z", count: 40), "HOME": "/u"]
    let env = BrainLaunch.claudeKeyEnvironment(base, status: .set(last4: "WXYZ"))
    #expect(env["OFFLOAD_ANTHROPIC_KEYCHAIN"] == "offload.anthropic/api-key")
    #expect(env["ANTHROPIC_API_KEY"] == nil)
    let spec = BrainLaunch.spec(location: loc, home: URL(fileURLWithPath: "/h"), token: String(repeating: "t", count: 43),
                                baseEnvironment: env)
    #expect(spec.environment["OFFLOAD_ANTHROPIC_KEYCHAIN"] == "offload.anthropic/api-key")
    let everything = (spec.arguments + spec.environment.map { "\($0.key)=\($0.value)" }).joined(separator: "\n")
    #expect(!everything.contains("sk-ant-"))
    #expect(!everything.contains("WXYZ"))
  }

  @Test("LAUNCH: with no key nothing is added (local features run; a developer's own env is left alone)")
  func withoutKey() {
    let env = BrainLaunch.claudeKeyEnvironment(["PATH": "/usr/bin"], status: .missing)
    #expect(env["OFFLOAD_ANTHROPIC_KEYCHAIN"] == nil)
    #expect(env == ["PATH": "/usr/bin"])
  }
}

struct S29OnboardTests {
  @Test("ONBOARD: the first screen asks for the key when none is set, and is skipped when one is")
  func gate() {
    #expect(ClaudeKeyStep.shows(status: .missing))
    #expect(!ClaudeKeyStep.shows(status: .set(last4: "WXYZ")))
    #expect(ClaudeKeyStep.title == "Your Claude API key")
    #expect(ClaudeKeyStep.intro.contains("console.anthropic.com"))
    #expect(ClaudeKeyStep.skipTitle == "Skip for now")
  }

  @Test("ONBOARD: the existing four steps are unchanged")
  func unchanged() {
    #expect(OnboardingStep.allCases == [.watches, .permissions, .context, .comeBack])
  }
}

struct S29CheckTests {
  @Test("CHECK: --brain-check says key: set or key: missing, never the key or its last four")
  func line() {
    #expect(ClaudeKeyStatus.set(last4: "WXYZ").checkLine == "key: set")
    #expect(ClaudeKeyStatus.missing.checkLine == "key: missing")
  }
}
