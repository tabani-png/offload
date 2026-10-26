import Foundation

// s10a: one formatter for every saving, hours figure and count a person reads, plus the plain-words pass over the
// brain's text. Surfaces never format a saving themselves: they read the presenters in Copy.swift, which read this.

/// One line of the brain's saving arithmetic, labelled ("By hand", "Your review", "Saved").
struct ArithmeticStep: Equatable, Sendable {
  var label: String
  /// The whole step as the brain printed it, units normalised ("… = 24.6 h a week").
  var text: String
  /// The left of the last " = " ("98.4/day × 5 days × 3.0 min"); empty for the saved line.
  var formula: String = ""
  /// The right of it, without the per-week unit the column header carries ("24.6 h", "21.9 h (89%)").
  var result: String = ""
}

enum Figures {
  private static let posix = Locale(identifier: "en_US_POSIX")

  /// Hours with one decimal by the one rounding rule (s23, HoursFormat: tenths, half up, as brain/src/time/format.ts),
  /// so the same hours print the same digits on every screen: "22.0 h", 24.65 h -> "24.7 h".
  static func hours(_ h: Double) -> String { HoursFormat.display(hours: h) }

  /// "22.0 h a week"
  static func perWeek(_ h: Double) -> String { "\(hours(h)) a week" }

  /// The saving the brain printed in its arithmetic ("… → saves 22.0 h/wk (89%)"), else its value with the same
  /// rule. Reading the printed digits means the chip can never disagree with the line under it.
  static func savedHours(value: Double?, arithmetic: String?) -> String? {
    if let a = arithmetic, let printed = printedSaving(a) { return "\(printed) h" }
    return value.map(hours)
  }

  /// "Saves 22.0 h a week"
  static func saves(value: Double?, arithmetic: String?) -> String? {
    savedHours(value: value, arithmetic: arithmetic).map { "Saves \($0) a week" }
  }

  /// "22.0 h a week"
  static func savedPerWeek(value: Double?, arithmetic: String?) -> String? {
    savedHours(value: value, arithmetic: arithmetic).map { "\($0) a week" }
  }

  /// The number after "saves" in a brain arithmetic line, exactly as printed.
  static func printedSaving(_ arithmetic: String) -> String? {
    guard let r = arithmetic.range(of: "saves ", options: .backwards) else { return nil }
    let tail = arithmetic[r.upperBound...]
    let digits = tail.prefix { $0.isNumber || $0 == "." }
    return digits.isEmpty ? nil : String(digits)
  }

  /// "18.6–22.7 h a week"
  static func range(low: Double, high: Double) -> String {
    "\(String(format: "%.1f", locale: posix, low))–\(hours(high)) a week"
  }

  /// "495 emails", "1 email"
  static func count(_ n: Int, _ unitPlural: String) -> String {
    let unit = n == 1 && unitPlural.hasSuffix("s") ? String(unitPlural.dropLast()) : unitPlural
    return "\(Format.count(n)) \(unit)"
  }

  /// "Saves 2.9 min": a dry-run item's saving, never a bare negative number in green.
  /// "45 min"
  static func minutes(_ m: Double) -> String { "\(Int(m.rounded())) min" }

  static func minutesSaved(_ m: Double) -> String { "Saves \(String(format: "%.1f", locale: posix, m)) min" }

  /// "3.2 min by hand, 20 s to review"
  static func itemTime(observedMinutes: Double, reviewSeconds: Double) -> String {
    "\(String(format: "%.1f", locale: posix, observedMinutes)) min by hand, \(Int(reviewSeconds.rounded())) s to review"
  }

  /// s10d: a headline share in whole percent ("64%"), from the brain's display when it sent one ("64.5%" → "65%").
  static func wholeShare(display: String?, value: Double) -> String {
    let raw = display.flatMap { Double($0.replacingOccurrences(of: "%", with: "")) } ?? value * 100
    return "\(Int(raw.rounded(.toNearestOrAwayFromZero)))%"
  }

  /// The brain's share display ("64.5%") when it sent one, else the value with the card's rule.
  static func share(display: String?, value: Double) -> String { display ?? Format.percent(value) }

