import Foundation

// s14 sample data: a bookkeeper's general workflow (supplier invoices from Preview into Xero bills) with its typed
// plan, the two variants and their probe, and the generic dry run (what Offload would do next to what you did).
// Kept apart from the email demo's sampleWorkflows, so the founder week and its figures are unchanged.

extension MockBrainClient {
  static let xero = Connector(id: "app-xero", name: "Xero", kind: .localScript, connected: true)

  private static func need(_ need: String, _ target: String, _ name: String, _ capability: String, _ role: String,
                           _ via: String) -> CapabilityNeed {
    CapabilityNeed(need: need, target: target, targetName: name, capability: capability, role: role, via: via)
  }

  static let billReadInvoice = PlanStep(
    id: "p1", type: "read", title: "Read the supplier invoice",
    detail: "The supplier, invoice number, dates and total, from the PDF you open.",
    capability: need("read supplier invoice from Preview", "app-preview", "Preview", "file.read", "read", "local_file"),
    gated: false, when: nil, writesText: false, sourceSteps: ["u1"])
  static let billCheckOrder = PlanStep(
    id: "p2", type: "decide", title: "Check whether it names a purchase order",
    detail: "Most invoices do not. When one does, the order is looked up before the bill is filled in.",
    capability: nil, gated: false, when: nil, writesText: false, sourceSteps: ["u2"])
  static let billReadOrder = PlanStep(
    id: "p3", type: "read", title: "Look up the purchase order",
    detail: "Matches the order's lines and amount to the invoice.",
    capability: need("read purchase order in Xero", "app-xero", "Xero", "screen.read", "read", "computer_use"),
    gated: false, when: "when the invoice names a purchase order", writesText: false, sourceSteps: ["u2"])
  static let billFill = PlanStep(
    id: "p4", type: "transform", title: "Fill in the bill",
    detail: "Supplier, invoice number, invoice date, due date and total, copied from the invoice as they are.",
    capability: nil, gated: false, when: nil, writesText: false, sourceSteps: ["u3"])
  static let billCheck = PlanStep(
    id: "p4b", type: "decide", title: "Check the total before saving",
    detail: "The total must equal the invoice's total to the cent.",
    capability: nil, gated: false, when: nil, writesText: false, sourceSteps: ["u3"])
  static let billCreate = PlanStep(
    id: "p5", type: "commit", title: "Create the bill in Xero",
    detail: "Saved as a draft bill only after you approve it.",
    capability: need("create bill in Xero", "app-xero", "Xero", "ui.commit", "send", "computer_use"),
    gated: true, when: nil, writesText: false, sourceSteps: ["u3", "u4"])

  static let billPlan = WorkflowPlan(
    version: 2, outputType: "form_fields", goal: "Enter each supplier invoice as a bill in Xero",
    variants: [
      PlanVariant(id: "a", label: "Every step you take", summary: "Reads the invoice, looks up the order when it names one, fills in and saves the bill.",
                  steps: [billReadInvoice, billCheckOrder, billReadOrder, billFill, billCreate]),
      PlanVariant(id: "b", label: "Core loop only", summary: "Reads the invoice, fills in and saves the bill.",
                  steps: [billReadInvoice, billFill, billCreate]),
    ],
    chosen: "a", chosenBy: "dry_run",
    probe: [
      ProbeScore(variant: "a", instances: 12, matched: 58, extra: 1, missed: 1, agreement: 58.0 / 60.0,
                 arithmetic: "58 matched / (58 + 1 extra + 1 missed) = 97%"),
      ProbeScore(variant: "b", instances: 12, matched: 46, extra: 0, missed: 10, agreement: 46.0 / 56.0,
                 arithmetic: "46 matched / (46 + 0 extra + 10 missed) = 82%"),
    ],
    reason: "closer to what you did: 97% vs 82% of your steps", designedBy: "rules",
    capabilities: [
      CapabilityResolution(target: "app-preview", capability: "file.read", status: "pending", method: nil, reason: "waiting for the connector chain"),
      CapabilityResolution(target: "app-xero", capability: "ui.commit", status: "pending", method: nil, reason: "waiting for the connector chain"),
    ])

