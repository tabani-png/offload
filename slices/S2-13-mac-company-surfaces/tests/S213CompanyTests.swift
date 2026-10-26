import Foundation
import Testing

// S2-13: Mac company surfaces. Written before the code (slices/S2-13-mac-company-surfaces/SPEC.md). The app talks
// only to the local brain's company-sync routes (brain/API.md "Company sync", S2-02); the notice it shows is the
// control plane's notice (S2-08) as the brain relays it in `/sync/status`. These tests fake that boundary at HTTP
// with responses recorded from the contract (S213Contract), never a live brain or control plane.

// MARK: recorded contract

enum S213Contract {
  static let base = URL(string: "http://127.0.0.1:47011")!
  static let control = "https://acme.offload.example"
  static let noticeId = "3f6c2a1e-9b0d-4c4e-8f57-2d1a6b7c9e10"
  static let tenantId = "7d1e0c8a-5b2f-4a3e-9c61-0f4b2d8e6a35"
  static let personId = "0a9b8c7d-6e5f-4a3b-9c2d-1e0f2a3b4c5d"
  static let hash = String(repeating: "ab", count: 32)

  static let markdown = """
  # How Offload works at Acme Robotics

  Offload helps you hand repetitive work to automations. This notice says what the company sees.

  ## What we see
  - How many times each shared workflow ran, and whether it worked
  - Time saved, as **numbers** only

  ## What we never see
  - Your screen, keystrokes or window titles
  - Email recipients, subjects or bodies

  1. You can pause sharing at any time.
  2. You can see your own data on the web.
  """

  static func notice(features: [String] = ["workflow_metrics"]) -> String {
    let f = features.map { "\"\($0)\"" }.joined(separator: ",")
    let md = String(data: try! JSONSerialization.data(withJSONObject: [markdown], options: []), encoding: .utf8)!
      .dropFirst().dropLast()
    return "{\"noticeVersionId\":\"\(noticeId)\",\"title\":\"Acme Robotics monitoring notice\",\"markdown\":\(md),\"features\":[\(f)]}"
  }

  /// `GET /sync/status` (SyncStatusDTO). `tenantName` is optional: the brain adds it when the control plane names
  /// the tenant; the app falls back to the control plane's host.
  static func status(state: String, notice: String? = nil, acknowledged: Bool = false, features: String? = nil,
                     tenantName: String? = "Acme Robotics", lastFlushAt: String = "null", paused: Bool = false,
                     controlUrl: String? = control, failures: Int = 0, lastError: String? = nil) -> Data {
    let connected = state == "connected" || state == "paused"
    let noticeField = connected ? (notice.map { "{\"required\":\($0),\"acknowledged\":\(acknowledged)}" } ?? "{\"required\":null,\"acknowledged\":false}") : "null"
    let tn = tenantName.map { ",\"tenantName\":\"\($0)\"" } ?? ""
    let cu = controlUrl.map { "\"\($0)\"" } ?? "null"
    let le = lastError.map { "\"\($0)\"" } ?? "null"
    let s = """
    {"state":"\(state)","controlUrl":\(cu),"configError":null,"deviceId":\(connected ? "\"01JAZ3S5D0V1CE0000000000AA\"" : "null"),\
    "personId":\(connected ? "\"\(personId)\"" : "null"),"tenantId":\(connected ? "\"\(tenantId)\"" : "null")\(tn),\
    "enrolledAt":\(connected ? "1761400000000" : "null"),"paused":\(paused),"seq":3,"notice":\(noticeField),\
    "features":\(features ?? (connected ? "{\"workflow_metrics\":true,\"per_person_views\":false,\"working_time\":false}" : "null")),\
    "outbox":{"total":2,"byKind":{"daily_aggregate":2}},"boundWorkflows":1,"lastFlushAt":\(lastFlushAt),\
    "nextFlushAt":null,"failures":\(failures),"lastError":\(le)}
    """
    return Data(s.utf8)
  }

  static var authorizeURL: String {
    "\(control)/auth/login?client=offload-mac&redirect_uri=http%3A%2F%2F127.0.0.1%3A53121%2Fcallback&state=s1&code_challenge=c1&code_challenge_method=S256"
  }
  static var connect: Data { Data("{\"state\":\"waiting\",\"authorizeUrl\":\"\(authorizeURL)\"}".utf8) }

