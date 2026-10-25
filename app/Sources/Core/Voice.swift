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
