import Foundation
import Security

/// ULID (Crockford base32, 48-bit ms time + 80-bit randomness). Monotonic within one generator: ids made in the same
/// millisecond increase, so `id` sorts the way the events were written.
public final class ULIDGenerator {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    private let random: () -> [UInt8]
    private var lastMillis: Int64 = -1
    private var lastRandom: [UInt8] = []

    /// `random` must return 10 bytes. Default: SecRandomCopyBytes.
    public init(random: (() -> [UInt8])? = nil) {
        self.random = random ?? ULIDGenerator.secureRandom
    }

    public func next(millis: Int64) -> String {
        var bytes: [UInt8]
        if millis == lastMillis, !lastRandom.isEmpty {
            bytes = lastRandom
            Self.increment(&bytes)
        } else {
            bytes = random()
            if bytes.count != 10 { bytes = Array((bytes + [UInt8](repeating: 0, count: 10)).prefix(10)) }
        }
        lastMillis = millis
        lastRandom = bytes
        return Self.encode(millis: millis, random: bytes)
    }

    static func encode(millis: Int64, random: [UInt8]) -> String {
        var out = [Character]()
        out.reserveCapacity(26)
        let t = UInt64(max(0, millis)) & 0xFFFF_FFFF_FFFF
        for i in stride(from: 9, through: 0, by: -1) {
            out.append(alphabet[Int((t >> UInt64(i * 5)) & 0x1F)])
        }
        // 80 random bits as 16 base32 characters.
        var acc: UInt32 = 0
        var bits = 0
        for byte in random {
            acc = (acc << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[Int((acc >> UInt32(bits)) & 0x1F)])
            }
        }
        return String(out)
    }

    private static func increment(_ bytes: inout [UInt8]) {
        for i in stride(from: bytes.count - 1, through: 0, by: -1) {
            if bytes[i] == 0xFF { bytes[i] = 0 } else { bytes[i] += 1; return }
        }
    }

    private static func secureRandom() -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 10)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            Log.error("ulid", "SecRandomCopyBytes failed with status \(status); using SystemRandomNumberGenerator")
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return bytes
    }
}