  static var ack: Data {
    Data("{\"ack\":{\"id\":\"01JAZ3S5D0V1CE0000000000AB\",\"kind\":\"notice_ack\",\"createdAt\":1761400100000,\"noticeVersionId\":\"\(noticeId)\",\"acknowledgedAt\":1761400100000,\"jurisdiction\":\"US-NY\",\"features\":[\"workflow_metrics\"],\"channel\":\"mac_app\"}}".utf8)
  }

  /// The exact `workflow_proposal` the brain previews (workflow-definition.schema.json).
  static let proposal = """
  {"id":"01JAZ3S5D0V1CE0000000000AC","kind":"workflow_proposal","createdAt":1761400200000,"localWorkflowId":"wf-outreach",\
  "workflowId":null,"version":null,"name":"Follow up on demo requests","description":"Drafts a follow-up for each new demo request and logs it.",\
  "trigger":{"type":"cron","cron":"0 9 * * 1-5","timezone":"America/New_York"},\
  "steps":[{"id":"read","title":"Read new demo requests","detail":"From the shared inbox","class":"read","capability":"mail.read",\
  "connection":{"kind":"gmail","ownership":"company","connectionId":null,"label":"Gmail"},"gate":"none"},\
  {"id":"draft","title":"Draft a follow-up","detail":"In your voice","class":"draft","capability":"mail.draft","connection":null,"gate":"none"},\
  {"id":"send","title":"Send the follow-ups","detail":"After you approve","class":"commit","capability":"mail.send",\
  "connection":{"kind":"gmail","ownership":"company","connectionId":null,"label":"Gmail"},"gate":"approval"}],\
  "skillMd":"# Follow up\\nWrite to [address] about [link].","factsKeys":["product_name","pricing_page","calendar_link"],\
  "limits":{"maxItemsPerRun":25,"maxRunsPerDay":1},"definitionHash":"\(hash)"}
  """

  static var sharePreview: Data { Data("{\"confirmed\":false,\"proposal\":\(proposal)}".utf8) }
  static var shareConfirmed: Data { Data("{\"confirmed\":true,\"proposal\":\(proposal)}".utf8) }
  static func error(_ code: String, _ message: String) -> Data { Data("{\"error\":\"\(code)\",\"message\":\"\(message)\"}".utf8) }
}

/// Records every request and answers from a queue per "METHOD /path". Unknown routes answer 599 so a test notices.
final class S213Transport: BrainTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var queues: [String: [(Int, Data)]] = [:]
  private(set) var requests: [URLRequest] = []

  func on(_ method: String, _ path: String, _ body: Data) { on(method, path, 200, body) }

  func on(_ method: String, _ path: String, _ status: Int, _ body: Data) {
    lock.withLock { queues["\(method) \(path)", default: []].append((status, body)) }
  }

  var log: [String] {
    lock.withLock { requests.map { "\($0.httpMethod ?? "?") \($0.url!.path)" } }
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let key = "\(request.httpMethod ?? "GET") \(request.url!.path)"
    let answer: (Int, Data) = lock.withLock {
      requests.append(request)
      guard var q = queues[key], !q.isEmpty else { return (599, Data()) }
      let first = q.count > 1 ? q.removeFirst() : q[0]  // the last answer repeats (polling)
      queues[key] = q
      return first
    }
    let http = HTTPURLResponse(url: request.url!, statusCode: answer.0, httpVersion: "HTTP/1.1",
                               headerFields: ["Content-Type": "application/json"])!
    return (answer.1, http)
  }
}

enum S213 {
  static func client(_ t: S213Transport) -> CompanyClient {
    CompanyClient(brain: HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: S213Contract.base, token: "tok-s213")), transport: t))
  }
  static func service(_ t: S213Transport) -> CompanyService {
    CompanyService(api: client(t), pollInterval: 0, connectTimeout: 5, sleep: { _ in })
  }
  static func json(_ d: Data) -> NSDictionary { try! JSONSerialization.jsonObject(with: d) as! NSDictionary }
}

// MARK: CONNECT

