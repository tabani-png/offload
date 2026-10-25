import CoreGraphics
import Foundation
import ImageIO
@testable import OffloadCore

/// A white image with optional dark blocks (top-left pixel coordinates), so different seeds give different dHashes.
func s11Image(width: Int = 800, height: Int = 400, blocks: [CGRect] = []) -> CGImage {
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.setFillColor(CGColor(red: 0.2, green: 0.3, blue: 0.8, alpha: 1))
    for b in blocks { ctx.fill(CGRect(x: b.minX, y: CGFloat(height) - b.maxY, width: b.width, height: b.height)) }
    return ctx.makeImage()!
}

/// A distinct pattern per seed (stripes at seed-dependent places).
func s11Pattern(_ seed: Int, width: Int = 800, height: Int = 400) -> CGImage {
    var blocks: [CGRect] = []
    var x = UInt64(seed &* 2_654_435_761 &+ 12345)
    for _ in 0..<14 {
        x = x &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        let bx = CGFloat(x % UInt64(width - 120))
        let by = CGFloat((x >> 20) % UInt64(height - 60))
        blocks.append(CGRect(x: bx, y: by, width: 40 + CGFloat((x >> 40) % 80), height: 20 + CGFloat((x >> 50) % 40)))
    }
    return s11Image(width: width, height: height, blocks: blocks)
}

func s11Line(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat = 20) -> OCRLine {
    let words = text.split(separator: " ").map(String.init)
    let w = width / CGFloat(max(1, words.count))
    return OCRLine(words: words.enumerated().map { i, t in
        OCRWord(text: t, box: CGRect(x: x + CGFloat(i) * w, y: y, width: w, height: height))
    })
}

/// Decodes a JPEG and returns a pixel reader (top-left origin) giving mean RGB 0...255.
struct DecodedImage {
    let width: Int
    let height: Int
    private let bytes: [UInt8]

    init(jpeg: Data) {
        let src = CGImageSourceCreateWithData(jpeg as CFData, nil)!
        let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
        width = img.width
        height = img.height
        var buf = [UInt8](repeating: 0, count: width * height * 4)
        buf.withUnsafeMutableBytes { p in
            let ctx = CGContext(data: p.baseAddress, width: img.width, height: img.height, bitsPerComponent: 8,
                                bytesPerRow: img.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: img.width, height: img.height))
        }
        bytes = buf
    }

    /// Mean of R, G, B at (x, y) with y measured from the top.
    func brightness(_ x: Int, _ y: Int) -> Int {
        let i = (y * width + x) * 4
        return (Int(bytes[i]) + Int(bytes[i + 1]) + Int(bytes[i + 2])) / 3
    }
}

final class FakeFrameSource: ScreenFrameSource {
    var frame: ScreenFrame?
    var textCalls = 0
    var frameCalls = 0

    init(_ frame: ScreenFrame?) { self.frame = frame }

    func visibleText(of snapshot: FocusSnapshot) throws -> String? {
        textCalls += 1
        return frame?.text
    }

    func captureFrame(of snapshot: FocusSnapshot) throws -> ScreenFrame? {
        frameCalls += 1
        return frame
    }
}

final class MemoryFrameSink: FrameSink {
    var stored: [(jpeg: Data, meta: FrameMeta)] = []
    func storeFrame(_ jpeg: Data, meta: FrameMeta) throws { stored.append((jpeg, meta)) }
}

/// An observer with a frame-capable source and a memory frame sink. Clock starts 2026-10-20 10:00:00 UTC.
struct FrameRig {
    let clock = ManualClock(Date(timeIntervalSince1970: 1_792_490_400))
    let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.google.Chrome", appName: "Google Chrome",
                                                windowTitle: "Bills", url: "https://app.ledgerly.test/bills/new?x=1"))
    let idle = FakeIdle()
    let input = FakeInput()
    let pause = FakePause()
    let sink = MemorySink()
    let frames = MemoryFrameSink()
    let source: FakeFrameSource
    let observer: Observer

    init(frame: ScreenFrame? = ScreenFrame(image: s11Pattern(1), lines: [s11Line("New bill INV-20431", x: 10, y: 10, width: 300)]),
         framesOn: Bool = true, keyframes: KeyframeConfig = KeyframeConfig()) {
        source = FakeFrameSource(frame)
        observer = Observer(clock: clock, workspace: workspace, idle: idle, input: input, screenText: source,
                            pauseState: pause, sink: sink, retention: nil, frames: framesOn ? frames : nil,
                            keyframes: keyframes)
    }

    func run(seconds: Int) {
        for _ in 0..<seconds {
            clock.advance(by: 1)
            observer.tick()
        }
    }

    func startAndTick() {
        observer.start()
        observer.tick()
    }
}

/// A UTC calendar so day names in these tests do not depend on the machine's zone.
let s11UTC = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
