/// The result of masking one text.
public struct MaskResult: Equatable, Sendable {
    /// The input with every detected value replaced by its label token.
    public let text: String
    /// The detections, with ranges that index the ORIGINAL input text (not `text`).
    public let detections: [Detection]
    /// Number of detections per category. Categories with no detection have no entry.
    public let counts: [MaskCategory: Int]

    public init(text: String, detections: [Detection], counts: [MaskCategory: Int]) {
        self.text = text
        self.detections = detections
        self.counts = counts
    }

    /// Total number of masked values.
    public var total: Int { counts.values.reduce(0, +) }
}

/// Replaces sensitive values with label tokens like `[ACCT NO.]`. The raw value never survives in the output.
public struct Masker: Sendable {
    public let detector: SensitiveDetector

    public init(detector: SensitiveDetector = SensitiveDetector()) {
        self.detector = detector
    }

    public func mask(_ text: String) -> MaskResult {
        let detections = detector.scan(text)
        var masked = ""
        masked.reserveCapacity(text.utf8.count)
        var counts: [MaskCategory: Int] = [:]
        var cursor = text.startIndex
        // Detections are sorted and disjoint, so one walk rebuilds the text with every value swapped for its label.
        for detection in detections {
            masked += text[cursor..<detection.range.lowerBound]
            masked += detection.label
            cursor = detection.range.upperBound
            counts[detection.category, default: 0] += 1
        }
        masked += text[cursor...]
        return MaskResult(text: masked, detections: detections, counts: counts)
    }
}