  /// The brain's arithmetic as labelled steps, its digits untouched. "h/wk" reads "h a week" so units never mix.
  static func arithmeticSteps(_ line: String) -> [ArithmeticStep] {
    let parts = line.components(separatedBy: " → ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    return parts.enumerated().map { i, raw in
      var text = raw.replacingOccurrences(of: " h/wk", with: " h a week")
      var label = ""
      for (prefix, name) in [("review ", "Your review"), ("saves ", "Saved"), ("before: ", "Before"), ("after: ", "After")] {
        if text.hasPrefix(prefix) { label = name; text = String(text.dropFirst(prefix.count)); break }
      }
      if label.isEmpty { label = i == 0 ? "By hand" : (i == parts.count - 1 ? "Saved" : "") }
      var formula = "", result = text
      if let r = text.range(of: " = ", options: .backwards) {
        formula = String(text[..<r.lowerBound])
        result = String(text[r.upperBound...])
      }
      result = result.replacingOccurrences(of: " h a week", with: " h")
      return ArithmeticStep(label: label, text: text, formula: formula, result: result)
    }
  }
}

/// Rewrites the brain's internal words (file names, gate jargon) into plain ones before they reach a person.
enum PlainWords {
  /// Words that must never reach user copy (the s10a copy test greps every presenter string for these).
  static let banned = ["facts.md", "crm-log.csv", "recipients.csv", "skill.md", "approval gate", "tone card",
                       "style card", "auto-run", "log step", "held by the gate", "no model", "click to edit",
                       "first_name", ".csv", "gate-log"]

  private static let rewrites: [(String, String)] = [
    ("Runs as a script, no model.", "Runs on this Mac."),
    ("Auto-run is off.", ""), ("Auto-run is off", ""),
    ("held by the gate", "held back"),
    ("Stopped at the log step:", "Stopped before logging."),
    ("the log step", "logging"),
    ("Approval gate", "You approve"), ("approval gate", "approval step"),
    ("facts.md", "your facts"), ("crm-log.csv", "the log"), ("recipients.csv", "your recipient list"),
    ("SKILL.md", "the steps"),
    ("style card", "voice notes"), ("tone card", "voice notes"), ("Tone card", "Your voice notes"),
    ("Style card", "Your voice notes"),
  ]

  static func clean(_ s: String) -> String {
    var t = s
    // "(an export of your investor sheet: email, first_name, last_name, notes)": column names are not copy.
    if let re = try? NSRegularExpression(pattern: #"\s*\([^()]*(_|\.csv|\.md)[^()]*\)"#) {
      t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "")
    }
    // s10d: "your investor-outreach tone card" is "your voice", the name the review window uses for it.
    if let re = try? NSRegularExpression(pattern: #"\b[Yy]our [A-Za-z-]+ (tone|style) card\b"#) {
      t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "your voice")
    }
    for (a, b) in rewrites { t = t.replacingOccurrences(of: a, with: b) }
    while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
    t = t.replacingOccurrences(of: " .", with: ".").replacingOccurrences(of: " ,", with: ",")
    return t.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// True when the text still carries an internal word.
  static func leaks(_ s: String) -> String? {
    let l = s.lowercased()
    return banned.first { l.contains($0) }
  }
}

/// The schedule in one sentence: the brain's note, then the batch size, without stacked punctuation.
enum ScheduleCopy {
  /// The brain's note without the " · N a batch" the wire mapper appends, and without a closing full stop.
  static func note(_ summary: String) -> String {
    var t = summary.trimmingCharacters(in: .whitespacesAndNewlines)
    if let re = try? NSRegularExpression(pattern: #"\s*[.]?\s*·\s*\d+\s+a batch\.?$"#) {
      t = re.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "")
    }
    while t.hasSuffix(".") { t.removeLast() }
    return t
  }

  /// "Weekdays at 09:00, up to 8 emails a batch." or, for a full sentence from the brain,
  /// "Weekdays at 09:00 a new batch is drafted and waits for your review. Up to 20 emails a batch."
  /// s14: `unit` is "items" for a general (plan) workflow, which may not write email at all.
  static func line(summary: String, batchSize: Int, unit: String = "emails") -> String {
    let n = note(summary)
    guard batchSize > 0 else { return n.isEmpty ? "Runs when you start it." : "\(n)." }
    let batch = "up to \(Figures.count(batchSize, unit)) a batch"
    if n.isEmpty { return BrainError.sentence(batch) }
    if n.split(separator: " ").count > 5 { return "\(n). \(BrainError.sentence(batch))" }
    return "\(n), \(batch)."
  }

  /// Confirm sheet subtitle: when the first run is, then the schedule.
  static func confirm(summary: String, batchSize: Int, firstRunAt: Date?, now: Date) -> String {
    let l = line(summary: summary, batchSize: batchSize)
    guard let at = firstRunAt else { return "Not scheduled yet. \(l)" }
    return "First run \(Format.runTime(at, now: now, past: false)). \(l)"
  }
}
