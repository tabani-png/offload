import Foundation
import Testing

// S09A: HTTPBrainClient against recorded responses of the real brain (fixtures/ were captured from
// `bun run brain/src/cli.ts serve` on the fixture week), through a stub transport.

enum S09AFixture {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures")
  static func data(_ name: String) -> Data { (try? Data(contentsOf: dir.appendingPathComponent(name))) ?? Data() }
  static var repo: URL { URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent() }
}

/// Records requests and answers from a route table: "METHOD /path" → (status, body).
final class StubTransport: BrainTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var routes: [String: (Int, Data)]
  private(set) var requests: [URLRequest] = []
  var failure: URLError?

  init(_ routes: [String: (Int, Data)] = [:]) { self.routes = routes }

  func set(_ key: String, _ status: Int, _ body: Data) { lock.withLock { routes[key] = (status, body) } }

  var seen: [URLRequest] { lock.withLock { requests } }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lock.withLock { requests.append(request) }
    if let failure { throw failure }
    let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
    let (status, body) = lock.withLock { routes[key] } ?? (404, Data(#"{"error":"not_found","message":"unknown path"}"#.utf8))
    return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
  }
}

private let base = URL(string: "http://127.0.0.1:51123/")!
private let token = "tok_0123456789abcdef0123456789abcdef0123456789"

private func client(_ t: StubTransport, permissions: [PermissionState] = []) -> HTTPBrainClient {
  HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: base, token: token)), transport: t,
                  permissions: { permissions })
}

private func json(_ s: String) -> Data { Data(s.utf8) }

@Suite("S09A HTTP brain client")
struct S09AClientTests {
  @Test("every request carries the bearer token, asks for JSON and never sends an Origin")
  func headers() async throws {
    let t = StubTransport(["GET /status": (200, S09AFixture.data("status.json"))])
    _ = try await client(t).status()
    let r = try #require(t.seen.first)
    #expect(r.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
    #expect(r.value(forHTTPHeaderField: "Accept") == "application/json")
    #expect(r.value(forHTTPHeaderField: "Origin") == nil)
    #expect(r.url?.absoluteString == "http://127.0.0.1:51123/status")
    #expect(r.timeoutInterval == HTTPBrainClient.defaultTimeout)
  }

  @Test("status from the real brain maps onto the rail's observer status")
  func status() async throws {
    let t = StubTransport(["GET /status": (200, S09AFixture.data("status.json"))])
    let s = try await client(t).status()
    #expect(s.state == .stale)  // the fixture week ended yesterday: no event in the last 5 min
    #expect(s.daysStored == 7)
    #expect(s.windowDays == 30)
    #expect(s.insightsWaiting > 0)
  }

  @Test("insights from the real brain: outreach first, the brain's arithmetic verbatim")
  func insights() async throws {
    let t = StubTransport(["GET /insights": (200, S09AFixture.data("insights.json"))])
    let ins = try await client(t).insights()
    let first = try #require(ins.first)
    #expect(first.taskPhrase == "outreach emails")
    #expect(first.unitPlural == "emails")
    #expect(first.timeShare > 0.6)
    #expect(first.saving.arithmetic?.contains("saves") == true)
    #expect(first.connectors.map(\.id) == ["gmail"])
  }

  @Test("ids are encoded as one path segment")
  func segment() {
    #expect(HTTPBrainClient.segment("ins_abc") == "ins_abc")
    #expect(HTTPBrainClient.segment("a/b?c") == "a%2Fb%3Fc")
  }

