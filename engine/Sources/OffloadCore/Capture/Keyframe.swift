// Keyframes (s11, ADR 0007): a masked, downscaled JPEG of the focused window, kept on the OCR-on-change trigger.
// Privacy order: exclusions and Secure Event Input are checked before pixels are asked for (Observer); this file
// blacks out every OCR line the Masker flags and every secure text field, then downscales and encodes in memory.
// Rules: slices/s11-perception/SPEC.md K1-K3.
import CoreGraphics
import Foundation
import ImageIO

/// One capture of the focused window: pixels, the OCR lines read from them (word boxes in pixels, top-left origin)
/// and the secure text field rectangles (pixels, top-left origin). Lives in memory only.
public struct ScreenFrame: @unchecked Sendable {
    public var image: CGImage
    public var lines: [OCRLine]
    public var secureFields: [CGRect]

    public init(image: CGImage, lines: [OCRLine], secureFields: [CGRect] = []) {
        self.image = image
        self.lines = lines
        self.secureFields = secureFields
    }

    /// The OCR text, lines joined by newlines (what `visibleText` returns).
    public var text: String { lines.map(\.text).joined(separator: "\n") }
}

/// A ScreenTextSource that can also hand back the pixels it read. Called only for windows the policy allows.
public protocol ScreenFrameSource: ScreenTextSource {
    /// Nil = nothing to read.
    func captureFrame(of snapshot: FocusSnapshot) throws -> ScreenFrame?
}

public struct KeyframeConfig: Equatable, Sendable {
    /// Long edge of the kept JPEG, pixels.
    public var maxLongEdge: Int = 1280
    /// At least this long between two kept frames, seconds.
    public var minInterval: TimeInterval = 20
    /// At most this many kept frames in any rolling hour.
    public var maxPerHour: Int = 60
    /// A frame within this many dHash bits (of 1024) of a recent kept frame is a duplicate.
    public var dedupeDistance: Int = 40
    /// How many recent kept frames the duplicate check looks at.
    public var dedupeMemory: Int = 16
    /// JPEG quality 0...1.
    public var jpegQuality: Double = 0.6
    /// Padding around a blacked-out OCR line, source pixels.
    public var maskPadding: CGFloat = 4

    public init() {}
}

/// Throttle and dedupe for kept frames (K3). Owned by the observer's tick thread.
public final class KeyframeThrottle {
    public enum Decision: Equatable, Sendable {
        case keep
        case throttled
        case duplicate
    }

    public let config: KeyframeConfig
    private var kept: [Date] = []
    private var recent: [PerceptualHash] = []

    public init(config: KeyframeConfig = KeyframeConfig()) {
        self.config = config
    }

    private func prune(_ now: Date) {
        kept.removeAll { now.timeIntervalSince($0) >= 3600 }
    }

    /// True when the interval and the hourly cap would allow a frame now (cheap; asked before pixels are kept).
    public func mightKeep(now: Date) -> Bool {
        prune(now)
        if let last = kept.last, now.timeIntervalSince(last) < config.minInterval { return false }
        return kept.count < config.maxPerHour
    }

    public func decide(now: Date, hash: PerceptualHash) -> Decision {
        guard mightKeep(now: now) else { return .throttled }
        if recent.contains(where: { $0.distance(to: hash) < config.dedupeDistance }) { return .duplicate }
        return .keep
    }

    public func record(now: Date, hash: PerceptualHash) {
        kept.append(now)
        recent.append(hash)
        if recent.count > config.dedupeMemory { recent.removeFirst(recent.count - config.dedupeMemory) }
    }

    /// Forgets the duplicate memory (pause/resume): a new session starts fresh. The rate limits stay.
    public func resetDuplicates() { recent.removeAll() }
}

public enum KeyframeError: Error, Equatable {
    case render
    case encode
}

/// The result of masking one frame: the JPEG and what was done to it.
public struct MaskedKeyframe: Sendable {
    public var jpeg: Data
    public var width: Int
    public var height: Int
    /// Regions filled black (masked OCR lines + secure fields).
    public var maskedRegions: Int
    /// 64-bit dHash of the masked, downscaled image, 16 hex chars.
    public var phash64: String
}

