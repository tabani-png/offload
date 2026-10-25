import Foundation

// s08 sample data: the outreach workflow the card's "Build the workflow" drafts, its dry run on last week's real
// emails, a smaller scheduling workflow, and a dashboard one week later. Wall-clock times are built in the
// viewer's own time zone (like s07's evidence), so "09:00" reads as 09:00 wherever it renders.

extension MockBrainClient {
  static func local(_ day: Int, _ h: Int, _ m: Int) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .current
    return cal.date(from: DateComponents(year: 2026, month: 10, day: day, hour: h, minute: m))!
  }

  /// Fri 23 Oct 2026, 11:00 local: "now" for the review and dashboard.
  static let reviewNow = local(23, 11, 0)

  // MARK: connectors

  static let connectorStates: [String: ConnectorState] = [
    "gmail": .connected, "gsheets": .missing, "gcal": .connected, "hubspot": .missingEnv,
  ]

  static let gmail = Connector(id: "gmail", name: "Gmail", kind: .mcp, connected: true)
  static let sheets = Connector(id: "gsheets", name: "Google Sheets", kind: .composio, connected: false)
  static let calendar = Connector(id: "gcal", name: "Google Calendar", kind: .calendar, connected: true)
  static let hubspot = Connector(id: "hubspot", name: "HubSpot", kind: .composio, connected: false, missingEnv: true)

  // MARK: recipients

  static let priya = Recipient(name: "Priya Raman", org: "Halden Ventures", email: "priya@haldenvc.com")
  static let daniel = Recipient(name: "Daniel Osei", org: "Ashgrove Capital", email: "daniel@ashgrove.capital")
  static let lena = Recipient(name: "Lena Fischer", org: "Pellow Partners", email: "lena@pellow.partners")

  static let nextBatch: [Recipient] = [
    Recipient(name: "Tomás Ibarra", org: "Northline Fund", email: "tomas@northline.fund"),
    Recipient(name: "Grace Whitfield", org: "Larchmont Seed", email: "grace@larchmontseed.com"),
    Recipient(name: "Kenji Mori", org: "Hollis & Vane", email: "kenji@hollisvane.com"),
    Recipient(name: "Amara Nwosu", org: "Fieldstone VC", email: "amara@fieldstone.vc"),
    Recipient(name: "Ruth Calder", org: "Brightwater Angels", email: "ruth@brightwater.club"),
    Recipient(name: "Oliver Grant", org: "Cobalt Street", email: "oliver@cobaltstreet.vc"),
    Recipient(name: "Sofia Lindqvist", org: "Nordvik Ventures", email: "sofia@nordvik.vc"),
    Recipient(name: "Imran Qureshi", org: "Meridian Seed", email: "imran@meridianseed.com"),
  ]

  // MARK: outreach workflow (8 steps, gate at 5)

  static let outreachSteps: [WorkflowStep] = [
    WorkflowStep(id: "s1", type: .read, title: "Read the investor list",
                 detail: "Investor pipeline sheet, rows marked Not contacted", connectorId: "gsheets"),
    WorkflowStep(id: "s2", type: .read, title: "Pick the next 8",
                 detail: "Skips anyone you emailed in the last 30 days. Runs on this Mac."),
    WorkflowStep(id: "s3", type: .read, title: "Read your last thread with each",
                 detail: "Newest 3 messages per person", connectorId: "gmail"),
    WorkflowStep(id: "s4", type: .draft, title: "Draft each email in your voice",
                 detail: "Your voice, your 3 closest past emails and your facts. A number that is not in your facts is flagged."),
    WorkflowStep(id: "s5", type: .approvalGate, title: "You approve the batch",
                 detail: "All 8 drafts wait here. Approve, edit or drop each one. Nothing below runs until you do."),
    WorkflowStep(id: "s6", type: .send, title: "Send from Gmail",
                 detail: "One at a time, 40 s apart, only the drafts you approved", connectorId: "gmail"),
    WorkflowStep(id: "s7", type: .log, title: "Log each send to the pipeline",
                 detail: "Status Contacted, date and subject", connectorId: "gsheets"),
    WorkflowStep(id: "s8", type: .log, title: "Record the time it took",
                 detail: "Run time and your review time, kept on this Mac for the dashboard"),
  ]

  static let outreachSkill = """
  ---
  name: investor-outreach
  description: Draft first-touch and follow-up emails to investors in Muhammad's voice, hold them for batch approval, send, log.
  connectors: [gmail, gsheets]
  gates: [batch-approval]
  autoRun: false
  ---

  # Investor outreach

  Weekdays at 09:00. Up to 8 emails a batch.

  1. Read "Investor pipeline" (Google Sheets). Take rows with Status = Not contacted.
  2. Pick the next 8. Skip anyone emailed in the last 30 days (scripts/pick_recipients.ts).
  3. For each person, read the newest 3 messages of your last Gmail thread with them.
  4. Draft one email each. Use the tone card, the 3 closest past emails and facts.md.
     Every number in a draft must appear in facts.md. If one does not, drop the draft and say why.
  5. Approval gate. Show the whole batch. Wait. Approve, edit or drop each draft.
  6. Send the approved drafts from Gmail, one at a time, 40 s apart.
  7. Log each send: Status = Contacted, date, subject.
  8. Record run time and review time for the dashboard. Local only.

  Never send a draft that was not approved in step 5. Never reply inside an existing thread without approval.
  """

  static let outreachTone = """
  Measured from 40 sent emails: 45 to 80 words, 3 or 4 short paragraphs. Opens "Hi <first name>," every time. Ends with "Muhammad" on its own line. One ask, at the end, with a day in it.

  Direct and warm. Lead with something specific to them. State numbers plainly and never round up. No "hope this finds you well", no exclamation marks.
  """

  static let outreachWorkflow = Workflow(
    id: "wf_outreach", insightId: "ins_outreach", name: "Investor outreach emails",
    summary: "Drafts your investor emails in your voice from the pipeline sheet, holds every batch for you, then sends and logs.",
    state: .readyForReview, connectors: [gmail, sheets],
    schedule: WorkflowSchedule(summary: "Weekdays at 09:00 · 8 a batch", batchSize: 8, nextRunAt: local(26, 9, 0)),
    steps: outreachSteps, skillMarkdown: outreachSkill, toneCard: outreachTone, nextBatch: nextBatch,
    logTarget: "Investor pipeline", sendFrom: "muhammad@offload.so", estimatedHoursPerWeek: 21.9,
    batchHash: "b_7f3a91c2",
    arithmetic: "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)")

  static let outreachDryRun = DryRun(
    workflowId: "wf_outreach", ranAt: local(23, 10, 52),
    items: [
      DryRunItem(
        id: "inst_out_1", recipient: priya, subject: "Intro: Offload seed round", sentAt: local(19, 9, 14),
        ourDraft: """
        Hi Priya,

        Saw Halden led Tessellate's seed in March. I'm building Offload: a Mac app that watches a week of your work and automates the parts that repeat.

        40 design partners, 3 paying. Raising a $2.5M seed.

        Worth 20 minutes next week?

        Muhammad
        """,
        whatYouSent: """
        Hi Priya,

        Saw Halden led Tessellate's seed. I'm building Offload, a Mac app that learns a week of your work and automates the repeat parts.

        40 design partners, 3 paying. We're raising a $2.5M seed.

        Free for 20 minutes Tuesday or Wednesday?

        Muhammad
        """,
        observedMinutes: 3.2, reviewSeconds: 20, minutesSaved: 2.9),
      DryRunItem(
        id: "inst_out_2", recipient: daniel, subject: "Following up on our call", sentAt: local(19, 9, 18),
        ourDraft: """
        Hi Daniel,

        Thanks for the time on Thursday. As promised, the deck and our retention numbers are in the data room. 3 of 3 paying teams renewed.

        Happy to walk your partners through it. Does Monday work?

        Muhammad
        """,
        whatYouSent: """
        Hi Daniel,

        Thanks for Thursday. As promised, the deck and retention numbers are in the data room. All 3 paying teams renewed.

        Happy to walk your partners through it. Monday or Tuesday?

        Muhammad
        """,
        observedMinutes: 2.8, reviewSeconds: 20, minutesSaved: 2.5),
      DryRunItem(
        id: "inst_out_3", recipient: lena, subject: "Deck and data room access", sentAt: local(21, 8, 47),
        ourDraft: """
        Hi Lena,

        Here is the deck and a data room link. It has the model, the cap table and the design partner list.

        Short version: 40 design partners, 3 paying, raising $2.5M.

        Any questions, send them my way.

        Muhammad
        """,
        whatYouSent: """
        Hi Lena,

        Deck attached, and here is the data room. The model, cap table and design partner list are in there.

        Short version: 40 design partners, 3 paying, raising $2.5M.

        Send any questions my way.

        Muhammad
        """,
        observedMinutes: 3.4, reviewSeconds: 20, minutesSaved: 3.1),
    ],
    deniedSideEffects: 6, batchHash: "b_7f3a91c2")

  // MARK: scheduling workflow (ready for review on the dashboard)

  static let schedulingWorkflow = Workflow(
    id: "wf_scheduling", insightId: "ins_scheduling", name: "Scheduling replies",
    summary: "Answers \"what time works?\" threads with three free slots from your calendar, held for you.",
    state: .readyForReview, connectors: [gmail, calendar],
    schedule: WorkflowSchedule(summary: "When a scheduling email arrives · 1 a batch", batchSize: 1, nextRunAt: nil),
    steps: [
      WorkflowStep(id: "c1", type: .read, title: "Read the new thread", detail: "Only threads asking for a time",
                   connectorId: "gmail"),
      WorkflowStep(id: "c2", type: .read, title: "Find three free slots", detail: "Next 5 working days, 30 min, not before 09:00",
                   connectorId: "gcal"),
      WorkflowStep(id: "c3", type: .draft, title: "Draft the reply in your voice", detail: "Tone card for scheduling"),
      WorkflowStep(id: "c4", type: .approvalGate, title: "You approve the reply", detail: "Nothing sends until you do"),
      WorkflowStep(id: "c5", type: .send, title: "Send from Gmail", detail: "As a reply in the same thread", connectorId: "gmail"),
    ],
    skillMarkdown: "---\nname: scheduling-replies\nconnectors: [gmail, gcal]\ngates: [reply-approval]\n---\n\n# Scheduling replies\n\n1. Read the thread.\n2. Find three free 30-minute slots.\n3. Draft a reply.\n4. Approval gate.\n5. Send as a reply.\n",
    toneCard: "Scheduling · your voice\nOne or two lines. Offers three times, says the time zone once. Ends with \"Muhammad\".",
    nextBatch: [daniel], logTarget: "nowhere (no log step)", sendFrom: "muhammad@offload.so",
    estimatedHoursPerWeek: 4.6, batchHash: "b_19c0e4aa",
    arithmetic: "9.2/day × 5 days × 7.0 min = 5.4 h/wk → review 46 × 60 s = 0.8 h/wk → saves 4.6 h/wk (86%)")

  static let schedulingDryRun = DryRun(
    workflowId: "wf_scheduling", ranAt: local(23, 8, 40),
    items: [
      DryRunItem(
        id: "inst_sch_1", recipient: daniel, subject: "Re: Time next week?", sentAt: local(19, 11, 40),
        ourDraft: "Hi Daniel,\n\nTue 10:00, Wed 14:30 or Thu 09:30 work (Eastern). Pick one and I'll send an invite.\n\nMuhammad",
        whatYouSent: "Hi Daniel,\n\nTue 10:00, Wed 14:30 or Thu 09:30, all Eastern. Pick one and I'll send the invite.\n\nMuhammad",
        observedMinutes: 6.5, reviewSeconds: 30, minutesSaved: 6.0),
    ],
    deniedSideEffects: 1, batchHash: "b_19c0e4aa")

  static let sampleWorkflows: [Workflow] = [outreachWorkflow, schedulingWorkflow]
  static let sampleDryRuns: [String: DryRun] = ["wf_outreach": outreachDryRun, "wf_scheduling": schedulingDryRun]

  // MARK: dashboard (one week later)

  static let dashboardAutomations: [DashboardAutomation] = [
    DashboardAutomation(
      id: "auto_outreach", workflowId: "wf_outreach", insightId: "ins_outreach", name: "Investor outreach emails",
      state: .active, connectors: [gmail, sheets.applying(["gsheets": .connected])],
      lastRunAt: local(23, 9, 0), nextRunAt: local(26, 9, 0),
      estimatedHoursPerWeek: 21.9, measuredHoursPerWeek: 16.8, needsYouReason: nil, taskId: "t_outreach",
      arithmetic: "98.4/day × 5 days × 3.0 min = 24.6 h/wk → review 492 × 20 s = 2.7 h/wk → saves 21.9 h/wk (89%)"),
    DashboardAutomation(
      id: "auto_scheduling", workflowId: "wf_scheduling", insightId: "ins_scheduling", name: "Scheduling replies",
      state: .readyForReview, connectors: [gmail, calendar], lastRunAt: nil, nextRunAt: nil,
      estimatedHoursPerWeek: 4.6, measuredHoursPerWeek: nil, needsYouReason: nil, taskId: "t_sched",
      arithmetic: "9.2/day × 5 days × 7.0 min = 5.4 h/wk → review 46 × 60 s = 0.8 h/wk → saves 4.6 h/wk (86%)"),
    DashboardAutomation(
      id: "auto_crm", workflowId: "wf_crm", insightId: "ins_crm", name: "CRM notes from replies",
      state: .needsYou, connectors: [gmail, hubspot], lastRunAt: local(22, 17, 30), nextRunAt: nil,
      estimatedHoursPerWeek: 2.9, measuredHoursPerWeek: nil,
      needsYouReason: "HubSpot signed out, so 2 notes are waiting to be logged.", taskId: "t_crm",
      arithmetic: "24/day × 5 days × 1.7 min = 3.4 h/wk → review 120 × 15 s = 0.5 h/wk → saves 2.9 h/wk (85%)"),
  ]

  /// Only automations that ran this week count toward the hero; scheduling has not run, CRM stopped.
  static let dashboardHours = HoursSaved(estimated: 21.9, measured: 16.8)

  static let dashboardObserving = ObservingState(
    state: .watching, daysStored: 7, keepDays: 7, nextPurgeDay: "2026-10-17", nextPurgeAt: local(24, 0, 0),
    permissions: [
      PermissionState(.screenRecording, granted: true),
      PermissionState(.accessibility, granted: true),
      PermissionState(.inputMonitoring, granted: false),
    ])

  static let timelineTasks: [TimelineTask] = [
    TimelineTask(id: "t_outreach", name: "Investor outreach", tint: 0, automated: true),
    TimelineTask(id: "t_sched", name: "Scheduling", tint: 1, automated: false),
    TimelineTask(id: "t_crm", name: "CRM updates", tint: 2, automated: false),
    TimelineTask(id: "t_other", name: "Everything else", tint: 3, automated: false),
  ]

  /// The sample week's rows come from `MockWeek` (s10d), the one source the card, the timeline and the tracked
  /// total all read, so "64.4% of your week" and the outreach bars are the same minutes.
  private static let timelineRows: [(Int, [(String, String, String, Bool)])] = MockWeek.rows

  private static let barTitles: [String: (String, String?)] = [
    "t_outreach": ("Intro: Offload seed round", "Halden Ventures"),
    "t_sched": ("Re: Time next week?", "Daniel Osei"),
    "t_crm": ("Contacts · Pellow Partners", "Pellow Partners"),
    "t_other": ("Slack, Linear and Docs", nil),
  ]

  static let timelineDays: [TimelineDay] = timelineRows.map { day, rows in
    func at(_ s: String) -> Date {
      let p = s.split(separator: ":").compactMap { Int($0) }
      return local(day, p[0], p[1])
    }
    let bars = rows.enumerated().map { i, r in
      TimelineBar(id: "bar_\(day)_\(i)", taskId: r.0, start: at(r.1), end: at(r.2), automated: r.3,
                  title: barTitles[r.0]?.0 ?? "", counterparty: barTitles[r.0]?.1)
    }
    return TimelineDay(day: String(format: "2026-10-%02d", day), date: local(day, 0, 0), bars: bars)
  }

  /// The bar "Show the evidence" points at: Monday's first outreach block, done by hand.
  static let evidenceBarId = "bar_19_0"

  static let sampleDashboard = DashboardData(
    automations: dashboardAutomations, hours: dashboardHours, observing: dashboardObserving,
    tasks: timelineTasks, days: timelineDays)
}

/// Everything the dashboard window renders. A live client composes it from GET /dashboard, GET /status,
/// GET /connectors and seven GET /timeline calls.
struct DashboardData: Codable, Equatable, Sendable {
  var automations: [DashboardAutomation]
  var hours: HoursSaved
  var observing: ObservingState
  var tasks: [TimelineTask]
  var days: [TimelineDay]
}