  @Test("evidence path and 404 with the brain's message")
  func evidenceNotFound() async throws {
    let t = StubTransport(["GET /insights/nope/evidence": (404, json(#"{"error":"not_found","message":"unknown insight id"}"#))])
    await #expect(throws: BrainError.notFound("unknown insight id")) { try await client(t).evidence(insightId: "nope") }
  }

  @Test("401 and 403 read as the app's key not being accepted")
  func unauthorized() async {
    let t = StubTransport(["GET /status": (401, json(#"{"error":"unauthorized"}"#)),
                           "GET /insights": (403, json(#"{"error":"forbidden"}"#))])
    await #expect(throws: BrainError.unauthorized) { try await client(t).status() }
    await #expect(throws: BrainError.unauthorized) { try await client(t).insights() }
  }

  @Test("409 keeps the brain's words: connect Gmail first")
  func conflict() async {
    let t = StubTransport(["POST /workflows/wf_1/approve": (409, json(#"{"error":"conflict","message":"connect Gmail first (brain/CONNECTORS.md)"}"#))])
    do {
      _ = try await client(t).approve(workflowId: "wf_1", batchHash: String(repeating: "a", count: 64))
      Issue.record("expected a conflict")
    } catch {
      #expect(error as? BrainError == .conflict("connect Gmail first (brain/CONNECTORS.md)"))
      #expect(ReviewMessages.approvalFailed(error) == "Connect Gmail first (brain/CONNECTORS.md). Nothing was turned on or sent.")
    }
  }

  @Test("connection refused is 'Brain is not running'; a timeout says so")
  func transportErrors() async {
    let t = StubTransport()
    t.failure = URLError(.cannotConnectToHost)
    await #expect(throws: BrainError.unreachable) { try await client(t).status() }
    t.failure = URLError(.timedOut)
    await #expect(throws: BrainError.timedOut) { try await client(t).status() }
    #expect(BrainError.unreachable.userMessage.hasPrefix("Brain is not running"))
  }

  @Test("no endpoint yet: starting while the app launches it, else not running")
  func noEndpoint() async {
    let box = BrainEndpointBox()
    let c = HTTPBrainClient(endpoint: box, transport: StubTransport())
    await #expect(throws: BrainError.unreachable) { try await c.status() }
    box.starting = true
    await #expect(throws: BrainError.starting) { try await c.status() }
  }

  @Test("a 200 that is not the v1 shape is a bad response, not a crash")
  func badBody() async {
    let t = StubTransport(["GET /status": (200, json(#"{"hello":1}"#))])
    do {
      _ = try await client(t).status()
      Issue.record("expected badResponse")
    } catch {
      guard case .badResponse? = error as? BrainError else { Issue.record("got \(error)"); return }
    }
  }

  @Test("draft posts the insight id and maps the real workflow detail")
  func draft() async throws {
    let t = StubTransport(["POST /workflows/draft": (201, S09AFixture.data("workflow-draft.json"))])
    let w = try await client(t).workflow(forInsight: "ins_d4abee865ad6")
    let r = try #require(t.seen.first)
    let body = try JSONSerialization.jsonObject(with: r.httpBody ?? Data()) as? [String: String]
    #expect(body == ["insightId": "ins_d4abee865ad6"])
    #expect(r.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(w.id == "wf_d4abee865ad6")
    #expect(w.steps.contains { $0.type == .approvalGate })
    #expect(w.connectors.first { $0.id == "gmail" }?.state == .missing)
  }

  @Test("dry run sends the limit, clamped to 1...50, with the long timeout")
  func dryRun() async throws {
    let t = StubTransport(["POST /workflows/wf_d4abee865ad6/dry-run": (200, S09AFixture.data("dry-run.json"))])
    let d = try await client(t).dryRun(workflowId: "wf_d4abee865ad6", limit: 0)
    let r = try #require(t.seen.first)
    let body = try JSONSerialization.jsonObject(with: r.httpBody ?? Data()) as? [String: Int]
    #expect(body == ["limit": 1])
    #expect(r.timeoutInterval == HTTPBrainClient.dryRunTimeout)
    #expect(d.batchHash.count == 64)
    #expect(d.items.count == 2)
    #expect(d.items.allSatisfy { !$0.ourDraft.isEmpty && !$0.whatYouSent.isEmpty })
    #expect(d.deniedSideEffects > 0)
  }

  @Test("approve posts the hash, then reads the full detail back")
  func approve() async throws {
    var detail = try JSONSerialization.jsonObject(with: S09AFixture.data("workflow-draft.json")) as! [String: Any]
    detail["state"] = "needs_you"
    detail["needsYou"] = ["connect Gmail first"]
    let detailData = try JSONSerialization.data(withJSONObject: detail)
    let approve: [String: Any] = ["version": 1, "workflowId": "wf_d4abee865ad6", "batchHash": String(repeating: "b", count: 64),
                                  "kind": "dry_run", "result": "activated", "workflow": detail]
    let t = StubTransport(["POST /workflows/wf_d4abee865ad6/approve": (200, try JSONSerialization.data(withJSONObject: approve)),
                           "GET /workflows/wf_d4abee865ad6": (200, detailData)])
    let w = try await client(t).approve(workflowId: "wf_d4abee865ad6", batchHash: String(repeating: "b", count: 64))
    #expect(t.seen.map { "\($0.httpMethod!) \($0.url!.path)" } == ["POST /workflows/wf_d4abee865ad6/approve", "GET /workflows/wf_d4abee865ad6"])
    #expect(w.state == .needsYou)
    #expect(w.needsYou == ["connect Gmail first"])
    #expect(!w.steps.isEmpty)
    #expect(ReviewMessages.approved(w, now: Date()) == "Turned on. Before it can send: Connect Gmail first.")
  }

  @Test("discard is DELETE /workflows/:id")
  func discard() async throws {
    let t = StubTransport(["DELETE /workflows/wf_1": (200, json(#"{"version":1,"deleted":"wf_1"}"#))])
    try await client(t).discard(workflowId: "wf_1")
    #expect(t.seen.first?.httpMethod == "DELETE")
  }

  @Test("connector states come from GET /connectors: Gmail missing on a fresh home")
  func connectors() async throws {
    let t = StubTransport(["GET /connectors": (200, S09AFixture.data("connectors.json"))])
    let s = try await client(t).connectorStates()
    #expect(s["gmail"] == .missing)
  }

  @Test("dashboard composes /dashboard, /status, /workflows, /connectors and a timeline per stored day")
  func dashboard() async throws {
    let st = try BrainWire.decoder.decode(StatusResponse.self, from: S09AFixture.data("status.json"))
    let t = StubTransport(["GET /dashboard": (200, S09AFixture.data("dashboard.json")),
                           "GET /status": (200, S09AFixture.data("status.json")),
                           "GET /workflows": (200, S09AFixture.data("workflows.json")),
                           "GET /connectors": (200, S09AFixture.data("connectors.json")),
                           "GET /timeline": (200, S09AFixture.data("timeline-2026-10-21.json"))])
    let perms = [PermissionState(.screenRecording, granted: true)]
    let d = try await client(t, permissions: perms).dashboard()
    let days = t.seen.filter { $0.url?.path == "/timeline" }.compactMap { $0.url?.query }
    #expect(days.count == DashboardComposer.timelineDays(st).count)
    #expect(days.allSatisfy { $0.hasPrefix("day=") })
    #expect(d.observing.permissions == perms)
    #expect(d.observing.keepDays == 30)
    #expect(d.hours.measured == nil)
    #expect(d.tasks.count <= DashboardComposer.namedTasks + 1)
    #expect(!d.days.isEmpty)
  }

  @Test("s05c run times: lastRunAt and nextRunAt reach the dashboard row and the workflow schedule")
  func runTimes() throws {
    var a = try BrainWire.decoder.decode(AutomationDTO.self, from: Data(#"{"id":"wf_1","insightId":"i","name":"n","status":"approved","connectors":[],"estimatedHoursSavedPerWeek":1,"measuredHoursSavedPerWeek":null,"lastRunAt":1792800000000,"nextRunAt":1792886400000}"#.utf8))
    let row = a.toDashboardAutomation()
    #expect(row.lastRunAt == BrainWire.date(ms: 1_792_800_000_000))
    #expect(row.nextRunAt == BrainWire.date(ms: 1_792_886_400_000))
    a.lastRunAt = nil
    #expect(a.toDashboardAutomation().lastRunAt == nil)
    var w = try BrainWire.decoder.decode(WorkflowDTO.self, from: S09AFixture.data("workflow-draft.json"))
    #expect(w.toWorkflow().schedule.nextRunAt == nil)
    w.nextRunAt = 1_792_886_400_000
    #expect(w.toWorkflow().schedule.nextRunAt == BrainWire.date(ms: 1_792_886_400_000))
  }

  @Test("the pending dry-run batch's hash is the one to approve")
  func pendingHash() throws {
    var w = try BrainWire.decoder.decode(WorkflowDTO.self, from: S09AFixture.data("workflow-draft.json"))
    w.pendingBatch = BatchSummaryDTO(hash: "h1", kind: "dry_run", state: "pending", createdAt: 0, approvedAt: nil, items: 2, sent: 0)
    #expect(w.pendingDryRunHash == "h1")
    w.pendingBatch?.kind = "live"
    #expect(w.pendingDryRunHash == nil)
  }

  @Test("every error reads as one calm sentence, no status codes")
  func calmMessages() {
    let all: [BrainError] = [.notFound("x"), .unreachable, .starting, .timedOut, .unauthorized, .conflict(""),
                             .badRequest("b"), .server(500, "boom"), .badResponse("d")]
    for e in all {
      let m = e.userMessage
      #expect(m.hasSuffix("."))
      #expect(!m.contains("500") && !m.contains("boom") && !m.lowercased().contains("error"))
    }
    #expect(BrainError.sentence("connect Gmail first") == "Connect Gmail first.")
    #expect(BrainError.message(for: URLError(.badURL)) == BrainError.unreachable.userMessage)
  }
}

@Suite("S09A dashboard composer")
struct S09AComposerTests {
  private func span(_ id: String, task: String, day: String, start: Double) -> SpanDTO {
    SpanDTO(id: id, day: day, start: start, end: start + 600_000, activeMinutes: 10, app: "a", appName: "A", title: "t",
            host: "", taskId: task, eventIds: [])
  }

  @Test("the top three tasks keep their names and pastels; the rest share Everything else")
  func tasks() throws {
    let st = try BrainWire.decoder.decode(StatusResponse.self, from: S09AFixture.data("status.json"))
    let dash = try BrainWire.decoder.decode(DashboardResponse.self, from: S09AFixture.data("dashboard.json"))
    let tl = TimelineResponse(version: 1, day: "2026-10-21", activeMinutes: 100,
                              spans: [span("s1", task: "t1", day: "2026-10-21", start: 1_792_576_800_000),
                                      span("s2", task: "t5", day: "2026-10-21", start: 1_792_580_400_000)],
                              byTask: [.init(taskId: "t1", name: "Outreach", kind: "k", minutes: 60),
                                       .init(taskId: "t2", name: "Sched", kind: "k", minutes: 20),
                                       .init(taskId: "t3", name: "Sheet", kind: "k", minutes: 10),
                                       .init(taskId: "t5", name: "Slack", kind: "k", minutes: 5)])
    let d = DashboardComposer.compose(dashboard: dash, status: st, workflows: [], connectors: [:], timelines: [tl], permissions: [])
    #expect(d.tasks.map(\.id) == ["t1", "t2", "t3", "other"])
    #expect(d.tasks.map(\.tint) == [0, 1, 2, 3])
    #expect(d.days.first?.bars.map(\.taskId) == ["t1", "other"])
  }

  @Test("time on a task after its workflow was activated is drawn as automated")
  func automated() throws {
    let st = try BrainWire.decoder.decode(StatusResponse.self, from: S09AFixture.data("status.json"))
    let dash = try BrainWire.decoder.decode(DashboardResponse.self, from: S09AFixture.data("dashboard.json"))
    var wf = try BrainWire.decoder.decode(WorkflowDTO.self, from: S09AFixture.data("workflow-draft.json"))
    wf.taskId = "t1"
    wf.activatedAt = 1_792_578_000_000
    let tl = TimelineResponse(version: 1, day: "2026-10-21", activeMinutes: 20,
                              spans: [span("a", task: "t1", day: "2026-10-21", start: 1_792_576_800_000),
                                      span("b", task: "t1", day: "2026-10-21", start: 1_792_580_400_000)],
                              byTask: [.init(taskId: "t1", name: "Outreach", kind: "k", minutes: 20)])
    let d = DashboardComposer.compose(dashboard: dash, status: st, workflows: [wf], connectors: [:], timelines: [tl], permissions: [])
    #expect(d.days.first?.bars.map(\.automated) == [false, true])
    #expect(d.tasks.first?.automated == true)
  }

  @Test("timeline days: the newest stored days, oldest first, at most the 7-day analysis week")
  func timelineDays() throws {
    var st = try BrainWire.decoder.decode(StatusResponse.self, from: S09AFixture.data("status.json"))
    st.store.days = (10...20).map { .init(day: "2026-10-\($0)", source: "plain", events: 1, badLines: 0, errors: []) }.reversed()
    #expect(DashboardComposer.timelineDays(st) == (14...20).map { "2026-10-\($0)" })
  }

  @Test("connector states from GET /connectors land on the automation rows")
  func connectorStates() throws {
    let st = try BrainWire.decoder.decode(StatusResponse.self, from: S09AFixture.data("status.json"))
    let gmail = ConnectorDTO(id: "gmail", name: "Gmail", how: "gmail-mcp", reach: 1, limits: nil, role: "primary")
    let auto = AutomationDTO(id: "wf_1", insightId: "i", name: "Outreach", status: "approved", connectors: [gmail],
                             estimatedHoursSavedPerWeek: 22, measuredHoursSavedPerWeek: nil, workflowId: "wf_1",
                             state: "needs_you", needsYou: ["connect Gmail first"])
    let dash = DashboardResponse(version: 1, automations: [auto], totals: .init(estimatedHoursSavedPerWeek: 22, measuredHoursSavedPerWeek: nil), suggestions: [])
    let d = DashboardComposer.compose(dashboard: dash, status: st, workflows: [], connectors: ["gmail": .missingEnv], timelines: [], permissions: [])
    #expect(d.automations.first?.connectors.first?.state == .missingEnv)
    #expect(d.automations.first?.needsYouReason == "Connect Gmail first.")
  }
}
