import Foundation

// s29: bring your own Claude key. The person pastes their own Claude API key once (first-run window or Settings); the
// app checks its shape, makes one free call to Anthropic to check it works, and keeps it in the login Keychain under
// one fixed item. The brain is only told the item's NAME (OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key) and
// reads the value itself (brain/src/vision/claude.ts resolveAnthropicKey). The key is never logged, written to a
// file or UserDefaults, or put in any process's argv or environment. Everything here is pure apart from the injected
// store and HTTP layer, so it is tested with fakes (slices/s29-byok-key/tests).

/// The one Keychain item that holds the key: generic password, service `offload.anthropic`, account `api-key`.
enum ClaudeKeyItem {
  static let service = "offload.anthropic"
  static let account = "api-key"
  /// The brain's reference format is `service/account` (OFFLOAD_ANTHROPIC_KEYCHAIN).
  static var reference: String { "\(service)/\(account)" }
  static let environmentName = "OFFLOAD_ANTHROPIC_KEYCHAIN"
}

/// Whether a key is stored. `last4` comes from the item's attributes, never from reading the secret.
enum ClaudeKeyStatus: Equatable, Sendable {
  case missing
  case set(last4: String)

  var isSet: Bool { if case .set = self { return true } else { return false } }

  /// The Settings row.
  var settingsLine: String {
    switch self {
    case .missing: return "No key yet"
    case .set(let l): return "Key set (…\(l))"
    }
  }

  /// The one plain message Claude features show when there is no key; nil when there is one.
  var notice: String? {
    isSet ? nil : "Claude is off until you add your Claude API key in Settings (Dashboard, Observing). Everything else keeps working on this Mac."
  }

  /// `Offload --brain-check`: whether a key is stored, never the key or any part of it.
  var checkLine: String { isSet ? "key: set" : "key: missing" }
}

/// The shape of an Anthropic API key, checked before anything is sent.
enum ClaudeKeyFormat {
  static let prefix = "sk-ant-"
  static let minLength = 40
  static let maxLength = 300

  static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// Why the text cannot be a Claude API key, in plain words; nil when it can. Never repeats the text.
  static func problem(_ raw: String) -> String? {
    let v = trimmed(raw)
    if v.isEmpty { return "Paste your Claude API key first." }
    if v.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return "A key has no spaces or line breaks. Copy just the key." }
    if !v.hasPrefix(prefix) { return "That is not a Claude API key. Claude keys start with sk-ant-." }
    if v.count < minLength { return "That key looks cut short. Copy all of it." }
    if v.count > maxLength { return "That is longer than a Claude API key." }
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    if v.unicodeScalars.contains(where: { !allowed.contains($0) }) { return "That key has characters a Claude key never has. Copy it again." }
    return nil
  }

  static func last4(_ key: String) -> String { String(trimmed(key).suffix(4)) }
}

/// Where the key is kept: the login Keychain in the app (Surfaces/ClaudeKeychain.swift), a fake in tests.
protocol ClaudeKeyStore: Sendable {
  /// Adds or replaces the item. `last4` is stored as a plain attribute so Settings can show it.
  func save(_ key: String, last4: String) throws
  func remove() throws
  /// Reads attributes only, never the secret.
  func status() -> ClaudeKeyStatus
}

/// What Anthropic said about a key.
enum ClaudeKeyCheck: Equatable, Sendable {
  case valid
  /// Anthropic refused it (401/403): it is not saved.
  case rejected(String)
  /// The check could not run (offline, rate limited, Anthropic busy): the person may save it without checking.
  case unreachable(String)
}

protocol ClaudeKeyValidator: Sendable {
  func check(_ key: String) async -> ClaudeKeyCheck
}

/// One `GET https://api.anthropic.com/v1/models?limit=1` (free, no tokens), the key in the `x-api-key` header only.
struct AnthropicKeyValidator: ClaudeKeyValidator {
  typealias Send = @Sendable (URLRequest) async throws -> (Data, URLResponse)
  static let url = URL(string: "https://api.anthropic.com/v1/models?limit=1")!
  static let version = "2023-06-01"

  var send: Send = AnthropicKeyValidator.live

  static func request(key: String) -> URLRequest {
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
    r.httpMethod = "GET"
    r.setValue(ClaudeKeyFormat.trimmed(key), forHTTPHeaderField: "x-api-key")
    r.setValue(version, forHTTPHeaderField: "anthropic-version")
    return r
  }

  func check(_ key: String) async -> ClaudeKeyCheck {
    do {
      let (_, resp) = try await send(Self.request(key: key))
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      switch code {
      case 200: return .valid
      case 401: return .rejected("Anthropic did not accept that key. Check that you copied all of it, or make a new one at console.anthropic.com.")
      case 403: return .rejected("That key is not allowed to use the Claude API. Check it at console.anthropic.com.")
      default: return .unreachable("Anthropic could not check the key right now (HTTP \(code)).")
      }
    } catch {
      return .unreachable("Offload could not reach Anthropic to check the key.")
    }
  }

  /// Ephemeral (no cache, no cookies) and no redirects: the key header only ever goes to api.anthropic.com.
  static let live: Send = { r in
    guard r.url?.scheme == "https", r.url?.host == "api.anthropic.com" else { throw URLError(.badURL) }
    let c = URLSessionConfiguration.ephemeral
    c.urlCache = nil
    c.httpCookieStorage = nil
    let s = URLSession(configuration: c)
    defer { s.finishTasksAndInvalidate() }
    return try await s.data(for: r, delegate: NoRedirect())
  }

  private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
      completionHandler(nil)
    }
  }
}

