import Foundation

// s10e (DESIGN-REVIEW-3 M2, M3): "Your voice" as measured facts, and the dry run's highlight diff.

/// ToneMeasuredDTO (brain ToneCardDTO.measured): numbers computed in code from your sent mail, plus one sentence
/// quoted from a real sent email.
struct ToneMeasured: Codable, Equatable, Sendable {
  struct FormCount: Codable, Equatable, Sendable {
    var form: String
    var count: Int
  }
  var emails: Int
  var medianWords: Double
  var p90Words: Double
  var medianSentences: Double
  var greeting: FormCount?
  var sign: FormCount?
  var askShare: Double
  var exclamationShare: Double
  var sample: String?
  var source: String
}

/// The fact sheet "Your voice" shows: four measured rows, each with its source, and one quoted line.
struct VoiceFacts: Equatable, Sendable {
  struct Row: Equatable, Sendable, Identifiable {
    var id: String { label }
    var label: String
    var value: String
    var source: String
  }

  var header: String
  var rows: [Row]
  var quote: String?

  init(_ m: ToneMeasured) {
    header = "Measured from \(m.source)"
    let n = m.emails
    let source = n == 1 ? "from 1 sent email" : "from \(n) sent emails"
    let words = Int(m.medianWords.rounded())
    let p90 = Int(m.p90Words.rounded())
    let sentences = Int(m.medianSentences.rounded())
    var r: [Row] = [
      Row(label: "Length", value: "About \(words) words, rarely over \(p90) · \(sentences) short sentences", source: source),
    ]
    if let g = m.greeting {
      r.append(Row(label: "Greeting", value: "“\(Self.form(g.form))” in \(g.count) of \(n)", source: source))
    } else {
      r.append(Row(label: "Greeting", value: "No greeting line", source: source))
    }
    if let s = m.sign {
      r.append(Row(label: "Sign-off", value: "“\(Self.form(s.form))” on its own line, \(s.count) of \(n)", source: source))
    } else {
      r.append(Row(label: "Sign-off", value: "No sign-off line", source: source))
    }
    let asks = Int((m.askShare * Double(n)).rounded())
    let bangs = Int((m.exclamationShare * Double(n)).rounded())
    r.append(Row(label: "Ask", value: "Ends on a question in \(asks) of \(n) · "
                 + (bangs == 0 ? "no exclamation marks" : "exclamation marks in \(bangs)"), source: source))
    rows = r
    quote = m.sample.map { "“\($0.trimmingCharacters(in: .whitespacesAndNewlines))”" }
  }

  /// "Hi {first}," reads "Hi ‹first name›,".
  static func form(_ f: String) -> String {
    f.replacingOccurrences(of: "{first}", with: "‹first name›")
  }

  var allStrings: [String] { [header, quote ?? ""] + rows.flatMap { [$0.label, $0.value, $0.source] } }
}

/// The dry run's highlight: a tint behind the changed claim words, never an underline (an underline reads as a link).
enum DiffTint {
  static let dark: Double = 0.12
  static let light: Double = 0.08
}

enum DiffSummary {
  /// Runs of changed words in our draft that carry a claim the sent email never used.
  static func changedPhrases(ours: String, theirs: String) -> Int {
    let d = DiffLite.diff(ours: ours, theirs: theirs)
    let other = DiffEmphasis.words(theirs)
    var n = 0
    var inPhrase = false
    for seg in d.ours {
      for token in DiffLite.tokens(seg.text) where DiffLite.isWord(token) {
        if seg.changed {
          if DiffEmphasis.marks(token, other: other) {
            if !inPhrase { n += 1 }
            inPhrase = true
          }
        } else {
          inPhrase = false
        }
      }
    }
    return n
  }

  static func label(_ n: Int) -> String {
    n == 0 ? "Same as what you sent" : "Changed \(n) phrase\(n == 1 ? "" : "s")"
  }
}

// MARK: s10f (DESIGN-REVIEW-4 M3): changes counted by sentence

/// The dry run's diff, counted the way a person reads an email: by sentence. A reworded sentence is one change
/// however many words moved; the sign-off block (the trailing short lines) is compared on its own and flagged when it
/// differs. Highlights are contiguous: one span per changed sentence, from its first to its last changed claim word.
enum SentenceDiff {
  struct Summary: Equatable, Sendable {
    var changed: Int
    var total: Int
    var signOffDiffers: Bool
    /// s10f (PR #13 review): sentences you wrote that the draft dropped (beyond the ones it reworded).
    var missing: Int = 0

    var label: String {
      var parts: [String] = []
      if changed > 0 { parts.append("Changed \(changed) of \(total) sentence\(total == 1 ? "" : "s")") }
      if missing > 0 { parts.append(changed > 0 ? "\(missing) missing" : "\(missing) sentence\(missing == 1 ? "" : "s") missing") }
      if signOffDiffers { parts.append(parts.isEmpty ? "Sign-off differs" : "sign-off differs") }
      return parts.isEmpty ? "Same as what you sent" : parts.joined(separator: " · ")
    }
  }

  static let closers: Set<String> = ["best", "thanks", "thank", "cheers", "regards", "warmly", "sincerely", "talk", "speak"]

