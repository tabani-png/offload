import Foundation
import Testing

// S14 (app side of slices/s14-any-task-workflows): the onboarding context step, the launch flags chosen from the
// Ollama probe, decoding the additive `plan` (workflow detail) and `general` (dry run) fields of
// brain/src/api/s14-types.ts, the review copy built from them, and the plain-words rule on every new string.

private let base = URL(string: "http://127.0.0.1:51123/")!
private let token = "tok_0123456789abcdef0123456789abcdef0123456789"

private func client(_ t: StubTransport) -> HTTPBrainClient {
  HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: base, token: token)), transport: t)
}

private func json(_ s: String) -> Data { Data(s.utf8) }

private func bodyObject(_ r: URLRequest?) -> [String: Any]? {
  guard let d = r?.httpBody else { return nil }
  return try? JSONSerialization.jsonObject(with: d) as? [String: Any]
}

/// A WorkflowPlanDTO exactly as s14-types.ts names it.
let s14PlanJSON = """
{"version":2,"outputType":"form_fields","goal":"Enter each supplier invoice as a bill in Xero",
 "variants":[
  {"id":"a","label":"Every step you take","summary":"Reads the invoice, looks up the order when it names one, saves the bill.",
   "steps":[
    {"id":"p1","type":"read","title":"Read the supplier invoice","detail":"From the PDF.",
     "capability":{"need":"read supplier invoice from Preview","target":"app-preview","targetName":"Preview","capability":"file.read","role":"read","via":"local_file"},
     "gated":false,"when":null,"writesText":false,"sourceSteps":["u1"]},
    {"id":"p2","type":"decide","title":"Check for a purchase order","detail":"Most do not.","capability":null,"gated":false,"when":null,"writesText":false,"sourceSteps":["u2"]},
    {"id":"p3","type":"read","title":"Look up the purchase order","detail":"Matches lines.",
     "capability":{"need":"read purchase order in Xero","target":"app-xero","targetName":"Xero","capability":"screen.read","role":"read","via":"computer_use"},
     "gated":false,"when":"when the invoice names a purchase order","writesText":false,"sourceSteps":["u2"]},
    {"id":"p4","type":"transform","title":"Fill in the bill","detail":"Copied as is.","capability":null,"gated":false,"when":null,"writesText":false,"sourceSteps":["u3"]},
    {"id":"p5","type":"commit","title":"Create the bill in Xero","detail":"After you approve.",
     "capability":{"need":"create bill in Xero","target":"app-xero","targetName":"Xero","capability":"ui.commit","role":"send","via":"computer_use"},
     "gated":true,"when":null,"writesText":false,"sourceSteps":["u3"]}]},
  {"id":"b","label":"Core loop only","summary":"Reads the invoice and saves the bill.","steps":[
    {"id":"p1","type":"read","title":"Read the supplier invoice","detail":"From the PDF.","capability":null,"gated":false,"when":null,"writesText":false,"sourceSteps":["u1"]},
    {"id":"p5","type":"commit","title":"Create the bill in Xero","detail":"After you approve.","capability":null,"gated":true,"when":null,"writesText":false,"sourceSteps":["u3"]}]}],
 "chosen":"a","chosenBy":"dry_run",
 "probe":[
  {"variant":"a","instances":12,"matched":58,"extra":1,"missed":1,"agreement":0.9667,"arithmetic":"58 / (58 + 1 + 1) = 97%"},
  {"variant":"b","instances":12,"matched":46,"extra":0,"missed":10,"agreement":0.8214,"arithmetic":"46 / (46 + 0 + 10) = 82%"}],
 "reason":"closer to what you did: 97% vs 82% of your steps","designedBy":"claude-opus-5-5",
 "capabilities":[{"target":"app-xero","capability":"ui.commit","status":"pending","method":null,"reason":"chain not wired"}]}
"""

