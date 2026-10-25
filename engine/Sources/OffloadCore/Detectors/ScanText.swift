// The text layer under FinanceDetector: characters, digit groups, numbers and keyword phrases.
// Terms (digit group, separator, number, word boundary, keyword before/after) follow slices/s02-detectors/SPEC.md.

/// A half-open span of character offsets into the scanned text.
struct ScanSpan: Hashable, Sendable {
    let start: Int
    let end: Int

    var length: Int { end - start }

    /// Characters between the two spans; 0 when they touch or overlap.
    func gap(to other: ScanSpan) -> Int {
        if other.start >= end { return other.start - end }
        if start >= other.end { return start - other.end }
        return 0
    }

    func contains(_ other: ScanSpan) -> Bool { other.start >= start && other.end <= end }
}

/// The scanned text as characters, with the character tests the rules use.
struct ScanText {
    let chars: [Character]
    /// `chars` lower-cased one for one, for case-insensitive keyword and codename matching.
    let folded: [Character]
    private let indices: [String.Index]

    init(_ text: String) {
        chars = Array(text)
        folded = chars.map(ScanText.fold)
        var indices = Array(text.indices)
        indices.append(text.endIndex)
        self.indices = indices
    }

    var count: Int { chars.count }

    /// The span as a range of the original string.
    func range(_ span: ScanSpan) -> Range<String.Index> { indices[span.start]..<indices[span.end] }

    /// The character at `i`, or nil outside the text.
    subscript(i: Int) -> Character? { i >= 0 && i < chars.count ? chars[i] : nil }

    func isDigit(_ i: Int) -> Bool { self[i].map(ScanText.isDigit) ?? false }
    func isWord(_ i: Int) -> Bool { self[i].map(ScanText.isWord) ?? false }

    /// True when the characters just outside `span` are not letters, digits or `_` (or the text ends there).
    func onBoundaries(_ span: ScanSpan) -> Bool { !isWord(span.start - 1) && !isWord(span.end) }

    /// True when the text at `i` is exactly `literal` (case-sensitive).
    func has(_ literal: [Character], at i: Int) -> Bool {
        guard i >= 0, i + literal.count <= chars.count else { return false }
        for k in 0..<literal.count where chars[i + k] != literal[k] { return false }
        return true
    }

    /// The ASCII digit values in `span`.
    func digits(_ span: ScanSpan) -> [Int] {
        chars[span.start..<span.end].compactMap { ScanText.isDigit($0) ? Int($0.asciiValue! - 48) : nil }
    }

    static func isDigit(_ c: Character) -> Bool { c.asciiValue.map { $0 >= 48 && $0 <= 57 } ?? false }
    static func isUpper(_ c: Character) -> Bool { c.asciiValue.map { $0 >= 65 && $0 <= 90 } ?? false }
    static func isUpperAlnum(_ c: Character) -> Bool { isDigit(c) || isUpper(c) }
    static func isWord(_ c: Character) -> Bool { c.isLetter || c.isNumber || c == "_" }
    /// Characters allowed in a key or token body: `[A-Za-z0-9_-]`.
    static func isKeyBody(_ c: Character) -> Bool {
        guard let a = c.asciiValue else { return false }
        return (48...57).contains(a) || (65...90).contains(a) || (97...122).contains(a) || a == 95 || a == 45
    }
    static func isCurrency(_ c: Character) -> Bool { c == "$" || c == "€" || c == "£" || c == "¥" }

    static func fold(_ c: Character) -> Character {
        if let a = c.asciiValue {
            return (65...90).contains(a) ? Character(Unicode.Scalar(a + 32)) : c
        }
        let lower = c.lowercased()
        return lower.count == 1 ? lower.first! : c
    }
}

/// Digit groups joined by separators (1 to 3 of: space, no-break space, `-`, en dash).
struct DigitNumber {
    /// Indexes into `ScanDigits.groups`.
    let groups: Range<Int>
    let span: ScanSpan
    let digitCount: Int
    var isMoney = false
    var isPhone = false
    var isDate = false
    var isIdentifier = false
}

/// The digit groups of a text and the numbers they form.
struct ScanDigits {
    /// Every maximal run of ASCII digits, in order.
    let groups: [ScanSpan]
    /// Numbers that sit on word boundaries, in order.
    let numbers: [DigitNumber]