public enum KeyframeRenderer {
    /// Indexes of the OCR lines that hold a value the Masker flags: each line on its own, and any line touched by a
    /// detection in the joined text (values split across lines).
    public static func sensitiveLines(_ lines: [OCRLine], masker: Masker) -> Set<Int> {
        var out = Set<Int>()
        var spans: [(Int, Int)] = []
        var joined = ""
        for (i, line) in lines.enumerated() {
            if masker.mask(line.text).total > 0 { out.insert(i) }
            if i > 0 { joined += "\n" }
            let start = joined.utf16.count
            joined += line.text
            spans.append((start, joined.utf16.count))
        }
        for d in masker.mask(joined).detections {
            let lo = d.range.lowerBound.utf16Offset(in: joined)
            let hi = d.range.upperBound.utf16Offset(in: joined)
            for (i, s) in spans.enumerated() where s.0 < hi && lo < s.1 { out.insert(i) }
        }
        return out
    }

    /// The rectangles to black out, in source pixels, top-left origin.
    public static func maskRects(_ frame: ScreenFrame, masker: Masker, padding: CGFloat) -> [CGRect] {
        let bounds = CGRect(x: 0, y: 0, width: frame.image.width, height: frame.image.height)
        var rects: [CGRect] = []
        for i in sensitiveLines(frame.lines, masker: masker).sorted() {
            let box = frame.lines[i].box
            guard !box.isNull else { continue }
            rects.append(box.insetBy(dx: -padding, dy: -padding).intersection(bounds))
        }
        for r in frame.secureFields where !r.isNull && !r.isEmpty {
            rects.append(r.insetBy(dx: -2, dy: -2).intersection(bounds))
        }
        return rects.filter { !$0.isNull && !$0.isEmpty }
    }

    /// Blacks out, downscales (long edge <= config.maxLongEdge) and JPEG-encodes in memory. No metadata is written.
    public static func render(_ frame: ScreenFrame, masker: Masker, config: KeyframeConfig) throws -> MaskedKeyframe {
        let rects = maskRects(frame, masker: masker, padding: config.maskPadding)
        let image = try drawMasked(frame.image, rects: rects, maxLongEdge: config.maxLongEdge)
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            throw KeyframeError.encode
        }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: config.jpegQuality]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw KeyframeError.encode }
        return MaskedKeyframe(jpeg: data as Data, width: image.width, height: image.height, maskedRegions: rects.count,
                              phash64: dHash64Hex(image))
    }

    /// Draws `source` scaled to fit `maxLongEdge`, then fills `rects` (source pixels, top-left origin) black.
    public static func drawMasked(_ source: CGImage, rects: [CGRect], maxLongEdge: Int) throws -> CGImage {
        let w = CGFloat(source.width)
        let h = CGFloat(source.height)
        let scale = min(1, CGFloat(maxLongEdge) / max(w, h))
        let outW = max(1, Int((w * scale).rounded()))
        let outH = max(1, Int((h * scale).rounded()))
        guard let ctx = CGContext(data: nil, width: outW, height: outH, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw KeyframeError.render }
        ctx.interpolationQuality = .high
        ctx.draw(source, in: CGRect(x: 0, y: 0, width: outW, height: outH))
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        let sx = CGFloat(outW) / w
        let sy = CGFloat(outH) / h
        for r in rects {
            // Top-left source pixels -> bottom-left output pixels, widened to whole pixels so nothing peeks out.
            let x0 = floor(r.minX * sx)
            let x1 = ceil(r.maxX * sx)
            let yTop = floor(r.minY * sy)
            let yBottom = ceil(r.maxY * sy)
            ctx.fill(CGRect(x: x0, y: CGFloat(outH) - yBottom, width: x1 - x0, height: yBottom - yTop))
        }
        guard let out = ctx.makeImage() else { throw KeyframeError.render }
        return out
    }

    /// 64-bit difference hash (9 x 8 gray, bit set when a pixel is brighter than its right neighbour), hex.
    public static func dHash64Hex(_ image: CGImage) -> String {
        var gray = [UInt8](repeating: 0, count: 9 * 8)
        gray.withUnsafeMutableBytes { buf in
            guard let ctx = CGContext(data: buf.baseAddress, width: 9, height: 8, bitsPerComponent: 8, bytesPerRow: 9,
                                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
            else { return }
            ctx.interpolationQuality = .high
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: 9, height: 8))
        }
        var bits: UInt64 = 0
        for r in 0..<8 {
            for c in 0..<8 where gray[r * 9 + c] > gray[r * 9 + c + 1] { bits |= UInt64(1) << UInt64(r * 8 + c) }
        }
        return String(format: "%016llx", bits)
    }
}