@Suite("S2-13 Company connect")
struct S213ConnectTests {
  @Test("CONNECT: Connect posts /sync/connect once with the bearer token and waits; the brain opens the sign-in page, not the app")
  func opensBrowser() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let s = try await svc.connect()
    #expect(t.log.filter { $0 == "POST /sync/connect" }.count == 1)
    let connect = t.requests.first { $0.url!.path == "/sync/connect" }!
    #expect(connect.httpMethod == "POST")
    #expect(connect.value(forHTTPHeaderField: "Authorization") == "Bearer tok-s213")
    #expect(s.phase == .connected)
  }

  @Test("CONNECT: the connected state names the tenant")
  func tenantName() async throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    #expect(s.tenantName == "Acme Robotics")
    #expect(s.tenantLabel == "Acme Robotics")
    #expect(CompanyCopy.connected(s) == "Connected to Acme Robotics")
  }

  @Test("CONNECT: without a tenant name the control plane's host stands in")
  func tenantFallback() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", acknowledged: true, tenantName: nil))
    #expect(s.tenantName == nil)
    #expect(s.tenantLabel == "acme.offload.example")
  }

  @Test("CONNECT: a sign-in URL that is not the control plane's /auth/login stops the wait with a warning")
  func unsafeURL() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, Data("{\"state\":\"waiting\",\"authorizeUrl\":\"https://evil.example/auth/login?x=1\"}".utf8))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.unsafeURL) { try await svc.connect() }
    #expect(t.log.filter { $0 == "GET /sync/status" }.count == 1, "no polling after a bad URL")
    #expect(CompanyAuthorize.isSafe(URL(string: S213Contract.authorizeURL)!, control: URL(string: S213Contract.control)))
    #expect(!CompanyAuthorize.isSafe(URL(string: "http://acme.offload.example/auth/login")!, control: URL(string: "http://acme.offload.example")))
    #expect(CompanyAuthorize.isSafe(URL(string: "http://127.0.0.1:8787/auth/login?a=1")!, control: URL(string: "http://127.0.0.1:8787")))
    #expect(!CompanyAuthorize.isSafe(URL(string: "https://acme.offload.example/other")!, control: URL(string: S213Contract.control)))
  }

  @Test("CONNECT: a 409 from connect becomes one calm sentence")
  func conflict() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 409, S213Contract.error("conflict", "already connected"))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    do {
      _ = try await svc.connect()
      Issue.record("connect should have failed")
    } catch {
      #expect(CompanyError.message(for: error) == "Already connected.")
    }
  }

  @Test("CONNECT: waiting gives up after the timeout and says so")
  func timeout() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    let svc = CompanyService(api: S213.client(t), pollInterval: 1, connectTimeout: 3, sleep: { _ in })
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.signInTimedOut) { try await svc.connect() }
    let polls = t.log.filter { $0 == "GET /sync/status" }.count
    #expect(polls >= 3 && polls <= 5)
  }
}

// MARK: NOTICE