    init(_ text: ScanText) {
        var groups: [ScanSpan] = []
        var i = 0
        while i < text.count {
            guard ScanText.isDigit(text.chars[i]) else { i += 1; continue }
            var j = i + 1
            while j < text.count && ScanText.isDigit(text.chars[j]) { j += 1 }
            groups.append(ScanSpan(start: i, end: j))
            i = j
        }

        var numbers: [DigitNumber] = []
        var first = 0
        for g in groups.indices {
            if g + 1 < groups.count && ScanDigits.joins(text, groups[g].end, groups[g + 1].start) { continue }
            let span = ScanSpan(start: groups[first].start, end: groups[g].end)
            if text.onBoundaries(span) {
                let digitCount = groups[first...g].reduce(0) { $0 + $1.length }
                numbers.append(DigitNumber(groups: first..<(g + 1), span: span, digitCount: digitCount))
            }
            first = g + 1
        }
        self.groups = groups
        self.numbers = numbers
    }

    /// True when the gap between two groups is a separator.
    private static func joins(_ text: ScanText, _ from: Int, _ to: Int) -> Bool {
        guard (1...3).contains(to - from) else { return false }
        for i in from..<to where !isSeparator(text.chars[i]) { return false }
        return true
    }

    static func isSeparator(_ c: Character) -> Bool { c == " " || c == "\u{00A0}" || c == "-" || c == "\u{2013}" }
}

/// A literal phrase matched case-insensitively on word boundaries. Whitespace inside the phrase matches one or more
/// whitespace characters. Used for keywords (codenames have their own edges, CodenamePhrase); never a pattern.
struct ScanPhrase: Sendable {
    private let words: [[Character]]

    init?(_ phrase: String) {
        let words = phrase.split(whereSeparator: \.isWhitespace).map { $0.map(ScanText.fold) }
        guard !words.isEmpty else { return nil }
        self.words = words
    }

    static func list(_ phrases: String...) -> [ScanPhrase] { phrases.compactMap(ScanPhrase.init) }

    /// Every match in `text`. An edge that is a letter, digit or `_` must sit on a word boundary.
    func spans(in text: ScanText) -> [ScanSpan] {
        let head = words[0][0]
        let startIsWord = ScanText.isWord(head)
        let endIsWord = ScanText.isWord(words[words.count - 1].last!)
        var spans: [ScanSpan] = []
        for i in 0..<text.count where text.folded[i] == head {
            guard let end = matchEnd(at: i, in: text) else { continue }
            if startIsWord && text.isWord(i - 1) { continue }
            if endIsWord && text.isWord(end) { continue }
            spans.append(ScanSpan(start: i, end: end))
        }
        return spans
    }

    private func matchEnd(at start: Int, in text: ScanText) -> Int? {
        var p = start
        for (k, word) in words.enumerated() {
            if k > 0 {
                let before = p
                while p < text.count && text.chars[p].isWhitespace { p += 1 }
                if p == before { return nil }
            }
            guard p + word.count <= text.count else { return nil }
            for (m, c) in word.enumerated() where text.folded[p + m] != c { return nil }
            p += word.count
        }
        return p
    }
}

/// Keyword matches, sorted for the "keyword before (N)" and "keyword after (N)" tests.
struct KeywordHits {
    /// Matches sorted by start.
    let spans: [ScanSpan]
    private let starts: [Int]
    private let ends: [Int]

    init(_ phrases: [ScanPhrase], in text: ScanText) {
        spans = phrases.flatMap { $0.spans(in: text) }.sorted { $0.start < $1.start }
        starts = spans.map(\.start)
        ends = spans.map(\.end).sorted()
    }

    /// A keyword ends at most `n` characters before `start`.
    func before(_ start: Int, within n: Int) -> Bool {
        let k = sortedLowerBound(ends, start - n)
        return k < ends.count && ends[k] <= start
    }

    /// A keyword starts at most `n` characters after `end`.
    func after(_ end: Int, within n: Int) -> Bool {
        let k = sortedLowerBound(starts, end)
        return k < starts.count && starts[k] <= end + n
    }
}

/// Index of the first element of the sorted array `a` that is >= `x`.
func sortedLowerBound(_ a: [Int], _ x: Int) -> Int {
    var lo = 0
    var hi = a.count
    while lo < hi {
        let mid = (lo + hi) / 2
        if a[mid] < x { lo = mid + 1 } else { hi = mid }
    }
    return lo
}
