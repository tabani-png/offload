import Foundation

/// Word-level diff between "Our draft" and "What you sent". Lite on purpose: it marks words, never characters,
/// and never marks whitespace, so a reviewer's eye lands on the handful of words that differ.
enum DiffLite {
  struct Segment: Equatable, Sendable {
    var text: String
    /// True when this word is not in the other side's matching sequence.
    var changed: Bool
  }

  struct Result: Equatable, Sendable {
    var ours: [Segment]
    var theirs: [Segment]
    /// Shared words over the longer side's word count, 0...1. 1 means identical wording.
    var similarity: Double
    var changedWordsOurs: Int { Self.words(ours) }
    var changedWordsTheirs: Int { Self.words(theirs) }
    private static func words(_ segs: [Segment]) -> Int {
      segs.filter(\.changed).reduce(0) { $0 + DiffLite.tokens($1.text).filter(DiffLite.isWord).count }
    }
  }

  /// Splits into words and whitespace runs. Punctuation stays on its word ("Tuesday?" is one token), which is how
  /// a person reads a sentence.
  static func tokens(_ text: String) -> [String] {
    var out: [String] = []
    var current = ""
    var inSpace = false
    for ch in text {
      let space = ch.isWhitespace
      if current.isEmpty { inSpace = space }
      if space != inSpace {
        out.append(current)
        current = ""
        inSpace = space
      }
      current.append(ch)
    }
    if !current.isEmpty { out.append(current) }
    return out
  }

  static func isWord(_ token: String) -> Bool { !(token.first?.isWhitespace ?? true) }

  static func diff(ours: String, theirs: String) -> Result {
    let a = tokens(ours), b = tokens(theirs)
    let aw = a.indices.filter { isWord(a[$0]) }
    let bw = b.indices.filter { isWord(b[$0]) }
    let n = aw.count, m = bw.count

    // Longest common subsequence over words only (emails are ~100 words; O(n·m) is fine).
    var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
    if n > 0 && m > 0 {
      for i in stride(from: n - 1, through: 0, by: -1) {
        for j in stride(from: m - 1, through: 0, by: -1) {
          dp[i][j] = a[aw[i]] == b[bw[j]] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
        }
      }
    }
    var keepA = Set<Int>(), keepB = Set<Int>()
    var i = 0, j = 0
    while i < n && j < m {
      if a[aw[i]] == b[bw[j]] { keepA.insert(aw[i]); keepB.insert(bw[j]); i += 1; j += 1 }
      else if dp[i + 1][j] >= dp[i][j + 1] { i += 1 }
      else { j += 1 }
    }

    func segments(_ toks: [String], keep: Set<Int>) -> [Segment] {
      var out: [Segment] = []
      for (k, t) in toks.enumerated() {
        let changed = isWord(t) && !keep.contains(k)
        // Merge runs with the same flag so the view draws few Text pieces. A space between two changed words
        // joins them into one highlight.
        if let last = out.last, last.changed == changed || (!isWord(t) && last.changed && nextIsChanged(toks, k, keep)) {
          out[out.count - 1].text += t
        } else {
          out.append(Segment(text: t, changed: changed))
        }
      }
      return out
    }

    let shared = keepA.count
    let longest = max(n, m)
    return Result(ours: segments(a, keep: keepA), theirs: segments(b, keep: keepB),
                  similarity: longest == 0 ? 1 : Double(shared) / Double(longest))
  }

  private static func nextIsChanged(_ toks: [String], _ k: Int, _ keep: Set<Int>) -> Bool {
    let next = k + 1
    guard toks.indices.contains(next), isWord(toks[next]) else { return false }
    // Only single spaces join highlights; a line break ends one.
    return !toks[k].contains("\n") && !keep.contains(next)
  }
}

/// Evidence row title: who it was for first, then the subject, cut at the tail. Never a middle cut.
struct EvidenceTitle: Equatable, Sendable {
  /// The counterparty (recipient, attendee), when the brain knows one.
  var lead: String?
  var subject: String

  static let separators = [", ", " - ", " – ", " — ", " | ", " · "]