/// The key entry and Settings state: entering -> checking -> saved | failed | unverified. Pure apart from the store
/// and validator it is handed. Its description never shows the key.
struct ClaudeKeyFlow: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
  enum Phase: Equatable, Sendable {
    case idle
    case entering
    case checking
    case saved
    case failed(String)
    /// Anthropic could not be reached; "Save without checking" is offered.
    case unverified(String)
  }

  enum Action: Equatable, Sendable {
    case add, replace, remove
    var title: String {
      switch self {
      case .add: return "Add key"
      case .replace: return "Replace key"
      case .remove: return "Remove key"
      }
    }
  }

  private(set) var status: ClaudeKeyStatus
  private(set) var phase: Phase = .idle
  /// The secure field's text. Cleared as soon as it is handed to the check.
  private(set) var text = ""
  /// Held in memory only while "Save without checking" is offered.
  private var pending: String?

  init(status: ClaudeKeyStatus) { self.status = status }

  var description: String { "ClaudeKeyFlow(status: \(status.checkLine), phase: \(phase))" }
  var debugDescription: String { description }

  var actions: [Action] { status.isSet ? [.replace, .remove] : [.add] }
  var isEntering: Bool { phase != .idle && phase != .saved }
  var isChecking: Bool { phase == .checking }
  var canSaveWithoutChecking: Bool { if case .unverified = phase { return pending != nil } else { return false } }

  /// The line under the field: a problem, a question, or the result.
  var message: String? {
    switch phase {
    case .failed(let m): return m
    case .unverified(let m): return "\(m) You can save it without checking, or try again."
    case .checking: return "Checking the key with Anthropic…"
    case .saved: return "Saved in your Mac's Keychain."
    case .idle, .entering: return nil
    }
  }

  mutating func beginReplace() {
    phase = .entering
    text = ""
    pending = nil
  }

  mutating func cancel() {
    phase = .idle
    text = ""
    pending = nil
  }

  mutating func edit(_ s: String) {
    guard phase != .checking else { return }
    text = s
    pending = nil
    phase = .entering
  }

  /// Starts a check: the trimmed key (the field is cleared), or nil when its shape is wrong (nothing is sent).
  mutating func begin() -> String? {
    guard phase != .checking else { return nil }
    if let p = ClaudeKeyFormat.problem(text) { phase = .failed(p); return nil }
    let key = ClaudeKeyFormat.trimmed(text)
    text = ""
    pending = nil
    phase = .checking
    return key
  }

  /// Applies Anthropic's answer: a valid key is saved; a rejected one is dropped; an unchecked one waits.
  mutating func apply(_ check: ClaudeKeyCheck, key: String, store: ClaudeKeyStore) {
    switch check {
    case .valid: save(key, store: store)
    case .rejected(let m): pending = nil; phase = .failed(m)
    case .unreachable(let m): pending = key; phase = .unverified(m)
    }
  }

  mutating func saveWithoutChecking(store: ClaudeKeyStore) {
    guard case .unverified = phase, let k = pending else { return }
    save(k, store: store)
  }

  mutating func remove(store: ClaudeKeyStore) {
    do {
      try store.remove()
      status = .missing
      phase = .idle
      text = ""
      pending = nil
    } catch {
      phase = .failed(Self.sentence(error, fallback: "The Keychain did not remove the key."))
    }
  }

  /// Re-reads the store (another window changed it).
  mutating func refresh(_ s: ClaudeKeyStatus) { status = s }

  /// begin, check, apply: on a copy, so no inout access is held across the network call.
  static func submit(_ flow: ClaudeKeyFlow, validator: ClaudeKeyValidator, store: ClaudeKeyStore) async -> ClaudeKeyFlow {
    var f = flow
    guard let key = f.begin() else { return f }
    let c = await validator.check(key)
    f.apply(c, key: key, store: store)
    return f
  }

  private mutating func save(_ key: String, store: ClaudeKeyStore) {
    do {
      try store.save(key, last4: ClaudeKeyFormat.last4(key))
      status = .set(last4: ClaudeKeyFormat.last4(key))
      phase = .saved
    } catch {
      phase = .failed(Self.sentence(error, fallback: "The Keychain did not save the key. Nothing was changed."))
    }
    pending = nil
    text = ""
  }

  private static func sentence(_ e: Error, fallback: String) -> String {
    switch e as? SecretStoreError {
    case .failed(let m)?, .invalid(let m)?: return m
    case nil: return fallback
    }
  }
}

/// The first-run window's key screen, shown before the four steps when no key is stored.
enum ClaudeKeyStep {
  static let title = "Your Claude API key"
  static let intro = "Offload uses your own Claude account to read and draft. Get an API key at console.anthropic.com (API keys, Create key), then paste it here."
  static let helper = "Kept in your Mac's Keychain. Only Anthropic ever sees it. You can replace or remove it later in Settings."
  static let saveTitle = "Save key"
  static let skipTitle = "Skip for now"
  static let saveAnywayTitle = "Save without checking"
  static let placeholder = "sk-ant-…"

  static func shows(status: ClaudeKeyStatus) -> Bool { !status.isSet }
}

extension BrainLaunch {
  /// s29: with a stored key the brain gets the Keychain item's NAME (it reads the value itself) and loses any inherited
  /// ANTHROPIC_API_KEY (s24: a brain started with a key in its environment refuses to build). With no stored key the
  /// environment is left as it is (local features run; a developer's own setup keeps working).
  static func claudeKeyEnvironment(_ base: [String: String], status: ClaudeKeyStatus) -> [String: String] {
    guard status.isSet else { return base }
    var env = base
    env.removeValue(forKey: "ANTHROPIC_API_KEY")
    env[ClaudeKeyItem.environmentName] = ClaudeKeyItem.reference
    return env
  }
}