  static let billWorkflow = Workflow(
    id: "wf_bills", insightId: "ins_bills", name: "Supplier bills into Xero",
    summary: "Reads each supplier invoice you open, fills in the bill and holds it for you before anything is saved in Xero.",
    state: .readyForReview, connectors: [xero],
    schedule: WorkflowSchedule(summary: "When a new invoice arrives · 10 a batch", batchSize: 10, nextRunAt: nil),
    steps: [
      WorkflowStep(id: "p1", type: .read, title: "Read the supplier invoice", detail: "From the PDF you open in Preview"),
      WorkflowStep(id: "p4", type: .draft, title: "Fill in the bill", detail: "Copied from the invoice as it is"),
      WorkflowStep(id: "g1", type: .approvalGate, title: "You approve the batch", detail: "Nothing is saved in Xero until you do"),
      WorkflowStep(id: "p5", type: .send, title: "Create the bill in Xero", detail: "As a draft bill", connectorId: "app-xero"),
    ],
    skillMarkdown: "---\nname: supplier-bills\nconnectors: [app-preview, app-xero]\ngates: [batch-approval]\nauto_run: false\n---\n\n# Supplier bills into Xero\n",
    toneCard: "", nextBatch: [], logTarget: "Xero", sendFrom: "your Xero account", estimatedHoursPerWeek: 3.1,
    batchHash: "b_bill_51ac", arithmetic: "12/wk × 17.0 min = 3.4 h/wk → review 12 × 90 s = 0.3 h/wk → saves 3.1 h/wk (91%)",
    plan: billPlan)

  private static func output(_ summary: String, _ fields: [(String, String?)], actions: [String], excerpt: String? = nil) -> PlanOutput {
    PlanOutput(kind: "form_fields", summary: summary, fields: fields.map { PlanOutputField(label: $0.0, value: $0.1) },
               text: nil, actions: actions, excerpt: excerpt)
  }

  private static func instance(_ id: String, day: Int, _ h: Int, _ m: Int, ours: PlanOutput, theirs: PlanOutput,
                               matched: Int, total: Int, minutes: Double, warnings: [String] = []) -> GeneralDryRunInstance {
    let pct = Int((Double(matched) / Double(total) * 100).rounded())
    return GeneralDryRunInstance(
      instanceId: id, day: String(format: "2026-10-%02d", day), start: local(day, h, m).timeIntervalSince1970 * 1000,
      ours: ours, theirs: theirs,
      match: .init(matched: matched, total: total, value: Double(matched) / Double(total),
                   arithmetic: "\(matched) of \(total) fields the same = \(pct)%"),
      steps: .init(ours: ["p1", "p4", "p5"], theirs: ["p1", "p4", "p5"]),
      evidence: .init(eventIds: ["\(id)_ev1"], spanIds: ["\(id)_sp1"], frameIds: ["\(id)_fr1"]),
      estimate: .init(observedMinutes: minutes, reviewSeconds: 90, savedMinutes: minutes - 1.5),
      commit: .init(verb: "save bill", fields: ours.fields.compactMap { f in f.value.map { [f.label, $0] } }),
      warnings: warnings)
  }

  static let billGeneral = GeneralDryRun(
    outputType: "form_fields", variant: "a",
    instances: [
      instance("inst_bill_1", day: 22, 10, 12,
               ours: output("Bill from Northwind Supplies for 1,240.00",
                            [("Supplier", "Northwind Supplies"), ("Invoice number", "INV-20417"), ("Invoice date", "19 Oct 2026"),
                             ("Due date", "18 Nov 2026"), ("Total", "1,240.00")], actions: ["save bill"]),
               theirs: output("Bill from Northwind Supplies for 1,240.00",
                              [("Supplier", "Northwind Supplies"), ("Invoice number", "INV-20417"), ("Invoice date", "19 Oct 2026"),
                               ("Due date", "18 Nov 2026"), ("Total", "1,240.00")], actions: ["save bill"],
                              excerpt: "New bill · Northwind Supplies · INV-20417"),
               matched: 5, total: 5, minutes: 16.5),
      instance("inst_bill_2", day: 21, 15, 40,
               ours: output("Bill from Harbor Office Co for 386.50",
                            [("Supplier", "Harbor Office Co"), ("Invoice number", "H-7731"), ("Invoice date", "16 Oct 2026"),
                             ("Due date", "15 Nov 2026"), ("Total", "386.50")], actions: ["save bill"]),
               theirs: output("Bill from Harbor Office Co for 386.50",
                              [("Supplier", "Harbor Office Co"), ("Invoice number", "H-7731"), ("Invoice date", "16 Oct 2026"),
                               ("Due date", nil), ("Total", "386.50")], actions: ["save bill"],
                              excerpt: "New bill · Harbor Office Co · H-7731"),
               matched: 4, total: 5, minutes: 14.0),
      instance("inst_bill_3", day: 20, 9, 5,
               ours: output("Bill from Lumen Freight for 2,915.00, against PO-1182",
                            [("Supplier", "Lumen Freight"), ("Invoice number", "LF-0093"), ("Invoice date", "14 Oct 2026"),
                             ("Due date", "13 Nov 2026"), ("Purchase order", "PO-1182"), ("Total", "2,915.00")],
                            actions: ["match purchase order", "save bill"]),
               theirs: output("Bill from Lumen Freight for 2,915.00",
                              [("Supplier", "Lumen Freight"), ("Invoice number", "LF-0093"), ("Invoice date", "14 Oct 2026"),
                               ("Due date", "13 Nov 2026"), ("Purchase order", "PO-1182"), ("Total", "2,951.00")],
                              actions: ["match purchase order", "save bill"],
                              excerpt: "New bill · Lumen Freight · LF-0093"),
               matched: 5, total: 6, minutes: 21.0,
               warnings: ["Your total was 2,951.00; the invoice says 2,915.00."]),
    ],
    totals: .init(instances: 3, matched: 14, total: 16, agreement: 14.0 / 16.0, arithmetic: "14 of 16 fields the same across 3 bills = 88%"),
    tone: nil)

