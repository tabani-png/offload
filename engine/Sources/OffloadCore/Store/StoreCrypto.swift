// Copied from Workpaper engine WPCore/Store/StoreCrypto.swift. Sealed format: AES.GCM.SealedBox.combined =
// nonce(12) | ciphertext | tag(16).
import CryptoKit
import Foundation

public enum StoreError: Error, Equatable {
    case invalidDay(String)
    /// The day key is missing (purged) or unreadable. Payload: the day.
    case keyMissing(String)
    /// The key file is not 32 bytes. Payload: the day.
    case badKey(String)
    /// Authentication failed, or the input is shorter than nonce + tag. Payload: 1-based line number.
    case decryptFailed(Int)
    /// A line is not base64. Payload: 1-based line number.
    case badLine(Int)
    case notFound(String)
    case io(String)
}

public enum StoreCrypto {
    public static let nonceSize = 12
    public static let tagSize = 16
    public static let keySize = 32

    /// Seals with AES-256-GCM and returns `SealedBox.combined`. `nonce` nil = random (always, outside tests).
    public static func seal(_ plaintext: Data, key: SymmetricKey, nonce: Data? = nil) throws -> Data {
        if let nonce, nonce.count != nonceSize { throw CryptoKitError.incorrectParameterSize }
        let box = try AES.GCM.seal(plaintext, using: key, nonce: nonce.map { try AES.GCM.Nonce(data: $0) })
        guard let combined = box.combined else { throw CryptoKitError.incorrectParameterSize }
        return combined
    }

    /// Opens `SealedBox.combined` bytes. Returns nil on any failure (caller reports the line).
    public static func open(_ combined: Data, key: SymmetricKey) -> Data? {
        guard combined.count >= nonceSize + tagSize else { return nil }
        return try? AES.GCM.open(AES.GCM.SealedBox(combined: combined), using: key)
    }
}
