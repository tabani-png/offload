import Foundation

/// Every user-facing number goes through here, so the card, the rail and later the dashboard say the same
/// thing the same way. Locale is fixed to en_US_POSIX for v1 (the operator); localisation comes later.
enum Format {
  private static let posix = Locale(identifier: "en_US_POSIX")

  /// One decimal at most, trailing ".0" dropped.
  static func decimal(_ value: Double) -> String {
    let rounded = (value * 10).rounded() / 10
    if rounded == rounded.rounded() { return String(Int(rounded)) }
    return String(format: "%.1f", locale: posix, rounded)
  }

  /// "25 h", "18.4 h"; under an hour reads as minutes ("30 min").
  static func hours(_ value: Double) -> String {
    if value < 1 { return "\(Int((value * 60).rounded())) min" }
    return "\(decimal(value)) h"
  }

  /// "65%". Anything real but below half a percent reads "<1%", never "0%".
  static func percent(_ share: Double) -> String {
    if share > 0 && share < 0.005 { return "<1%" }
    return "\(Int((share * 100).rounded()))%"
  }

  /// "1,200".
  static func count(_ n: Int) -> String {
    let f = NumberFormatter()
    f.locale = posix
    f.numberStyle = .decimal
    f.groupingSeparator = ","
    f.usesGroupingSeparator = true
    return f.string(from: NSNumber(value: n)) ?? String(n)
  }

  /// "~3 min". The tilde says it is a median, not an exact figure.
  static func approxMinutes(_ minutes: Double) -> String { "~\(decimal(minutes)) min" }

  /// "You spent 65% of your week on investor outreach emails."
  static func headline(_ i: Insight) -> String {
    "You spent \(percent(i.timeShare)) of your week on \(i.taskPhrase)."
  }

  /// "500 emails × ~3 min = 25 h of 38.5 h tracked"
  static func arithmetic(_ i: Insight) -> String {
    "\(count(i.instanceCount)) \(i.unitPlural) × \(approxMinutes(i.medianMinutes)) = \(hours(i.taskHours)) of \(hours(i.trackedHours)) tracked"
  }

  /// "18–21 h back a week"
  static func savingRange(_ s: SavingEstimate) -> String {
    let low = s.hoursPerWeekLow, high = s.hoursPerWeekHigh
    if low < 1 && high < 1 { return "\(hours(low))–\(hours(high)) back a week" }
    return "\(decimal(low))–\(decimal(high)) h back a week"
  }

  /// The brain's arithmetic verbatim when it sent one; otherwise the same formula the brain uses:
  /// "3.4 h now − 24 min review = 3 h a week (88%)".
  static func savingArithmetic(_ i: Insight) -> String {
    if let brain = i.saving.arithmetic, !brain.isEmpty { return brain }
    let review = Double(i.instanceCount) * i.saving.reviewMinutesPerInstance / 60
    let saved = max(0, i.taskHours - review)
    return "\(hours(i.taskHours)) now − \(hours(review)) review = \(hours(saved)) a week (\(percent(i.saving.savingPct)))"
  }

  /// "Tue 09:14"
  static func spanTime(_ s: EvidenceSpan, calendar: Calendar = .current) -> String {
    let f = DateFormatter()
    f.locale = posix
    f.calendar = calendar
    f.timeZone = calendar.timeZone
    f.dateFormat = "EEE HH:mm"
    return f.string(from: s.start)
  }

  /// "4 min" of active time (idle removed).
  /// s10e: "3 min 12 s": minutes and seconds, so a list of emails shows what each one really took.
  static func spanDurationPrecise(_ s: EvidenceSpan) -> String {
    let secs = max(1, Int((s.activeMinutes * 60).rounded()))
    let m = secs / 60, r = secs % 60
    if m == 0 { return "\(r) s" }
    return r == 0 ? "\(m) min" : "\(m) min \(r) s"
  }

  static func spanDuration(_ s: EvidenceSpan) -> String {
    let m = max(1, Int(s.activeMinutes.rounded()))
    return "\(m) min"
  }
}
