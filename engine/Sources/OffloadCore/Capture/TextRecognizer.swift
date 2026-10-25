// OCR in memory with word boxes (Apple Vision). Rules: slices/s04-capture/SPEC.md AC-16 and "Vision adapter".
import CoreGraphics
import Foundation
import Vision

/// One recognized word. `box` is in image pixel coordinates, origin top-left.
public struct OCRWord: Equatable, Sendable {
    public var text: String
    public var box: CGRect

    public init(text: String, box: CGRect) {
        self.text = text
        self.box = box
    }
}

/// One recognized text line (one Vision observation): its words, left to right.
public struct OCRLine: Equatable, Sendable {
    public var words: [OCRWord]

    public init(words: [OCRWord]) {
        self.words = words
    }

    /// The words joined by single spaces.
    public var text: String { words.map(\.text).joined(separator: " ") }

    /// Union of the word boxes (`.null` when there are no words).
    public var box: CGRect { words.reduce(CGRect.null) { $0.union($1.box) } }
}

/// Reads text from pixels. Implementations never write to disk and never log.
public protocol TextRecognizer {
    func recognize(_ image: CGImage) throws -> [OCRLine]
}

/// Apple Vision `VNRecognizeTextRequest`, accurate level, no language correction, word boxes from
/// `VNRecognizedText.boundingBox(for:)` converted to pixels with a top-left origin.
public struct VisionTextRecognizer: TextRecognizer {
    /// Every Vision call in the process goes through this one serial GCD queue. Vision blocks its calling thread
    /// while it waits on internal work; keeping the calls serial and on GCD avoids the thread-starvation hang seen
    /// on macOS 26. Callers still must not call `recognize` from inside a Swift `Task`.
    private static let queue = DispatchQueue(label: "ai.offload.observer.vision", qos: .userInitiated)

    public init() {}

    public func recognize(_ image: CGImage) throws -> [OCRLine] {
        try Self.queue.sync { try Self.run(image) }
    }

    private static func run(_ image: CGImage) throws -> [OCRLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        do {
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        } catch {
            let ns = error as NSError
            throw CaptureError.ocrFailed("\(ns.domain) \(ns.code)")  // the error code only, never any text
        }

        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        // Vision boxes are normalized with a bottom-left origin; OCRWord boxes are pixels with a top-left origin.
        func pixels(_ r: CGRect) -> CGRect {
            CGRect(x: r.minX * width, y: (1 - r.maxY) * height, width: r.width * width, height: r.height * height)
        }

        var lines: [OCRLine] = []
        for observation in request.results ?? [] {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let string = candidate.string
            let words = string.split(whereSeparator: \.isWhitespace).map { word -> OCRWord in
                let box = (try? candidate.boundingBox(for: word.startIndex..<word.endIndex))?.boundingBox
                return OCRWord(text: String(word), box: pixels(box ?? observation.boundingBox))
            }
            if !words.isEmpty { lines.append(OCRLine(words: words)) }
        }
        return lines
    }
}