  /// The trailing lines that are a sign-off or signature: short (at most 5 words), not ending a sentence or a question,
  /// at most 4 lines, never the first line.
  static func signOff(_ text: String) -> [String] {
    let lines = text.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    var out: [String] = []
    var i = lines.count - 1
    while i > 0 && lines[i].isEmpty { i -= 1 }
    while i > 0 && out.count < 4 {
      let l = lines[i]
      if l.isEmpty { break }
      let words = l.split(separator: " ").count
      guard words <= 5, let last = l.last, !"?.!".contains(last) else { break }
      out.insert(l, at: 0)
      i -= 1
    }
    return out
  }

  /// Body sentences (the sign-off removed) as token ranges over `DiffLite.tokens(text)`.
  static func sentences(_ tokens: [String], bodyEnd: Int) -> [Range<Int>] {
    var out: [Range<Int>] = []
    var start: Int? = nil
    for k in 0..<bodyEnd {
      let t = tokens[k]
      if DiffLite.isWord(t) {
        if start == nil { start = k }
        if let last = t.last, ".?!".contains(last) || (t.hasSuffix(",") && k + 1 < bodyEnd && tokens[k + 1].contains("\n")) {
          out.append(start!..<(k + 1)); start = nil
        }
      } else if t.contains("\n"), let s = start {
        out.append(s..<k); start = nil
      }
    }
    if let s = start { out.append(s..<bodyEnd) }
    return out
  }

  /// Index of the first token of the sign-off block (tokens.count when there is none).
  static func bodyEnd(_ text: String, tokens: [String]) -> Int {
    let sign = signOff(text)
    guard !sign.isEmpty else { return tokens.count }
    // Walk back over the sign-off's words.
    let signWords = sign.flatMap { $0.split(separator: " ").map(String.init) }.count
    var seen = 0
    var k = tokens.count
    while k > 0 && seen < signWords {
      k -= 1
      if DiffLite.isWord(tokens[k]) { seen += 1 }
    }
    return k
  }

  static func normal(_ toks: ArraySlice<String>) -> String {
    toks.filter(DiffLite.isWord).map(DiffEmphasis.bare).filter { !$0.isEmpty }.joined(separator: " ")
  }

  private struct Parsed {
    var tokens: [String]
    var body: [Range<Int>]
    var bodyEnd: Int
    var sign: String
  }

  private static func parse(_ text: String) -> Parsed {
    let t = DiffLite.tokens(text)
    let end = bodyEnd(text, tokens: t)
    return Parsed(tokens: t, body: sentences(t, bodyEnd: end), bodyEnd: end, sign: signOff(text).joined(separator: " ").lowercased())
  }

  private static func changedSentences(_ a: Parsed, _ b: Parsed) -> [Bool] {
    let theirs = Set(b.body.map { normal(b.tokens[$0]) })
    return a.body.map { !theirs.contains(normal(a.tokens[$0])) }
  }

  static func summary(ours: String, theirs: String) -> Summary {
    let a = parse(ours), b = parse(theirs)
    let changed = changedSentences(a, b).filter { $0 }.count
    // Your sentences with no match in the draft: each reworded one accounts for one of them; the rest were dropped.
    let unmatchedTheirs = changedSentences(b, a).filter { $0 }.count
    return Summary(changed: changed, total: a.body.count, signOffDiffers: a.sign != b.sign,
                   missing: max(0, unmatchedTheirs - changed))
  }

  /// Our draft as segments whose `changed` runs are the contiguous spans to tint. Joined, the segments are the text.
  static func spans(ours: String, theirs: String) -> [DiffLite.Segment] {
    let a = parse(ours), b = parse(theirs)
    let flags = changedSentences(a, b)
    // Word-level LCS marks which words changed; a changed sentence's span runs from its first to its last changed
    // claim word (falling back to the whole sentence when only function words moved).
    var changedWord = Set<Int>()
    var k = 0
    let other = DiffEmphasis.words(theirs)
    for seg in DiffLite.diff(ours: ours, theirs: theirs).ours {
      for tok in DiffLite.tokens(seg.text) {
        if seg.changed && DiffEmphasis.marks(tok, other: other) { changedWord.insert(k) }
        k += 1
      }
    }
    var mark = Array(repeating: false, count: a.tokens.count)
    for (i, r) in a.body.enumerated() where flags[i] {
      let hits = r.filter { changedWord.contains($0) }
      let lo = hits.first ?? r.lowerBound, hi = hits.last ?? (r.upperBound - 1)
      for j in lo...hi { mark[j] = true }
    }
    if a.sign != b.sign && a.bodyEnd < a.tokens.count {
      var lo = a.bodyEnd
      while lo < a.tokens.count && !DiffLite.isWord(a.tokens[lo]) { lo += 1 }
      for j in lo..<a.tokens.count { mark[j] = true }
    }
    var out: [DiffLite.Segment] = []
    for (j, t) in a.tokens.enumerated() {
      if let last = out.last, last.changed == mark[j] { out[out.count - 1].text += t } else { out.append(.init(text: t, changed: mark[j])) }
    }
    return out
  }
}
