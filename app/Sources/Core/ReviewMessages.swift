import Foundation

/// The review window's status line after the brain answers (s09a). Calm, in the brain's own words where it has them.
enum ReviewMessages {
  /// After approval: when it runs next, or what it still waits for (e.g. Gmail not connected).
  static func approved(_ w: Workflow, now: Date) -> String {
    if !w.needsYou.isEmpty {
      return "Turned on. Before it can send: " + w.needsYou.map { BrainError.sentence($0) }.joined(separator: " ")
    }
    // s23 (PR #13 F4): mid-sentence, "today" and "tomorrow" are lower case ("First run tomorrow 09:00.").
    if let next = w.schedule.nextRunAt { return "Turned on. First run \(midSentence(Format.runTime(next, now: now, past: false)))." }
    return "Turned on. It runs when you start it; nothing is sent without your approval."
  }

  static func midSentence(_ s: String) -> String {
    for word in ["Today", "Tomorrow", "Yesterday"] where s.hasPrefix(word) { return word.lowercased() + s.dropFirst(word.count) }
    return s
  }

  /// The brain refused: say its reason (409 "connect Gmail first") and that nothing changed.
  static func approvalFailed(_ error: Error) -> String {
    if case .conflict(let m)? = error as? BrainError, !m.isEmpty {
      return "\(BrainError.sentence(m)) Nothing was turned on or sent."
    }
    return "\(BrainError.message(for: error)) Nothing was turned on."
  }

  static func dryRunFailed(_ error: Error) -> String {
    "Dry run did not finish. \(BrainError.message(for: error)) The workflow is unchanged."
  }
}