/// A WorkflowDetailDTO with or without the plan.
func s14Detail(plan: Bool, chosen: String = "a", chosenBy: String = "dry_run") -> Data {
  var p = s14PlanJSON
  if chosen != "a" || chosenBy != "dry_run" {
    p = p.replacingOccurrences(of: #""chosen":"a","chosenBy":"dry_run""#, with: #""chosen":"\#(chosen)","chosenBy":"\#(chosenBy)""#)
  }
  return json("""
  {"id":"wf_bills","insightId":"ins_bills","taskId":"t_bills","kind":"general","name":"Supplier bills into Xero",
   "description":"Fills in each bill and holds it for you.","state":"ready_for_review","needsYou":[],"autoRun":false,
   "createdAt":1792900000000,"activatedAt":null,"connectors":[],"estimatedHoursSavedPerWeek":3.1,"arithmetic":"saves 3.1 h/wk",
   "pendingBatch":{"hash":"b_bill","kind":"dry_run","state":"pending","createdAt":1792900000000,"approvedAt":null,"items":3,"sent":0},
   "lastDryRunAt":null,"path":"/tmp/wf_bills","skillMd":"---\\nname: supplier-bills\\n---\\n","facts":"",
   "steps":[{"id":"p1","type":"read","title":"Read","detail":"d","connector":null,"sideEffect":false,"script":null},
            {"id":"g1","type":"approval_gate","title":"You approve","detail":"d","connector":null,"sideEffect":false,"script":null},
            {"id":"p5","type":"send","title":"Create the bill","detail":"d","connector":"app-xero","sideEffect":true,"script":null}]
   \(plan ? ", \"plan\": \(p)" : "")}
  """)
}

let s14GeneralJSON = """
{"outputType":"form_fields","variant":"a",
 "instances":[{"instanceId":"inst_1","day":"2026-10-21","start":1792570000000,
   "ours":{"kind":"form_fields","summary":"Bill from Northwind for 1,240.00","fields":[{"label":"Supplier","value":"Northwind"},{"label":"Total","value":"1,240.00"},{"label":"Due date","value":"18 Nov 2026"}],"text":null,"actions":["save bill"]},
   "theirs":{"kind":"form_fields","summary":"Bill from Northwind for 1,240.00","fields":[{"label":"Supplier","value":"Northwind"},{"label":"Total","value":"1,420.00"},{"label":"Due date","value":null}],"text":null,"actions":["save bill"],"excerpt":"New bill · Northwind"},
   "match":{"matched":1,"total":3,"value":0.3333,"arithmetic":"1 of 3 fields the same = 33%"},
   "steps":{"ours":["p1","p4","p5"],"theirs":["p1","p4","p5"]},
   "evidence":{"eventIds":["e1"],"spanIds":["s1"],"frameIds":["f1"]},
   "estimate":{"observedMinutes":16.5,"reviewSeconds":90,"savedMinutes":15},
   "commit":{"verb":"save bill","fields":[["Supplier","Northwind"],["Total","1,240.00"]]},
   "warnings":[]},
  {"instanceId":"inst_2","day":"2026-10-20","start":1792480000000,
   "ours":{"kind":"ticket_reply","summary":"Reply to the customer, then mark solved","fields":[],"text":"Hi Sam, your refund is on its way.","actions":["send reply","mark solved"]},
   "theirs":{"kind":"ticket_reply","summary":"Reply, then solved","fields":[],"text":"Hi Sam, refund sent today.","actions":["send reply","mark solved"],"excerpt":"Re: refund"},
   "match":{"matched":2,"total":2,"value":1,"arithmetic":"2 of 2 actions the same = 100%"},
   "steps":{"ours":["p1"],"theirs":["p1"]},"evidence":{"eventIds":[],"spanIds":[],"frameIds":[]},
   "estimate":{"observedMinutes":4,"reviewSeconds":30,"savedMinutes":3.5},"commit":null,"warnings":["Check “14 days”: not in the ticket."]}],
 "totals":{"instances":2,"matched":3,"total":5,"agreement":0.6,"arithmetic":"3 of 5 the same = 60%"},
 "tone":{"source":"observed_text","examples":4}}
"""

/// The recorded s09a dry run (a real brain answer) with `general` added, as the s14 brain sends it.
func s14DryRun(general: Bool) throws -> Data {
  var o = try #require(try JSONSerialization.jsonObject(with: S09AFixture.data("dry-run.json")) as? [String: Any])
  if general { o["general"] = try JSONSerialization.jsonObject(with: json(s14GeneralJSON)) }
  return try JSONSerialization.data(withJSONObject: o)
}

/// The words s10e's verify greps for (case-insensitive, whole word), plus the em dash.
func s14InternalWords(_ strings: [String]) -> [String] {
  let banned = try! NSRegularExpression(pattern: #"\b(key|keys|token|MCP|SKILL|gate|json|env)\b"#, options: [.caseInsensitive])
  return strings.filter { s in
    s.contains("\u{2014}") || banned.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
  }
}

// MARK: onboarding context

@Suite("S14 onboarding context step")
struct S14ContextTests {
  @Test("four steps: the context step sits between permissions and come back, and says 3 of 4")
  func order() {
    #expect(OnboardingStep.allCases == [.watches, .permissions, .context, .comeBack])
    var f = OnboardingFlow()
    f.next(); f.next()
    #expect(f.step == .context && f.step.counter == "3 of 4")
    #expect(f.step.title == "What do you do?")
    #expect(f.primaryTitle == "Continue" && f.primary == .next && !f.isLast)
    f.back()
    #expect(f.step == .permissions)
  }

  @Test("a chip fills its field and reads as chosen; typing replaces it")
  func chips() {
    var s = ContextStepState()
    #expect(s.suggestions(.role) == ["Founder", "Recruiter", "Bookkeeper", "Support agent", "Sales ops"])
    #expect(s.suggestions(.industry) == ["Software", "Recruiting", "Accounting", "E-commerce", "Healthcare"])
    s.choose(.role, "Bookkeeper")
    #expect(s.value(.role) == "Bookkeeper" && s.isChosen(.role, "Bookkeeper") && !s.isChosen(.role, "Founder"))
    s.choose(.industry, "Accounting")
    #expect(s.context == UserContext(role: "Bookkeeper", industry: "Accounting"))
    s.set(.role, "Bookkeeper for clinics")
    #expect(!s.isChosen(.role, "Bookkeeper"))
  }

  @Test("values are one line, trimmed, inner spaces collapsed, at most 80 characters")
  func sanitise() {
    var s = ContextStepState()
    s.set(.role, "  Head of\nsupport\t  ")
    #expect(!s.value(.role).contains("\n") && !s.value(.role).contains("\t"))
    #expect(s.context?.role == "Head of support")
    s.set(.industry, String(repeating: "x", count: 200))
    #expect(s.value(.industry).count == ContextStepState.maxLength)
    #expect(s.context?.industry?.count == 80)
    #expect(ContextStepState.clean("   ") == "")
  }

  @Test("PUT body: only the keys with a value; nothing when both are empty")
  func body() throws {
    #expect(ContextStepState().context == nil)
    var s = ContextStepState()
    s.set(.role, "  ")
    #expect(s.context == nil && !s.hasValue)
    s.set(.industry, " Healthcare ")
    let c = try #require(s.context)
    #expect(c.body == ["industry": "Healthcare"])
    #expect(String(decoding: c.bodyData, as: UTF8.self) == #"{"industry":"Healthcare"}"#)
    s.set(.role, "Recruiter")
    #expect(String(decoding: try #require(s.context).bodyData, as: UTF8.self) == #"{"industry":"Healthcare","role":"Recruiter"}"#)
  }

  @Test("Continue returns what to send and moves on; Skip sends nothing and moves on")
  func continueAndSkip() {
    var f = OnboardingFlow()
    f.next(); f.next()
    f.context.choose(.role, "Founder")
    #expect(f.continueContext() == UserContext(role: "Founder", industry: nil))
    #expect(f.step == .comeBack)
    var g = OnboardingFlow()
    g.next(); g.next()
    g.context.choose(.role, "Founder")
    g.skipContext()
    #expect(g.step == .comeBack && g.context.context == nil)
    var h = OnboardingFlow()
    h.next(); h.next()
    #expect(h.continueContext() == nil)  // empty: nothing to send
    #expect(h.step == .comeBack)
    var w = OnboardingFlow()
    #expect(w.continueContext() == nil && w.step == .watches)  // only on the context step
  }

  @Test("the brain's suggestions replace the chips and a stored context fills empty fields")
  func adopt() {
    var s = ContextStepState()
    s.set(.industry, "Retail")
    s.adopt(ContextResponse(version: 1, context: UserContext(role: "Recruiter", industry: "Software"), updatedAt: 1,
                            suggestions: .init(roles: ["A", "B", "C", "D", "E", "F"], industries: [])))
    #expect(s.suggestions(.role) == ["A", "B", "C", "D", "E"])
    #expect(s.suggestions(.industry) == ContextStepState.defaultIndustries)
    #expect(s.value(.role) == "Recruiter" && s.value(.industry) == "Retail")
  }

  @Test("the outbox keeps a value while the brain is starting and drops it on a refusal")
  func outbox() {
    var o = ContextOutbox()
    o.queue(UserContext(role: "Founder"))
    #expect(o.pending?.role == "Founder")
    #expect(ContextOutbox.shouldRetry(BrainError.starting))
    #expect(ContextOutbox.shouldRetry(BrainError.unreachable))
    #expect(ContextOutbox.shouldRetry(BrainError.timedOut))
    #expect(!ContextOutbox.shouldRetry(BrainError.badRequest("unknown key")))
    #expect(!ContextOutbox.shouldRetry(BrainError.notFound("context")))
    o.settle()
    #expect(o.pending == nil)
  }

  @Test("HTTP: PUT /context sends the body, GET /context decodes ContextResponse")
  func http() async throws {
    let answer = json(#"{"version":1,"context":{"role":"Bookkeeper"},"updatedAt":1792900000000,"suggestions":{"roles":["Founder"],"industries":["Accounting"]}}"#)
    let t = StubTransport(["PUT /context": (200, answer), "GET /context": (200, answer)])
    let c = client(t)
    let r = try await c.putContext(UserContext(role: "Bookkeeper", industry: nil))
    #expect(r.context.role == "Bookkeeper" && r.context.industry == nil && r.updatedAt == 1792900000000)
    let put = try #require(t.seen.first)
    #expect(put.httpMethod == "PUT" && put.url?.path == "/context")
    #expect(put.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(bodyObject(put) as? [String: String] == ["role": "Bookkeeper"])
    let g = try await c.getContext()
    #expect(g.suggestions.roles == ["Founder"] && g.suggestions.industries == ["Accounting"])
    let empty = try BrainWire.decoder.decode(ContextResponse.self,
      from: json(#"{"version":1,"context":{},"updatedAt":null,"suggestions":{"roles":[],"industries":[]}}"#))
    #expect(empty.context.isEmpty && empty.updatedAt == nil)
  }

  @Test("mock brain: PUT then GET round-trips, and an empty value clears")
  func mock() async throws {
    MockContext.reset()
    let m: BrainClient = MockBrainClient()
    _ = try await m.putContext(UserContext(role: "  Support agent ", industry: "E-commerce"))
    let r = try await m.getContext()
    #expect(r.context == UserContext(role: "Support agent", industry: "E-commerce"))
    _ = try await m.putContext(UserContext(role: "", industry: "E-commerce"))
    #expect(try await m.getContext().context == UserContext(role: nil, industry: "E-commerce"))
    MockContext.reset()
  }
}

// MARK: launch defaults

@Suite("S14 launch defaults from the Ollama probe")
struct S14LaunchDefaultsTests {
  let healthy = OllamaProbeResult(reachable: true, models: ["llama3.2:3b", "qwen3-embedding:0.6b", "bge-m3:latest"])

  @Test("healthy with an embedding model: v2 with the Ollama embedder, captioner auto, qwen preferred")
  func healthyV2() {
    let d = UnderstandingDefaults.decide(probe: healthy, environment: [:], demo: false)
    #expect(d.version == "v2" && d.notice == nil)
    #expect(d.arguments == ["--understanding", "v2", "--embedder", "ollama", "--captioner", "auto", "--embed-model", "qwen3-embedding:0.6b"])
  }

  @Test("bge-m3 (pulled as :latest) is passed as the brain names it")
  func bge() {
    let d = UnderstandingDefaults.decide(probe: OllamaProbeResult(reachable: true, models: ["bge-m3:latest"]), environment: [:], demo: false)
    #expect(d.arguments.suffix(2) == ["--embed-model", "bge-m3"])
    #expect(UnderstandingDefaults.embedModel(in: ["BGE-M3"]) == "bge-m3")
    #expect(UnderstandingDefaults.embedModel(in: ["nomic-embed-text", "llama3"]) == nil)
  }

  @Test("not running, or no embedding model: v1, no captioner, and the needs-you line")
  func fallback() {
    for probe in [nil, OllamaProbeResult.notRunning, OllamaProbeResult(reachable: true, models: ["llama3.2:3b"]),
                  OllamaProbeResult(reachable: false, models: ["qwen3-embedding:0.6b"])] {
      let d = UnderstandingDefaults.decide(probe: probe, environment: [:], demo: false)
      #expect(d.version == "v1")
      #expect(d.arguments == ["--understanding", "v1"])
      #expect(!d.arguments.contains("--captioner") && !d.arguments.contains("--embedder"))
      #expect(d.notice == "Local models are not running: Offload uses its simpler task finder until Ollama is running.")
    }
  }

  @Test("OFFLOAD_UNDERSTANDING overrides the probe either way")
  func override() {
    let v1 = UnderstandingDefaults.decide(probe: healthy, environment: ["OFFLOAD_UNDERSTANDING": "v1"], demo: false)
    #expect(v1.arguments == ["--understanding", "v1"] && v1.notice == nil)
    let v2 = UnderstandingDefaults.decide(probe: .notRunning, environment: ["OFFLOAD_UNDERSTANDING": "v2"], demo: false)
    #expect(v2.version == "v2" && v2.arguments == ["--understanding", "v2", "--embedder", "stub"] && v2.notice == nil)
    let odd = UnderstandingDefaults.decide(probe: .notRunning, environment: ["OFFLOAD_UNDERSTANDING": "v9"], demo: false)
    #expect(odd.arguments == ["--understanding", "v1"])
  }

  @Test("the demo week never gets v2 flags, whatever the probe or the override says")
  func demo() {
    for env in [[:], ["OFFLOAD_UNDERSTANDING": "v2"]] {
      let d = UnderstandingDefaults.decide(probe: healthy, environment: env, demo: true)
      #expect(d.arguments.isEmpty && d.notice == nil && d.version == nil)
    }
  }

  @Test("GET /api/tags: model names from the answer; anything else reads as none")
  func tags() {
    let body = json(#"{"models":[{"name":"qwen3-embedding:0.6b","model":"qwen3-embedding:0.6b","size":1},{"model":"bge-m3:latest"}]}"#)
    #expect(UnderstandingDefaults.parseTags(body) == ["qwen3-embedding:0.6b", "bge-m3:latest"])
    #expect(UnderstandingDefaults.parseTags(json("not json")).isEmpty)
    #expect(UnderstandingDefaults.parseTags(json(#"{"models":"x"}"#)).isEmpty)
    #expect(UnderstandingDefaults.tagsURL.absoluteString == "http://127.0.0.1:11434/api/tags")
    #expect(UnderstandingDefaults.probeTimeout <= 1.5)
  }

  @Test("the serve argv ends with the chosen flags; none by default")
  func argv() {
    let bun = URL(fileURLWithPath: "/opt/homebrew/bin/bun"), repo = URL(fileURLWithPath: "/r"), home = URL(fileURLWithPath: "/h")
    let plain = BrainLaunch.spec(bun: bun, repo: repo, home: home, token: token, baseEnvironment: [:])
    #expect(plain.arguments == ["run", "/r/brain/src/cli.ts", "serve", "--home", "/h", "--port", "0"])
    let d = UnderstandingDefaults.decide(probe: healthy, environment: [:], demo: false)
    let s = BrainLaunch.spec(bun: bun, repo: repo, home: home, token: token, baseEnvironment: [:], model: "stub",
                             understanding: d.arguments)
    #expect(Array(s.arguments.prefix(7)) == plain.arguments)
    #expect(Array(s.arguments.suffix(d.arguments.count)) == d.arguments)
    #expect(s.arguments.contains("--model"))
  }
}

// MARK: plan + general dry run

@Suite("S14 plan and general dry run decoding")
struct S14PlanTests {
  @Test("the workflow detail decodes `plan` field for field; the email detail has none")
  func decodePlan() throws {
    let dto = try BrainWire.decoder.decode(WorkflowDTO.self, from: s14Detail(plan: true))
    let w = dto.toWorkflow(dryRunHash: dto.pendingDryRunHash)
    let plan = try #require(w.plan)
    #expect(plan.version == 2 && plan.outputType == "form_fields" && plan.output == .formFields)
    #expect(plan.variants.map(\.id) == ["a", "b"] && plan.chosen == "a" && !plan.pickedByYou)
    #expect(plan.chosenVariant?.steps.map(\.kind) == [.read, .decide, .read, .transform, .commit])
    let commit = try #require(plan.chosenVariant?.steps.last)
    #expect(commit.gated && commit.capability?.need == "create bill in Xero" && commit.capability?.targetName == "Xero")
    #expect(commit.capability?.capability == "ui.commit" && commit.capability?.role == "send" && commit.capability?.via == "computer_use")
    #expect(plan.chosenVariant?.steps[2].when == "when the invoice names a purchase order")
    #expect(plan.chosenVariant?.steps[1].capability == nil)
    #expect(plan.score("b")?.missed == 10 && plan.probe.count == 2)
    #expect(plan.capabilities.first?.status == "pending" && plan.capabilities.first?.method == nil)
    #expect(plan.designedBy == "claude-opus-5-5")
    #expect(w.steps.map(\.type) == [.read, .approvalGate, .send] && w.batchHash == "b_bill")
    let email = try BrainWire.decoder.decode(WorkflowDTO.self, from: s14Detail(plan: false))
    #expect(email.toWorkflow().plan == nil)
    let real = try BrainWire.decoder.decode(WorkflowsResponse.self, from: S09AFixture.data("workflows.json"))
    #expect(real.workflows.allSatisfy { $0.plan == nil })
  }

  @Test("an unknown step type from a newer brain reads as a read, not a decode failure")
  func unknownType() throws {
    let s = try BrainWire.decoder.decode(PlanStep.self, from: json(
      #"{"id":"x","type":"wait","title":"t","detail":"d","capability":null,"gated":false,"when":null,"writesText":false,"sourceSteps":[]}"#))
    #expect(s.kind == .read)
  }

  @Test("the dry run decodes `general`; the recorded email dry run has none")
  func decodeGeneral() throws {
    let plain = try BrainWire.decoder.decode(DryRunResponse.self, from: s14DryRun(general: false)).toDryRun()
    #expect(plain.general == nil && !plain.items.isEmpty)
    let d = try BrainWire.decoder.decode(DryRunResponse.self, from: s14DryRun(general: true)).toDryRun()
    let g = try #require(d.general)
    #expect(g.outputType == "form_fields" && g.variant == "a" && g.instances.count == 2)
    let i = g.instances[0]
    #expect(i.ours.fields.map(\.label) == ["Supplier", "Total", "Due date"])
    #expect(i.theirs.fields[2].value == nil && i.theirs.excerpt == "New bill · Northwind" && i.ours.excerpt == nil)
    #expect(i.match.matched == 1 && i.match.total == 3 && i.match.arithmetic == "1 of 3 fields the same = 33%")
    #expect(i.commit?.verb == "save bill" && i.commit?.fields.first == ["Supplier", "Northwind"])
    #expect(i.evidence.frameIds == ["f1"] && i.estimate.reviewSeconds == 90 && i.steps.ours.count == 3)
    #expect(g.instances[1].commit == nil && g.instances[1].ours.text == "Hi Sam, your refund is on its way.")
    #expect(g.totals.arithmetic == "3 of 5 the same = 60%" && g.tone?.source == "observed_text" && g.tone?.examples == 4)
  }

  @Test("review copy for the plan: badges, needs, the approval lock, conditions, the choice with probe agreement")
  func planCopy() throws {
    let dto = try BrainWire.decoder.decode(WorkflowDTO.self, from: s14Detail(plan: true))
    let c = PlanCopy(plan: try #require(dto.plan))
    #expect(c.steps.map(\.badge) == ["Read", "Decide", "Read", "Transform", "Commit"])
    #expect(c.steps.map(\.number) == ["1", "2", "3", "4", "5"])
    #expect(c.steps[0].need == "read supplier invoice from Preview" && c.steps[0].place == "Preview")
    #expect(c.steps[1].need == nil && c.steps[1].place == "On this Mac")
    #expect(c.steps[2].when == "Runs when the invoice names a purchase order")
    #expect(c.steps.filter(\.approval).map(\.id) == ["p5"])
    #expect(c.stepsTrailing == "5 steps · nothing is saved before you approve")
    #expect(c.choices.map(\.title) == ["Every step you take · 97% of your steps", "Core loop only · 82% of your steps"])
    #expect(c.choices.map(\.chosen) == [true, false] && c.choices.map(\.number) == [1, 2])
    #expect(c.reason == "Picked by the dry run: closer to what you did: 97% vs 82% of your steps.")
    #expect(!c.writesText)
    let user = PlanCopy(plan: try #require(try BrainWire.decoder.decode(WorkflowDTO.self, from: s14Detail(plan: true, chosen: "b", chosenBy: "user")).plan))
    #expect(user.choices.map(\.chosen) == [false, true])
    #expect(user.steps.map(\.badge) == ["Read", "Commit"] && user.reason.hasPrefix("You picked this one."))
  }

  @Test("review copy for the general dry run: label and value rows, hidden values, text, actions, match colour")
  func generalCopy() throws {
    let d = try BrainWire.decoder.decode(DryRunResponse.self, from: s14DryRun(general: true)).toDryRun()
    let c = GeneralDryRunCopy(try #require(d.general), ranAt: d.ranAt)
    let a = c.items[0]
    #expect(a.ours.title == "What Offload would do" && a.theirs.title.hasPrefix("What you did · "))
    #expect(a.theirs.rows[2].value == "filled, value not visible" && a.theirs.rows[2].hidden)
    #expect(a.theirs.rows[1].differs && !a.theirs.rows[0].differs && !a.theirs.rows[2].differs)
    #expect(a.matchChip == "1 of 3 match" && a.matchLine == "1 of 3 fields the same = 33%" && a.matchRole == .needsYou)
    #expect(a.ours.actions == ["Save bill"] && a.ours.text == nil)
    let b = c.items[1]
    #expect(b.matchRole == .done && b.ours.text == "Hi Sam, your refund is on its way." && b.ours.rows.isEmpty)
    #expect(b.ours.actions == ["Send reply", "Mark solved"] && b.warnings.count == 1)
    #expect(c.totals == "3 of 5 the same = 60%" && c.trailing.hasPrefix("2 real examples from last week"))
  }

  @Test("HTTP: POST /workflows/:id/plan {variant} returns the detail with the plan you kept")
  func choose() async throws {
    let t = StubTransport(["POST /workflows/wf_bills/plan": (200, s14Detail(plan: true, chosen: "b", chosenBy: "user"))])
    let w = try await client(t).choosePlan(workflowId: "wf_bills", variant: "b")
    #expect(w.plan?.chosen == "b" && w.plan?.pickedByYou == true && w.batchHash == "b_bill")
    let r = try #require(t.seen.first)
    #expect(r.httpMethod == "POST" && bodyObject(r) as? [String: String] == ["variant": "b"])
  }

  @Test("keys 1 and 2 pick the variants; nothing without a plan")
  func keys() throws {
    let plan = MockBrainClient.billPlan
    #expect(PlanChoice.variant(forKey: "1", plan: plan) == "a")
    #expect(PlanChoice.variant(forKey: "2", plan: plan) == "b")
    #expect(PlanChoice.variant(forKey: "3", plan: plan) == nil)
    #expect(PlanChoice.variant(forKey: "r", plan: plan) == nil)
    #expect(PlanChoice.variant(forKey: "1", plan: nil) == nil)
  }

  @Test("mock brain: the bill workflow has a plan, a general dry run, and keeps your pick")
  func mock() async throws {
    MockContext.reset()
    let m: BrainClient = MockBrainClient()
    let w = try await m.workflow(id: "wf_bills")
    #expect(w.plan?.chosen == "a" && MockBrainClient.sampleWorkflows.allSatisfy { $0.plan == nil })
    let d = try await m.dryRun(workflowId: "wf_bills", limit: 2)
    #expect(d.general?.instances.count == 2 && d.items.isEmpty)
    let kept = try await m.choosePlan(workflowId: "wf_bills", variant: "b")
    #expect(kept.plan?.chosen == "b" && kept.plan?.chosenBy == "user")
    #expect(try await m.workflow(id: "wf_bills").plan?.chosen == "b")
    await #expect(throws: BrainError.self) { _ = try await m.choosePlan(workflowId: "wf_outreach", variant: "a") }
    MockContext.reset()
    // The email demo is unchanged.
    #expect(try await m.dryRun(workflowId: "wf_outreach", limit: 5).general == nil)
  }

  @Test("a plan workflow's schedule counts items, not emails")
  func schedule() {
    #expect(ReviewCopy(workflow: MockBrainClient.billWorkflow, dryRun: nil).schedule == "When a new invoice arrives, up to 10 items a batch.")
    #expect(ReviewCopy(workflow: MockBrainClient.outreachWorkflow, dryRun: nil).schedule.contains("emails a batch"))
  }
}

// MARK: copy

@Suite("S14 copy has no internal words")
struct S14CopyTests {
  @Test("onboarding context, the fallback line, the plan and the general dry run say it plainly")
  func plain() throws {
    let plan = PlanCopy(plan: MockBrainClient.billPlan)
    let general = GeneralDryRunCopy(MockBrainClient.billGeneral, ranAt: MockBrainClient.reviewNow)
    let context = [ContextStepState.title, ContextStepState.intro, ContextStepState.helper, OnboardingStep.context.title]
      + ContextStepState.Field.allCases.flatMap { [$0.label, $0.placeholder] }
      + ContextStepState.defaultRoles + ContextStepState.defaultIndustries
    let all = context + [UnderstandingDefaults.fallbackNotice] + plan.allStrings + general.allStrings
      + ReviewCopy(workflow: MockBrainClient.billWorkflow, dryRun: MockBrainClient.billDryRun).allStrings
    #expect(s14InternalWords(all).isEmpty, "internal words: \(s14InternalWords(all))")
    #expect(!all.contains { PlainWords.banned.contains(where: $0.lowercased().contains) })
    #expect(s14InternalWords(["the approval gate"]) == ["the approval gate"])  // the check itself bites
  }

  @Test("the helper line says local only and no number changes")
  func helper() {
    #expect(ContextStepState.helper.contains("on this Mac") && ContextStepState.helper.contains("never changes a number"))
  }
}

// MARK: Claude captioner opt-in

@Suite("S14 Claude captioner opt-in")
struct S14ClaudeVisionTests {
  let healthy = OllamaProbeResult(reachable: true, models: ["qwen3-embedding:0.6b"])

  private func freshDefaults() -> UserDefaults {
    let name = "s14.tests.\(UUID().uuidString)"
    let d = UserDefaults(suiteName: name)!
    d.removePersistentDomain(forName: name)
    return d
  }

  @Test("the setting is off by default and persists under its own key")
  func setting() {
    let d = freshDefaults()
    #expect(ClaudeVisionSetting.load(d).enabled == false)
    var s = ClaudeVisionSetting.load(d)
    s.toggle()
    s.save(d)
    #expect(ClaudeVisionSetting.load(d).enabled && d.bool(forKey: "ai.offload.claudeVision.v1"))
    #expect(ClaudeVisionSetting.defaultsKey == "ai.offload.claudeVision.v1")
  }

  @Test("off: no Claude flag (v2 asks for auto, v1 has no captioner)")
  func off() {
    #expect(!UnderstandingDefaults.decide(probe: healthy, environment: [:], demo: false).arguments.contains("claude"))
    #expect(!UnderstandingDefaults.decide(probe: .notRunning, environment: [:], demo: false).arguments.contains("--captioner"))
  }

  @Test("on: --captioner claude in v2 and in v1, exactly once")
  func on() {
    let v2 = UnderstandingDefaults.decide(probe: healthy, environment: [:], demo: false, claudeVision: true)
    #expect(v2.arguments == ["--understanding", "v2", "--embedder", "ollama", "--embed-model", "qwen3-embedding:0.6b", "--captioner", "claude"])
    let v1 = UnderstandingDefaults.decide(probe: .notRunning, environment: [:], demo: false, claudeVision: true)
    #expect(v1.arguments == ["--understanding", "v1", "--captioner", "claude"])
    #expect(v1.notice != nil)  // the simpler task finder still says so
    let forced = UnderstandingDefaults.decide(probe: .notRunning, environment: ["OFFLOAD_UNDERSTANDING": "v2"], demo: false, claudeVision: true)
    #expect(forced.arguments.filter { $0 == "--captioner" }.count == 1 && forced.arguments.last == "claude")
  }

  @Test("demo week: never a captioner flag, opted in or not")
  func demo() {
    #expect(UnderstandingDefaults.decide(probe: healthy, environment: [:], demo: true, claudeVision: true).arguments.isEmpty)
  }

  @Test("status captioner decodes usage and needsYou as optional; older brains decode without them")
  func status() throws {
    var o = try #require(try JSONSerialization.jsonObject(with: S09AFixture.data("status.json")) as? [String: Any])
    let old = try BrainWire.decoder.decode(StatusResponse.self, from: try JSONSerialization.data(withJSONObject: o))
    #expect(old.captioner?.usage == nil && old.captioner?.needsYouLine == nil)
    o["captioner"] = try JSONSerialization.jsonObject(with: json(
      #"{"enabled":true,"captioner":"claude","model":"claude-sonnet-5-5","healthy":true,"queueDepth":0,"processed":42,"failed":0,"skipped":0,"lastPollAt":null,"lastCaptionAt":null,"lastLatencyMs":null,"lastError":null,"usage":{"frames":42,"inputTokens":61200,"outputTokens":8400,"lastFrame":null},"needsYou":"sign in to your Claude account"}"#))
    let s = try BrainWire.decoder.decode(StatusResponse.self, from: try JSONSerialization.data(withJSONObject: o))
    let c = try #require(s.captioner)
    #expect(c.isClaude && c.usage?.frames == 42 && c.usage?.lastFrame == nil)
    #expect(c.usageLine == "Claude read 42 screens · 61,200 tokens in, 8,400 out")
    #expect(c.needsYouLine == "Sign in to your Claude account.")
    let ollama = CaptionerStatus(captioner: "ollama", usage: .init(frames: 3, inputTokens: 1, outputTokens: 1, lastFrame: nil))
    #expect(ollama.usageLine == nil)
    #expect(CaptionerStatus(captioner: "claude", needsYou: "  ").needsYouLine == nil)
  }

  @Test("the toggle says exactly what was agreed, in plain words")
  func copy() {
    #expect(ClaudeVisionSetting.label == "Read screens with Claude (your company account). Images are masked first.")
    #expect(s14InternalWords([ClaudeVisionSetting.label, ClaudeVisionSetting.appliesNextLaunch]).isEmpty)
  }
}

// MARK: tool suggestions + model router

let s14ToolsJSON = """
[{"stepId":"s6","capability":"email.send_bulk","need":"Send from Gmail","options":[
  {"id":"instantly","name":"Instantly","via":"composio","why":"Built for sending 100+ a day.","setup":"about an hour","cost":"paid plan","connected":false,"connectorId":null},
  {"id":"gmail","name":"Gmail","via":"mcp","why":"Already connected.","setup":"none","cost":"no extra cost","connected":true,"connectorId":"gmail"}],
  "chosen":"instantly","chosenBy":"default","runsWith":"gmail","suggestion":"Use Instantly for sending: built for 100+ a day. Connect via Composio."},
 {"stepId":"p5","capability":"crm.log","need":"create bill in Xero","options":[
  {"id":"xero","name":"Xero","via":"api","why":"Your books.","setup":"minutes","cost":"no extra cost","connected":true,"connectorId":null}],
  "chosen":"xero","chosenBy":"user","runsWith":"xero","suggestion":"Use Xero: your books."}]
"""

@Suite("S14 tool suggestions and the model router")
struct S14ToolsTests {
  private func detailWithTools() throws -> Data {
    var o = try #require(try JSONSerialization.jsonObject(with: s14Detail(plan: false)) as? [String: Any])
    o["tools"] = try JSONSerialization.jsonObject(with: json(s14ToolsJSON))
    return try JSONSerialization.data(withJSONObject: o)
  }

  @Test("the detail decodes `tools` field for field; older details have none")
  func decode() throws {
    let w = try BrainWire.decoder.decode(WorkflowDTO.self, from: detailWithTools()).toWorkflow()
    #expect(w.tools.map(\.stepId) == ["s6", "p5"])
    let t = w.tools[0]
    #expect(t.capability == "email.send_bulk" && t.chosen == "instantly" && t.runsWith == "gmail" && t.chosenBy == "default")
    #expect(t.options[0].via == "composio" && t.options[0].setup == "about an hour" && t.options[0].connectorId == nil)
    #expect(t.options[1].connected && t.chosenOption?.name == "Instantly")
    #expect(try BrainWire.decoder.decode(WorkflowDTO.self, from: s14Detail(plan: false)).toWorkflow().tools.isEmpty)
  }

  @Test("copy: the suggestion, setup in words, cost, connected, chosen, and the runs-with line")
  func copy() throws {
    let w = try BrainWire.decoder.decode(WorkflowDTO.self, from: detailWithTools()).toWorkflow()
    let c = ToolsCopy(w.tools[0])
    #expect(c.suggestion == "Use Instantly for sending: built for 100+ a day. Connect via Composio.")
    #expect(c.options.map(\.detail) == ["About an hour to set up · paid plan", "No setup · no extra cost"])
    #expect(c.options.map(\.chosen) == [true, false] && c.options.map(\.connected) == [false, true])
    #expect(c.runsWithLine == "Sends through Gmail until Instantly is connected.")
    #expect(ToolsCopy(w.tools[1]).runsWithLine == nil && ToolsCopy.setup("minutes") == "A few minutes to set up")
    let review = ReviewCopy(workflow: w, dryRun: nil)
    #expect(review.tools["s6"]?.stepId == "s6" && review.tools["p5"] != nil)
  }

  @Test("the dry run decodes `tools` and its header says With …")
  func dryRunWith() throws {
    var o = try #require(try JSONSerialization.jsonObject(with: s14DryRun(general: false)) as? [String: Any])
    o["tools"] = try JSONSerialization.jsonObject(with: json(
      #"[{"stepId":"s6","tool":"instantly","name":"Instantly","runsWith":"gmail"},{"stepId":"s7","tool":"gsheets","name":"Google Sheets","runsWith":"gsheets"},{"stepId":"s8","tool":"gsheets","name":"Google Sheets","runsWith":"gsheets"}]"#))
    let d = try BrainWire.decoder.decode(DryRunResponse.self, from: try JSONSerialization.data(withJSONObject: o)).toDryRun()
    #expect(d.tools?.count == 3 && d.tools?[0].runsWith == "gmail")
    #expect(ToolsCopy.with(d.tools) == "With Instantly and Google Sheets")
    #expect(ToolsCopy.with(nil) == nil && ToolsCopy.with([]) == nil)
    let c = ReviewCopy(workflow: MockBrainClient.outreachWorkflow, dryRun: d)
    #expect(c.dryRunTrailing.hasPrefix("With Instantly and Google Sheets · "))
    #expect(!ReviewCopy(workflow: MockBrainClient.outreachWorkflow, dryRun: MockBrainClient.outreachDryRun).dryRunTrailing.hasPrefix("With"))
  }

  @Test("keyboard: T walks the rows from the chosen option, ← → clamp, ↩ picks only a different option")
  func focus() {
    let tools = MockBrainClient.outreachTools
    var f = ToolFocus.next(after: nil, tools: tools)
    #expect(f == ToolFocus(stepId: "s6", index: 0))
    f = ToolFocus.next(after: f, tools: tools)
    #expect(f == ToolFocus(stepId: "s7", index: 2))  // Google Sheets is chosen
    #expect(ToolFocus.next(after: f, tools: tools)?.stepId == "s6")  // wraps
    var g = ToolFocus(stepId: "s7", index: 2)
    #expect(g.pick(tools) == nil)
    g.move(1, tools: tools)
    #expect(g.index == 2)
    g.move(-1, tools: tools)
    #expect(g.index == 1 && g.pick(tools)?.toolId == "attio")
    g.move(-5, tools: tools)
    #expect(g.index == 0)
    #expect(ToolFocus.next(after: nil, tools: []) == nil)
  }

  @Test("HTTP: POST /workflows/:id/tools {stepId, toolId} returns the detail")
  func http() async throws {
    let t = StubTransport(["POST /workflows/wf_bills/tools": (200, try detailWithTools())])
    let w = try await client(t).chooseTool(workflowId: "wf_bills", stepId: "s6", toolId: "gmail")
    #expect(w.tools.count == 2)
    let r = try #require(t.seen.first)
    #expect(r.httpMethod == "POST" && bodyObject(r) as? [String: String] == ["stepId": "s6", "toolId": "gmail"])
  }

  @Test("mock brain keeps your tool and refuses an unknown one")
  func mock() async throws {
    MockContext.reset()
    let m: BrainClient = MockBrainClient()
    let w = try await m.chooseTool(workflowId: "wf_outreach_tools", stepId: "s6", toolId: "gmail")
    let s6 = try #require(w.tools.first { $0.stepId == "s6" })
    #expect(s6.chosen == "gmail" && s6.chosenBy == "user" && s6.runsWith == "gmail")
    await #expect(throws: BrainError.self) { _ = try await m.chooseTool(workflowId: "wf_outreach_tools", stepId: "s6", toolId: "nope") }
    MockContext.reset()
    #expect(MockBrainClient.outreachWorkflow.tools.isEmpty)  // the email demo is unchanged
  }

  @Test("status `models` decodes as optional; the spend line, budget, local captions and needs-you")
  func models() throws {
    var o = try #require(try JSONSerialization.jsonObject(with: S09AFixture.data("status.json")) as? [String: Any])
    #expect(try BrainWire.decoder.decode(StatusResponse.self, from: try JSONSerialization.data(withJSONObject: o)).models == nil)
    o["models"] = try JSONSerialization.jsonObject(with: json(
      #"{"backend":"api","metered":true,"month":"2026-10","spentUsd":1.24,"budgetUsd":20,"captionsLocal":true,"blocked":false,"needsYou":"budget nearly used","routes":{"draft":{"calls":12,"inputTokens":4000,"outputTokens":900,"cacheReadTokens":0,"costUsd":0.5,"escalations":1,"tier":"cheap","model":"claude-sonnet-5-5"}}}"#))
    let m = try #require(try BrainWire.decoder.decode(StatusResponse.self, from: try JSONSerialization.data(withJSONObject: o)).models)
    #expect(m.spendLine == "Claude this month: $1.24 of $20 budget")
    #expect(m.captionsLine == "Screens are read on this Mac to stay within the budget.")
    #expect(m.needsYouLine == "Budget nearly used." && m.routes?["draft"]?.calls == 12)
    #expect(ModelsStatus(backend: "api", metered: true, spentUsd: 0.5, budgetUsd: nil).spendLine == "Claude this month: $0.50, no budget set")
    #expect(ModelsStatus(backend: "api", metered: true, spentUsd: 3, budgetUsd: 12.5).spendLine == "Claude this month: $3.00 of $12.50 budget")
    #expect(ModelsStatus(backend: "api", captionsLocal: false).captionsLine == nil)
    #expect(ModelsStatus(backend: "stub").spendLine.hasPrefix("Sample model"))
  }

  @Test("every new string is plain")
  func plain() {
    let tools = MockBrainClient.outreachTools.flatMap { ToolsCopy($0).allStrings }
    let models = [ModelsStatus(backend: "api", metered: true, spentUsd: 1, budgetUsd: 20).spendLine, ModelsStatus.captionsLocalLine,
                  ModelsStatus(metered: false).spendLine, ModelsStatus(backend: "stub").spendLine]
    #expect(s14InternalWords(tools + models).isEmpty, "internal words: \(s14InternalWords(tools + models))")
  }
}
