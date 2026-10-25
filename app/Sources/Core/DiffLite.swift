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