@Suite("S2-13 Company notice")
struct S213NoticeTests {
  @Test("NOTICE: the notice the control plane requires is decoded from status")
  func decode() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(features: ["workflow_metrics", "working_time"])))
    #expect(s.notice?.noticeVersionId == S213Contract.noticeId)
    #expect(s.notice?.title == "Acme Robotics monitoring notice")
    #expect(s.notice?.features == [.workflowMetrics, .workingTime])
    #expect(s.notice?.markdown.hasPrefix("# How Offload works") == true)
    #expect(s.noticeAcknowledged == false)
    #expect(s.waitingForNotice)
  }

  @Test("NOTICE: the tenant's Markdown renders as headings, bullets, numbered items and paragraphs")
  func markdown() {
    let b = NoticeMarkdown.blocks(S213Contract.markdown)
    #expect(b.first == .heading(1, "How Offload works at Acme Robotics"))
    #expect(b.contains(.heading(2, "What we never see")))
    #expect(b.contains(.bullet("Time saved, as **numbers** only")))
    #expect(b.contains(.numbered(2, "You can see your own data on the web.")))
    #expect(b.contains(.paragraph("Offload helps you hand repetitive work to automations. This notice says what the company sees.")))
    #expect(b.filter { if case .bullet = $0 { return true } else { return false } }.count == 4)
    // Wrapped paragraph lines join; HTML and images do not render as such.
    #expect(NoticeMarkdown.blocks("one\ntwo\n\n<b>x</b>") == [.paragraph("one two"), .paragraph("<b>x</b>")])
  }

  @Test("NOTICE: what the company sees follows the features; what it never sees is always listed")
  func visibility() {
    let off: [CompanyFeature: Bool] = [.workflowMetrics: true, .perPersonViews: false, .workingTime: false]
    let on: [CompanyFeature: Bool] = [.workflowMetrics: true, .perPersonViews: true, .workingTime: true]
    let seesOff = CompanyVisibility.sees(features: off)
    let seesOn = CompanyVisibility.sees(features: on)
    #expect(seesOff.contains(CompanyVisibility.runs))
    #expect(!seesOff.contains(CompanyVisibility.workingTime))
    #expect(seesOn.contains(CompanyVisibility.workingTime))
    #expect(seesOn.contains(CompanyVisibility.perPerson))
    for never in ["screen", "keystrokes", "window titles", "recipients", "subjects", "bodies", "documents"] {
      #expect(CompanyVisibility.neverSees.joined(separator: " ").lowercased().contains(never), "never sees: \(never)")
    }
  }

  @Test("NOTICE: features on for me come from the device config")
  func featuresOn() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(),
      features: "{\"workflow_metrics\":true,\"per_person_views\":false,\"working_time\":true}"))
    #expect(s.featuresOn == [.workflowMetrics, .workingTime])
    #expect(CompanyFeature.workingTime.plain == "Working time")
  }

  @Test("NOTICE: Acknowledge posts exactly the required notice id to /sync/notice/ack")
  func ack() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    t.on("POST", "/sync/notice/ack", 201, S213Contract.ack)
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let after = try await svc.acknowledgeNotice()
    let req = t.requests.first { $0.url!.path == "/sync/notice/ack" }!
    #expect(req.httpMethod == "POST")
    #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(S213.json(req.httpBody!) == ["noticeVersionId": S213Contract.noticeId] as NSDictionary)
    #expect(after.noticeAcknowledged)
    #expect(!after.waitingForNotice)
  }

  @Test("NOTICE: no sync before the ack: share and resume are refused without a request")
  func gate() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "paused", notice: S213Contract.notice(), paused: true))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let before = t.requests.count
    await #expect(throws: CompanyError.noticeFirst) { _ = try await svc.sharePreview(workflowId: "wf-outreach") }
    await #expect(throws: CompanyError.noticeFirst) { _ = try await svc.confirmShare(workflowId: "wf-outreach", hash: S213Contract.hash) }
    await #expect(throws: CompanyError.noticeFirst) { _ = try await svc.setPaused(false) }
    #expect(t.requests.count == before)
    #expect(CompanyGate.allows(.acknowledge, status: await svc.status!))
    #expect(!CompanyGate.allows(.share, status: await svc.status!))
  }

  @Test("NOTICE: acknowledging a notice that is not required is refused")
  func noNotice() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: nil))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.noNotice) { _ = try await svc.acknowledgeNotice() }
    #expect(!t.log.contains("POST /sync/notice/ack"))
  }
}

// MARK: SHARE

@Suite("S2-13 Company share")
struct S213ShareTests {
  func acked() -> S213Transport {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    return t
  }

  @Test("SHARE: the preview is the brain's exact proposal JSON, shown in plain words")
  func preview() async throws {
    let t = acked()
    t.on("POST", "/workflows/wf-outreach/share", 200, S213Contract.sharePreview)
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let p = try await svc.sharePreview(workflowId: "wf-outreach")
    let req = t.requests.last!
    #expect(req.httpMethod == "POST")
    #expect(req.url!.query == nil)
    #expect(p.name == "Follow up on demo requests")
    #expect(p.hash == S213Contract.hash)
    #expect(!p.confirmed)
    let words = Dictionary(uniqueKeysWithValues: p.lines.map { ($0.label, $0.value) })
    #expect(words["What it does"] == "Drafts a follow-up for each new demo request and logs it.")
    #expect(words["When it runs"] == "Weekdays at 9:00 (America/New_York)")
    #expect(words["Steps"] == "1. Read new demo requests, with Gmail\n2. Draft a follow-up\n3. Send the follow-ups, with Gmail, after approval")
    #expect(words["Facts it uses"] == "3 names (product_name, pricing_page, calendar_link), never their values")
    #expect(words["Limits"] == "Up to 25 items a run, 1 run a day")
    // View source: exactly the proposal object, nothing added or dropped.
    let shown = try JSONSerialization.jsonObject(with: Data(p.source.utf8)) as! NSDictionary
    let recorded = try JSONSerialization.jsonObject(with: Data(S213Contract.proposal.utf8)) as! NSDictionary
    #expect(shown == recorded)
    #expect(p.source.contains("\n  \""))  // pretty-printed for reading
  }