  /// Moves a known counterparty to the front. If the title already names it at the end ("…, Halden Ventures")
  /// or the start ("Halden Ventures - …"), that copy is removed so it is not said twice. No guessing: with no
  /// counterparty from the brain the title is shown as it is.
  static func make(title: String, counterparty: String?) -> EvidenceTitle {
    let title = title.trimmingCharacters(in: .whitespaces)
    guard let who = counterparty?.trimmingCharacters(in: .whitespaces), !who.isEmpty else {
      return EvidenceTitle(lead: nil, subject: title)
    }
    var subject = title
    for sep in separators {
      if subject.lowercased().hasSuffix((sep + who).lowercased()) {
        subject = String(subject.dropLast(sep.count + who.count)); break
      }
      if subject.lowercased().hasPrefix((who + sep).lowercased()) {
        subject = String(subject.dropFirst(who.count + sep.count)); break
      }
    }
    subject = subject.trimmingCharacters(in: .whitespaces)
    if subject.isEmpty || subject.caseInsensitiveCompare(who) == .orderedSame { subject = "" }
    return EvidenceTitle(lead: who, subject: subject)
  }

  /// One-line plain form, for accessibility and logs: "Halden Ventures · Intro: Offload seed round".
  var plain: String {
    guard let lead else { return subject }
    return subject.isEmpty ? lead : "\(lead) · \(subject)"
  }
}

// MARK: s10d: what a reviewer should look at

/// Words that carry no claim. A changed "the" or "our" is not worth an underline: only the words that change what
/// the email says are marked (DESIGN-REVIEW-2, dry run).
enum DiffEmphasis {
  static let functionWords: Set<String> = [
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "by", "for", "with", "from", "as", "is", "are",
    "was", "be", "it", "its", "it's", "this", "that", "our", "your", "my", "we", "we're", "i", "i'm", "you", "me", "us",
    "so", "if", "do", "does", "any", "all", "here", "there", "just", "up", "out", "into", "about", "them", "they",
  ]

  /// The word without the punctuation a sentence puts around it, lower-cased.
  static func bare(_ token: String) -> String {
    token.lowercased().trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols).subtracting(CharacterSet(charactersIn: "$%")))
  }

  /// True when a changed token is worth marking: a word that is not a function word, and (when the other side is
  /// given) a word the other side never uses, so a word that only moved or lost its full stop is not marked.
  static func marks(_ token: String, other: Set<String>? = nil) -> Bool {
    guard DiffLite.isWord(token) else { return false }
    let b = bare(token)
    guard !b.isEmpty, !functionWords.contains(b) else { return false }
    return !(other?.contains(b) ?? false)
  }

  /// The bare words of a text, for `marks(_:other:)`.
  static func words(_ text: String) -> Set<String> {
    Set(DiffLite.tokens(text).filter(DiffLite.isWord).map(bare))
  }
}

/// s10d: a draft may only state what the person already said or what is in their facts. Numbers, amounts, months and
/// weekdays in the draft that appear in neither are listed, so "led Tessellate's seed in March" is caught when the
/// sent email never said March (step 4: "a number that is not in your facts is flagged"; a date is the same kind).
enum FactCheck {
  static let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september",
                       "october", "november", "december"]
  static let weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

  static func claims(_ text: String) -> [String] {
    var out: [String] = []
    for raw in DiffLite.tokens(text) where DiffLite.isWord(raw) {
      let t = raw.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?()\"'’"))
      let l = t.lowercased()
      let isNumber = t.contains { $0.isNumber }
      // "May" is a verb at the start of a sentence more often than a month: months must be capitalised mid-text.
      let isDate = (months.contains(l) && l != "may") || weekdays.contains(l)
      if (isNumber || isDate) && !out.contains(t) { out.append(t) }
    }
    return out
  }

  /// Claims in `draft` found in neither `source` nor `facts` (case-insensitive, whole tokens).
  static func unsupported(draft: String, source: String, facts: String) -> [String] {
    let known = Set((claims(source) + claims(facts)).map { $0.lowercased() })
    let knownText = (source + "\n" + facts).lowercased()
    return claims(draft).filter { c in
      let l = c.lowercased()
      if known.contains(l) { return false }
      // "3" inside "3 paying" in the facts counts; check the token with word edges.
      let pattern = "(^|[^0-9a-z])" + NSRegularExpression.escapedPattern(for: l) + "($|[^0-9a-z])"
      return knownText.range(of: pattern, options: .regularExpression) == nil
    }
  }
}
