// Perceptual hash for dedupe (AC-11). Algorithm: slices/s04-capture/SPEC.md "Perceptual hash".
import CoreGraphics
import Foundation

/// 1024-bit difference hash (dHash) of a frame. Kept in memory only, never written.
public struct PerceptualHash: Hashable, Sendable {
    public static let bitCount = 1024

    /// 16 words of 64 bits, row-major bit order as in the SPEC.
    public let words: [UInt64]

    private static let columns = 33
    private static let rows = 32

    /// Downscales to 33 x 32 gray and sets bit `r * 32 + c` when a pixel is brighter than its right neighbour.
    public init(image: CGImage) {
        var gray = [UInt8](repeating: 0, count: Self.columns * Self.rows)
        gray.withUnsafeMutableBytes { buffer in
            guard let ctx = CGContext(data: buffer.baseAddress, width: Self.columns, height: Self.rows, bitsPerComponent: 8,
                                      bytesPerRow: Self.columns, space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return }
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: Self.columns, height: Self.rows))
        }
        var words = [UInt64](repeating: 0, count: Self.bitCount / 64)
        for r in 0..<Self.rows {
            for c in 0..<(Self.columns - 1) where gray[r * Self.columns + c] > gray[r * Self.columns + c + 1] {
                let bit = r * 32 + c
                words[bit / 64] |= UInt64(1) << UInt64(bit % 64)
            }
        }
        self.words = words
    }

    /// Number of differing bits (Hamming distance), 0...1024.
    public func distance(to other: PerceptualHash) -> Int {
        zip(words, other.words).reduce(0) { $0 + ($1.0 ^ $1.1).nonzeroBitCount }
    }
}