  static let billDryRun = DryRun(workflowId: "wf_bills", ranAt: local(23, 10, 52), items: [], deniedSideEffects: 3,
                                 batchHash: "b_bill_51ac", general: billGeneral)

  /// The s14 sample workflows that carry a plan (found by id, not part of the email demo's list).
  static let planWorkflows: [Workflow] = [billWorkflow]
  static let planDryRuns: [String: DryRun] = ["wf_bills": billDryRun, "wf_outreach_tools": outreachToolsDryRun]

  // MARK: tool suggestions (the founder outreach template with its tools)

  static let outreachTools: [StepTools] = [
    StepTools(stepId: "s6", capability: "email.send_bulk", need: "Send from Gmail", options: [
      ToolOption(id: "instantly", name: "Instantly", via: "composio",
                 why: "Built for sending 100+ a day: campaigns, sequences, warmed sending domains, bounce and reply tracking.",
                 setup: "about an hour", cost: "paid plan, priced per sending volume", connected: false, connectorId: nil),
      ToolOption(id: "gmail", name: "Gmail", via: "mcp", why: "Already connected. Fine for a few dozen a day from your own address.",
                 setup: "none", cost: "no extra cost", connected: true, connectorId: "gmail"),
    ], chosen: "instantly", chosenBy: "default", runsWith: "gmail",
    suggestion: "Use Instantly for sending: built for sending 100+ a day, with warmed sending domains. Connect via Composio."),
    StepTools(stepId: "s7", capability: "crm.log", need: "Log each send to the pipeline", options: [
      ToolOption(id: "hubspot", name: "HubSpot", via: "composio", why: "A CRM with deals and contact history, if your team already lives in it.",
                 setup: "minutes", cost: "free tier, paid seats", connected: false, connectorId: "hubspot"),
      ToolOption(id: "attio", name: "Attio", via: "api", why: "A light CRM that is quick to shape around an investor pipeline.",
                 setup: "minutes", cost: "free tier, paid seats", connected: false, connectorId: nil),
      ToolOption(id: "gsheets", name: "Google Sheets", via: "composio", why: "Your pipeline sheet as it is today. Nothing new to learn.",
                 setup: "minutes", cost: "no extra cost", connected: false, connectorId: "gsheets"),
    ], chosen: "gsheets", chosenBy: "default", runsWith: "gsheets",
    suggestion: "Log to Google Sheets: your pipeline sheet as it is today. Connect via Composio."),
  ]

  static let outreachToolsWorkflow: Workflow = {
    var w = outreachWorkflow
    w.id = "wf_outreach_tools"
    w.tools = outreachTools
    return w
  }()

  static let outreachToolsDryRun: DryRun = {
    var d = outreachDryRun
    d.workflowId = "wf_outreach_tools"
    d.tools = [DryRunTool(stepId: "s6", tool: "instantly", name: "Instantly", runsWith: "gmail"),
               DryRunTool(stepId: "s7", tool: "gsheets", name: "Google Sheets", runsWith: "gsheets")]
    return d
  }()
}