  @Test("SHARE: confirm queues exactly what was previewed (?confirm=1&hash=)")
  func confirm() async throws {
    let t = acked()
    t.on("POST", "/workflows/wf-outreach/share", 201, S213Contract.shareConfirmed)
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let p = try await svc.confirmShare(workflowId: "wf-outreach", hash: S213Contract.hash)
    let q = URLComponents(url: t.requests.last!.url!, resolvingAgainstBaseURL: false)!.queryItems!
    #expect(q.contains(URLQueryItem(name: "confirm", value: "1")))
    #expect(q.contains(URLQueryItem(name: "hash", value: S213Contract.hash)))
    #expect(p.confirmed)
    #expect(CompanyCopy.shareQueued == "Queued. It goes to your team with the next sync.")
  }

  @Test("SHARE: a workflow that changed since the preview is not queued")
  func changed() async throws {
    let t = acked()
    t.on("POST", "/workflows/wf-outreach/share", 409, S213Contract.error("conflict", "the workflow changed since the preview"))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.changedSincePreview) { _ = try await svc.confirmShare(workflowId: "wf-outreach", hash: S213Contract.hash) }
    #expect(CompanyError.changedSincePreview.userMessage == "This workflow changed since you looked. Review it again before sharing.")
  }

  @Test("SHARE: workflow ids are one path segment and a bad hash is never sent")
  func ids() async throws {
    let t = acked()
    t.on("POST", "/workflows/a%2Fb/share", 200, S213Contract.sharePreview)
    let svc = S213.service(t)
    _ = try await svc.refresh()
    _ = try? await svc.sharePreview(workflowId: "a/b")
    #expect(t.requests.last!.url!.absoluteString.contains("/workflows/a%2Fb/share"))
    let n = t.requests.count
    await #expect(throws: CompanyError.badHash) { _ = try await svc.confirmShare(workflowId: "wf-outreach", hash: "nothex") }
    #expect(t.requests.count == n)
  }

  @Test("SHARE: triggers read as words")
  func triggers() {
    #expect(SharePreview.when(type: "manual", cron: nil, timezone: nil) == "When you start it")
    #expect(SharePreview.when(type: "event", cron: nil, timezone: nil) == "When something new arrives")
    #expect(SharePreview.when(type: "cron", cron: "30 8 * * *", timezone: nil) == "Every day at 8:30")
    #expect(SharePreview.when(type: "cron", cron: "*/15 * * * *", timezone: "UTC") == "On a schedule (*/15 * * * *, UTC)")
  }
}

// MARK: STATUS

@Suite("S2-13 Company sync status")
struct S213StatusTests {
  let now = Date(timeIntervalSince1970: 1_761_400_000)

  func state(_ data: Data) throws -> CompanySyncState { CompanySyncState(try CompanyStatus.decode(data)) }

