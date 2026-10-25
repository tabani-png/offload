import Foundation
import Testing

// S09A on the s05c routes: tone card, SKILL.md text edits and GET /observer (fixtures recorded from the real brain).

private let ep = BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5/")!, token: String(repeating: "t", count: 43)))

@Suite("S09A tone, skill and observer routes")
struct S09AEditsTests {
  @Test("GET tone decodes the real card (none built yet) and names the bucket")
  func tone() async throws {
    let t = StubTransport(["GET /workflows/wf_d4abee865ad6/tone": (200, S09AFixture.data("tone.json"))])
    let c = try await HTTPBrainClient(endpoint: ep, transport: t).toneCard(workflowId: "wf_d4abee865ad6")
    #expect(c.text == nil && !c.edited)
    #expect(c.bucketLabel == "Investor outreach")
    #expect(c.maxBytes == 16_384)
  }

  @Test("PUT tone sends exactly { text }")
  func saveTone() async throws {
    var card = try JSONSerialization.jsonObject(with: S09AFixture.data("tone.json")) as! [String: Any]
    card["text"] = "- Short."
    card["edited"] = true
    let t = StubTransport(["PUT /workflows/wf_1/tone": (200, try JSONSerialization.data(withJSONObject: card))])
    let c = try await HTTPBrainClient(endpoint: ep, transport: t).saveToneCard(workflowId: "wf_1", text: "- Short.")
    let body = try JSONSerialization.jsonObject(with: t.seen.first?.httpBody ?? Data()) as? [String: String]
    #expect(body == ["text": "- Short."])
    #expect(c.text == "- Short." && c.edited)
    #expect(ToneCard.fits("abc", maxBytes: 3) && !ToneCard.fits("é", maxBytes: 1))
  }

  @Test("GET skill decodes the real SKILL.md, steps, gates and limits")
  func skill() async throws {
    let t = StubTransport(["GET /workflows/wf_d4abee865ad6/skill": (200, S09AFixture.data("skill.json"))])
    let d = try await HTTPBrainClient(endpoint: ep, transport: t).skill(workflowId: "wf_d4abee865ad6")
    #expect(d.skillMd.hasPrefix("---"))
    #expect(!d.gates.isEmpty)
    #expect(d.steps.contains { $0.isGate && d.gates.contains($0.id) })
    #expect(d.limits.titleChars > 0)
  }

  @Test("skill edits send only what changed and never a gate step")
  func skillDiff() throws {
    let old = try BrainWire.decoder.decode(SkillDoc.self, from: S09AFixture.data("skill.json"))
    var new = old
    #expect(SkillEdit.diff(from: old, to: new).isEmpty)
    new.description = "Drafts investor emails."
    let first = new.steps.firstIndex { !$0.isGate }!
    new.steps[first].title = "Read the list"
    let gate = new.steps.firstIndex(where: \.isGate)!
    new.steps[gate].title = "Skip the gate"
    let e = SkillEdit.diff(from: old, to: new)
    #expect(e.description == "Drafts investor emails.")
    #expect(e.steps.count == 1 && e.steps[0].id == old.steps[first].id && e.steps[0].title == "Read the list" && e.steps[0].detail == nil)
    let body = e.body
    #expect(Set(body.keys) == ["description", "steps"])
    #expect((body["steps"] as? [[String: String]])?.first == ["id": old.steps[first].id, "title": "Read the list"])
  }

  @Test("the sheet catches what the brain would refuse: blank, too long, headings, a newline in a title")
  func skillProblems() throws {
    var d = try BrainWire.decoder.decode(SkillDoc.self, from: S09AFixture.data("skill.json"))
    #expect(SkillEdit.problems(d).isEmpty)
    let i = d.steps.firstIndex { !$0.isGate }!
    d.description = "# Heading"
    d.steps[i].title = "two\nlines"
    d.steps[i].detail = String(repeating: "x", count: d.limits.detailChars + 1)
    let p = SkillEdit.problems(d)
    #expect(p.contains { $0.contains("headings") })
    #expect(p.contains { $0.contains("one line") })
    #expect(p.contains { $0.contains("longer than") })
    d.steps[i].title = "  "
    #expect(SkillEdit.problems(d).contains { $0.contains("blank") })
  }

  @Test("a 400 from PUT skill keeps the brain's reason")
  func skillRefused() async {
    let t = StubTransport(["PUT /workflows/wf_1/skill": (400, Data(#"{"error":"bad_request","message":"steps[0].id must name an existing step (steps cannot be added)"}"#.utf8))])
    await #expect(throws: BrainError.badRequest("steps[0].id must name an existing step (steps cannot be added)")) {
      try await HTTPBrainClient(endpoint: ep, transport: t).saveSkill(workflowId: "wf_1", edit: SkillEdit(description: "x", steps: []))
    }
  }

  @Test("GET /observer: the real passthrough gives the permission rows")
  func observer() async throws {
    let t = StubTransport(["GET /observer": (200, S09AFixture.data("observer.json"))])
    let c = HTTPBrainClient(endpoint: ep, transport: t, permissions: { PermissionState.unknownRows })
    let r = try #require(try await c.observer())
    #expect(r.keepDays == 7)
    #expect(await c.permissionRows().map(\.grant) == [.granted, .granted, .granted])
  }

  @Test("observer unavailable or an older brain (404): fall back to the app's own CLI read")
  func observerFallback() async throws {
    let unavailable = Data(#"{"version":1,"available":false,"bin":"/x","checkedAt":0,"error":"no binary","permissions":null,"status":null}"#.utf8)
    let fallback = [PermissionState(.screenRecording, granted: false)]
    let t1 = StubTransport(["GET /observer": (200, unavailable)])
    #expect(try await HTTPBrainClient(endpoint: ep, transport: t1).observer() == nil)
    #expect(await HTTPBrainClient(endpoint: ep, transport: t1, permissions: { fallback }).permissionRows() == fallback)
    let t2 = StubTransport()
    #expect(try await HTTPBrainClient(endpoint: ep, transport: t2).observer() == nil)
  }

  @Test("the mock keeps working through the protocol defaults")
  func mockDefaults() async throws {
    let m: BrainClient = MockBrainClient()
    let id = MockBrainClient.outreachWorkflow.id
    #expect(try await m.toneCard(workflowId: id).text == MockBrainClient.outreachWorkflow.toneCard)
    let d = try await m.skill(workflowId: id)
    #expect(d.gates.count == 1)
    #expect(try await m.saveSkill(workflowId: id, edit: SkillEdit(description: "New", steps: [])).description == "New")
    #expect(try await m.observer() == nil)
  }
}
