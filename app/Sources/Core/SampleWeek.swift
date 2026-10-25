import Foundation

/// s10a: one consistent sample week for `--mock`, snapshots and the cross-screen copy test. The card, the review
/// window, the dashboard and the rail all read it, so every figure that appears on two screens is the same brain
/// number (21.9 h a week saved on outreach, 8 emails a batch, 7 of 7 days stored). The numbers are the brain's own
/// example (brain/API.md, GET /insights): 492 emails, 64.4% of the week, saves 21.9 h a week.
///
/// `MockBrainClient.outreach` and friends stay as they were: the s07 tests pin their arithmetic.
enum SampleWeek {
  static let status = ObserverStatus(state: .watching, daysStored: 7, windowDays: 7,
                                     nextPurge: MockBrainClient.local(24, 0, 0), insightsWaiting: 3)

  static let outreach = Insight(
    id: "ins_outreach", kind: "outreach", taskPhrase: "investor outreach emails", unitPlural: "emails",
    timeShare: 0.644, instanceCount: 492, medianMinutes: 3.0, taskHours: 24.6, trackedHours: 38.1, sameness: 0.86,
    saving: SavingEstimate(savingPct: 0.89, reviewMinutesPerInstance: 20.0 / 60, hoursPerWeekLow: 19.7, hoursPerWeekHigh: 22.9,
                           arithmetic: "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)",
                           hoursPerWeek: 21.9),
    connectors: [MockBrainClient.gmail],
    evidenceIds: (1...6).map { "sp_out_\($0)" },
    shareDisplay: "64.4%", medianDisplay: "3.0 min")

  static let scheduling = Insight(
    id: "ins_scheduling", kind: "scheduling", taskPhrase: "scheduling back-and-forth", unitPlural: "threads",
    timeShare: 0.142, instanceCount: 46, medianMinutes: 7, taskHours: 5.4, trackedHours: 38.1, sameness: 0.72,
    saving: SavingEstimate(savingPct: 0.86, reviewMinutesPerInstance: 1, hoursPerWeekLow: 3.9, hoursPerWeekHigh: 5.0,
                           arithmetic: "9.2/day × 5 days × 7.0 min = 5.4 h/wk → review 46 × 60 s = 0.8 h/wk → saves 4.6 h/wk (86%)",
                           hoursPerWeek: 4.6),
    connectors: [MockBrainClient.calendar, MockBrainClient.gmail],
    evidenceIds: (1...4).map { "sp_sch_\($0)" },
    shareDisplay: "14.2%", medianDisplay: "7.0 min")

  static let crm = Insight(
    id: "ins_crm", kind: "crm-update", taskPhrase: "copying replies into the CRM", unitPlural: "updates",
    timeShare: 0.089, instanceCount: 120, medianMinutes: 1.7, taskHours: 3.4, trackedHours: 38.1, sameness: 0.91,
    saving: SavingEstimate(savingPct: 0.85, reviewMinutesPerInstance: 0.25, hoursPerWeekLow: 2.5, hoursPerWeekHigh: 3.1,
                           arithmetic: "24/day × 5 days × 1.7 min = 3.4 h/wk → review 120 × 15 s = 0.5 h/wk → saves 2.9 h/wk (85%)",
                           hoursPerWeek: 2.9),
    connectors: [MockBrainClient.gmail, MockBrainClient.hubspot],
    evidenceIds: (1...4).map { "sp_crm_\($0)" },
    shareDisplay: "8.9%", medianDisplay: "1.7 min")

  static let insights: [Insight] = [outreach, scheduling, crm]

  /// The rail for this week (same status as the dashboard's Observing section).
  static var rail: RailModel { RailModel(status: status, automations: dashboard.automations.map(\.railAutomation), micRecording: false) }

  static var workflow: Workflow { MockBrainClient.outreachWorkflow }
  static var dryRun: DryRun { MockBrainClient.outreachDryRun }
  static var dashboard: DashboardData { MockBrainClient.sampleDashboard }
}

extension DashboardAutomation {
  /// The rail's view of a dashboard row (one dot per automation that is not finished).
  var railAutomation: Automation {
    let s: AutomationStatus
    switch state {
    case .active: s = .running
    case .readyForReview: s = .awaitingApproval
    case .needsYou: s = .failed
    case .paused: s = .paused
    case .drafting: s = .draft
    }
    return Automation(id: id, name: name, status: s, hoursSavedEstimated: estimatedHoursPerWeek,
                      hoursSavedMeasured: measuredHoursPerWeek)
  }
}

extension RailModel {
  /// s10a: what the hover label says, so the dots have names: "Watching · Day 7 of 7 · 1 running · 2 need you".
  var hoverLabel: String {
    let autos = dots.dropFirst()
    let running = autos.filter { $0.role == .working }.count
    let need = autos.filter { $0.role == .needsYou }.count
    var parts = [observerLabel]
    if running > 0 { parts.append("\(running) running") }
    if need > 0 { parts.append(need == 1 ? "1 needs you" : "\(need) need you") }
    return parts.joined(separator: " · ")
  }
}