  @Test("STATUS: every brain state maps to one label and one state colour")
  func table() throws {
    let last = String(Int(now.addingTimeInterval(-300).timeIntervalSince1970 * 1000))
    let cases: [(Data, CompanySyncState, StatusRole, String)] = [
      (S213Contract.status(state: "not_configured", controlUrl: nil), .notSetUp, .neutral, "Company sync is not set up"),
      (S213Contract.status(state: "not_connected"), .notConnected, .neutral, "Not connected"),
      (S213Contract.status(state: "connecting"), .connecting, .working, "Finish signing in in your browser"),
      (S213Contract.status(state: "connected", notice: S213Contract.notice()), .waitingForNotice, .needsYou, "Waiting for you to read the notice"),
      (S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true, lastFlushAt: last),
       .syncing(last: now.addingTimeInterval(-300)), .done, "Last sync 5 min ago"),
      (S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true), .syncing(last: nil), .done, "Connected, not synced yet"),
      (S213Contract.status(state: "paused", notice: S213Contract.notice(), acknowledged: true, paused: true), .paused, .neutral, "Sync paused"),
      (S213Contract.status(state: "revoked"), .revoked, .needsYou, "This Mac was disconnected by your company"),
    ]
    for (data, expected, role, label) in cases {
      let s = try state(data)
      #expect(s == expected)
      #expect(s.role == role)
      #expect(s.label(now: now) == label)
    }
  }

  @Test("STATUS: paused while the notice is unread still asks for the notice first")
  func pausedNotice() throws {
    #expect(try state(S213Contract.status(state: "paused", notice: S213Contract.notice(), paused: true)) == .waitingForNotice)
  }

  @Test("STATUS: colour means state only: no recording red and nothing but the five roles")
  func colours() {
    let all: [CompanySyncState] = [.notSetUp, .notConnected, .connecting, .waitingForNotice, .syncing(last: nil), .paused, .revoked]
    #expect(all.allSatisfy { $0.role != .recording })
    #expect(Set(all.map(\.role)) == [.neutral, .working, .needsYou, .done])
  }

  @Test("STATUS: repeated failures say so without a code")
  func failing() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true,
                                                        failures: 3, lastError: "server_error 503"))
    #expect(CompanySyncState(s).detail(s) == "Offload will try again on its own.")
    #expect(!CompanySyncState(s).detail(s).contains("503"))
  }

  @Test("STATUS: relative times read plainly")
  func times() {
    #expect(CompanySyncState.ago(now.addingTimeInterval(-20), now: now) == "just now")
    #expect(CompanySyncState.ago(now.addingTimeInterval(-3 * 3600), now: now) == "3 h ago")
    #expect(CompanySyncState.ago(now.addingTimeInterval(-50 * 3600), now: now) == "2 days ago")
  }
}

// MARK: SELFVIEW

@Suite("S2-13 Company self-view")
struct S213SelfViewTests {
  @Test("SELFVIEW: the link opens /me on the company's control plane")
  func link() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    #expect(CompanySelfView.url(s) == URL(string: "https://acme.offload.example/me"))
    #expect(CompanySelfView.url(controlURL: URL(string: "https://acme.offload.example/base/")) == URL(string: "https://acme.offload.example/base/me"))
  }

  @Test("SELFVIEW: no link without a control plane, over plain http off this Mac, or before connecting")
  func noLink() throws {
    #expect(CompanySelfView.url(controlURL: nil) == nil)
    #expect(CompanySelfView.url(controlURL: URL(string: "http://acme.offload.example")) == nil)
    #expect(CompanySelfView.url(controlURL: URL(string: "http://127.0.0.1:8787")) == URL(string: "http://127.0.0.1:8787/me"))
    #expect(CompanySelfView.url(try CompanyStatus.decode(S213Contract.status(state: "not_connected"))) == nil)
  }
}

// MARK: DESIGN

@Suite("S2-13 Company design checklist")
struct S213DesignTests {
  static var folder: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("app/Sources/Surfaces/Company")
  }

  static func sources() throws -> [(String, String)] {
    let files = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil).filter { $0.pathExtension == "swift" }
    return try files.map { ($0.lastPathComponent, try String(contentsOf: $0, encoding: .utf8)) }
  }

  static func matches(_ pattern: String, _ s: String) -> [String] {
    let re = try! NSRegularExpression(pattern: pattern)
    return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { String(s[Range($0.range, in: s)!]) }
  }

  @Test("DESIGN: radii from tokens, motion from Motion, colours from the palette, one white primary per surface")
  func checklist() throws {
    let all = try Self.sources()
    #expect(all.count >= 3)
    for (name, s) in all {
      #expect(Self.matches(#"cornerRadius:\s*[0-9]"#, s).isEmpty, "\(name): literal radius")
      #expect(Self.matches(#"\.(easeIn|easeOut|easeInOut|linear|spring|interactiveSpring|bouncy|snappy)\b"#, s).isEmpty, "\(name): animation outside Motion")
      #expect(Self.matches(#"Color\((red|hex|white)|Color\.(blue|red|green|orange|yellow|purple|pink|accentColor)|\.foregroundStyle\(\.(blue|red|green|orange)"#, s).isEmpty, "\(name): colour outside Palette")
      for body in s.components(separatedBy: "struct ").dropFirst() {
        #expect(Self.matches(#"PrimaryButton\("#, body).count <= 1, "\(name): more than one primary in a view")
      }
    }
  }
}
