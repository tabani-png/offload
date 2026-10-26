import Combine
import Foundation
import Security

/// s29: the Claude API key in the login Keychain: one generic password, service `offload.anthropic`, account
/// `api-key` (ClaudeKeyItem). Written with the Security framework only (the `security` CLI would put the key in argv).
/// The item's access list trusts Offload and /usr/bin/security, so the brain's read
/// (`security find-generic-password -s offload.anthropic -a api-key -w`) does not raise a Keychain prompt.
/// The last four characters sit in the item's comment attribute, so Settings can show them without reading the secret.
/// Nothing here logs, returns or caches the value.
struct ClaudeKeychain: ClaudeKeyStore {
  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: ClaudeKeyItem.service,
     kSecAttrAccount as String: ClaudeKeyItem.account]
  }

  func save(_ key: String, last4: String) throws {
    let v = ClaudeKeyFormat.trimmed(key)
    if let p = ClaudeKeyFormat.problem(v) { throw SecretStoreError.invalid(p) }
    // Replace = delete, then add: the new item gets a fresh access list.
    let gone = SecItemDelete(query as CFDictionary)
    guard gone == errSecSuccess || gone == errSecItemNotFound else {
      throw SecretStoreError.failed("The Keychain did not let Offload replace the old key (code \(gone)). Nothing was changed.")
    }
    var add = query
    add[kSecValueData as String] = Data(v.utf8)
    add[kSecAttrLabel as String] = "Offload: Claude API key"
    add[kSecAttrComment as String] = last4
    if let access = Self.access() { add[kSecAttrAccess as String] = access }
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw SecretStoreError.failed("The Keychain did not save the key (code \(status)). Nothing was sent.")
    }
  }

  func remove() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw SecretStoreError.failed("The Keychain did not remove the key (code \(status)).")
    }
  }

  /// Attributes only. An item added outside Offload (LAUNCH.md's `security add-generic-password`) has no comment:
  /// it still counts as set.
  func status() -> ClaudeKeyStatus {
    var q = query
    q[kSecReturnAttributes as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess else { return .missing }
    let attrs = out as? [String: Any]
    let tail = (attrs?[kSecAttrComment as String] as? String).flatMap { $0.count == 4 ? $0 : nil } ?? "····"
    return .set(last4: tail)
  }

  /// Offload itself and /usr/bin/security (the brain's reader). nil = the system default (Offload only; the brain's
  /// first read then asks once).
  private static func access() -> SecAccess? {
    var me: SecTrustedApplication?
    var reader: SecTrustedApplication?
    guard SecTrustedApplicationCreateFromPath(nil, &me) == errSecSuccess,
          SecTrustedApplicationCreateFromPath("/usr/bin/security", &reader) == errSecSuccess,
          let me, let reader else { return nil }
    var access: SecAccess?
    guard SecAccessCreate("Offload: Claude API key" as CFString, [me, reader] as CFArray, &access) == errSecSuccess else { return nil }
    return access
  }
}

/// Snapshots and `--mock`: never touches the real Keychain.
final class MemoryClaudeKeyStore: ClaudeKeyStore, @unchecked Sendable {
  private let lock = NSLock()
  private var tail: String?
  init(last4: String? = nil) { tail = last4 }
  func save(_ key: String, last4: String) throws { lock.withLock { tail = last4 } }
  func remove() throws { lock.withLock { tail = nil } }
  func status() -> ClaudeKeyStatus { lock.withLock { tail.map { .set(last4: $0) } ?? .missing } }
}

/// Main-actor wrapper around ClaudeKeyFlow, shared by the first-run window and the dashboard's Settings.
/// `onChange` fires after a key is saved or removed (the app delegate restarts the brain and updates the notice).
@MainActor
final class ClaudeKeyModel: ObservableObject {
  @Published private(set) var flow: ClaudeKeyFlow
  private let store: ClaudeKeyStore
  private let validator: ClaudeKeyValidator
  var onChange: ((ClaudeKeyStatus) -> Void)?

  init(store: ClaudeKeyStore, validator: ClaudeKeyValidator = AnthropicKeyValidator()) {
    self.store = store
    self.validator = validator
    flow = ClaudeKeyFlow(status: store.status())
  }

  var status: ClaudeKeyStatus { flow.status }

  func beginReplace() { flow.beginReplace() }
  func cancel() { flow.cancel() }
  func edit(_ s: String) { flow.edit(s) }

  /// Checks the typed key with Anthropic and saves it when it works.
  func submit() async {
    guard let key = flow.begin() else { return }
    let before = flow.status
    let answer = await validator.check(key)
    flow.apply(answer, key: key, store: store)
    if flow.status != before || flow.phase == .saved { onChange?(flow.status) }
  }

  func saveWithoutChecking() {
    flow.saveWithoutChecking(store: store)
    if flow.phase == .saved { onChange?(flow.status) }
  }

  func remove() {
    let before = flow.status
    flow.remove(store: store)
    if flow.status != before { onChange?(flow.status) }
  }

  func refresh() { flow.refresh(store.status()) }

  /// Snapshots: show a given state without a store round trip.
  func preview(_ f: ClaudeKeyFlow) { flow = f }
}
