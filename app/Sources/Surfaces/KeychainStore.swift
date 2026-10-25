import Foundation
import Security

/// s17: the macOS Keychain behind the Connections center's secure field. A connection's API key is written straight
/// into a generic password item (service `offload.connection.<id>`, account `api-key`), readable on this Mac only while
/// it is unlocked. Nothing here logs, returns or caches the value; `contains` asks for attributes, never the data.
/// The brain is only ever told the item's name; it reads the value for one request (`security ... -w`, s13).
struct KeychainStore: SecretStore {
  static let servicePrefix = "offload.connection."

  func save(_ secret: String, service: String, account: String) throws {
    guard service.hasPrefix(Self.servicePrefix), !account.isEmpty, let data = secret.data(using: .utf8) else {
      throw SecretStoreError.invalid("That is not one of Offload's Keychain items.")
    }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let attrs: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAttrLabel as String: "Offload connection (\(service.dropFirst(Self.servicePrefix.count)))",
    ]
    var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      for (k, v) in attrs { add[k] = v }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw SecretStoreError.failed("The Keychain did not save it (code \(status)). Nothing was sent.") }
  }

  func contains(service: String, account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess
  }
}

/// Snapshots and `--mock`: never touches the real Keychain.
struct MemorySecretStore: SecretStore {
  func save(_ secret: String, service: String, account: String) throws {}
  func contains(service: String, account: String) -> Bool { false }
}
