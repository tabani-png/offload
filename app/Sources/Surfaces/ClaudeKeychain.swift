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
    // Replace = update in place (review round 1): a refused update leaves the working key exactly as it was. The
    // item keeps the access list it was created with. Only a missing item is added, with the access list below.
    let change: [String: Any] = [
      kSecValueData as String: Data(v.utf8),
      kSecAttrComment as String: last4,
      kSecAttrLabel as String: "Offload: Claude API key",
    ]
    var status = SecItemUpdate(query as CFDictionary, change as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      for (k, value) in change { add[k] = value }
      if let access = Self.access() { add[kSecAttrAccess as String] = access }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw SecretStoreError.failed("The Keychain did not save the key (code \(status)). Your old key is unchanged.")
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

/// Main-actor SwiftUI wrapper around ClaudeKeyController (Core), shared by the first-run window and Settings.
/// `onChange` fires after a key is really saved or removed (the app delegate restarts the brain and updates the
/// notice); a cancelled or stale check never fires it.
@MainActor
final class ClaudeKeyModel: ObservableObject {
  @Published private(set) var flow: ClaudeKeyFlow
  private let controller: ClaudeKeyController

  var onChange: ((ClaudeKeyStatus) -> Void)? {
    get { controller.onChange }
    set { controller.onChange = newValue }
  }

  init(store: ClaudeKeyStore, validator: ClaudeKeyValidator = AnthropicKeyValidator()) {
    controller = ClaudeKeyController(store: store, validator: validator)
    flow = controller.flow
    controller.onFlow = { [weak self] f in self?.flow = f }
  }

  var status: ClaudeKeyStatus { flow.status }

  func beginReplace() { controller.beginReplace() }
  func cancel() { controller.cancel() }
  func edit(_ s: String) { controller.edit(s) }
  /// Checks the typed key with Anthropic and saves it when it works (cancel-safe).
  func submit() { controller.submit() }
  func saveWithoutChecking() { controller.saveWithoutChecking() }
  func remove() { controller.remove() }
  func refresh() { controller.refresh() }
  /// Snapshots: show a given state without a store round trip.
  func preview(_ f: ClaudeKeyFlow) { controller.preview(f) }
}
