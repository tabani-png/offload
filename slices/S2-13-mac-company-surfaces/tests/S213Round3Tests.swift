import Foundation
import Testing

// S2-13 review round 3 (PR #22, independent review of c1e8df2):
// [P2] the app's consent gate failed OPEN when the brain did not know the notice yet: `/sync/status` sends
//      `notice: null` until the brain has read the device config (and never refreshes it itself), and the app read
//      that as "no notice required": no sheet, green "Up to date", Share and Resume on. A known config with
//      `required: null` means the brain sends nothing at all, yet the app showed green too.
// [P3] a background status read started before Pause could land after it and show the old state.
// Class-wide: every nullable field the app decodes from the brain's sync responses, nil read as the safe state.

extension S213Contract {
  /// `GET /sync/status` while the brain has not read the device config: `notice: null`.
  static func unknownNotice(_ d: Data) -> Data {
    Data(String(decoding: d, as: UTF8.self)
      .replacingOccurrences(of: "\"notice\":{\"required\":null,\"acknowledged\":false}", with: "\"notice\":null").utf8)
  }
  static func noOutbox(_ d: Data) -> Data {
    Data(String(decoding: d, as: UTF8.self)
      .replacingOccurrences(of: "\"outbox\":{\"total\":2,\"byKind\":{\"daily_aggregate\":2}}", with: "\"outbox\":null").utf8)
  }
}

// MARK: notice unknown or none required: fail closed

@Suite("S2-13 Company notice tri-state")
struct S213NoticeStateTests {
  static var unknown: CompanyStatus {
    try! CompanyStatus.decode(S213Contract.unknownNotice(S213Contract.status(state: "connected")))
  }
  static var noneRequired: CompanyStatus { try! CompanyStatus.decode(S213Contract.status(state: "connected")) }
  static var pausedUnknown: CompanyStatus {
    try! CompanyStatus.decode(S213Contract.unknownNotice(S213Contract.status(state: "paused", paused: true)))
  }

  @Test("NOTICE STATE: a notice the brain does not know yet blocks Share and Resume and never reads green",
        arguments: ["unknown", "noneRequired"])
  func failsClosed(kind: String) {
    let s = kind == "unknown" ? Self.unknown : Self.noneRequired
    #expect(s.isConnected)
    #expect(!CompanyGate.allows(.share, status: s), "\(kind): share allowed")
    #expect(!CompanyGate.allows(.resume, status: s), "\(kind): resume allowed")
    let state = CompanySyncState(s)
    #expect(state.role != .done, "\(kind): green")
    #expect(state.label() == "Checking your company's notice…", "\(kind): \(state.label())")
    #expect(state.detail(s) != "Up to date.", "\(kind): says up to date")
    // Pause and the self-view stay available (round 2).
    #expect(CompanyControls.pauseEnabled(s))
    #expect(CompanySelfView.url(s) != nil)
  }

  @Test("NOTICE STATE: paused with the notice unknown cannot resume")
  func pausedUnknownNoResume() {
    #expect(!CompanyControls.resumeEnabled(Self.pausedUnknown))
    #expect(!CompanyGate.allows(.resume, status: Self.pausedUnknown))
  }

  @Test("NOTICE STATE: the wire's three cases decode to unknown, none required and required")
  func decodes() throws {
    #expect(Self.unknown.noticeState == .unknown)
    #expect(Self.noneRequired.noticeState == .noneRequired)
    let req = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice()))
    guard case .required(let n) = req.noticeState else { Issue.record("not required"); return }
    #expect(n.noticeVersionId == S213Contract.noticeId)
    #expect(CompanyStatus.empty.noticeState == .unknown)
  }

  @Test("NOTICE STATE: after sign-in with the notice unknown, the app nudges a config read (GET /sync/preview) and polls again")
  func connectNudgesConfig() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    t.on("GET", "/sync/status", S213Contract.unknownNotice(S213Contract.status(state: "connected")))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    t.on("GET", "/sync/preview", Data("{\"envelope\":null,\"body\":null,\"held\":0,\"queued\":0}".utf8))
    let svc = CompanyService(api: S213.client(t), pollInterval: 1, connectTimeout: 6, sleep: { _ in })
    _ = try await svc.refresh()
    let s = try await svc.connect()
    #expect(t.log.contains("GET /sync/preview"))
    #expect(s.waitingForNotice, "the first-run notice must come up")
  }
}

// MARK: stale background reads (P3)

actor S213Gate {
  private var open = true
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private(set) var blocked = 0
  func close() { open = false }
  func pass() async {
    if open { return }
    blocked += 1
    await withCheckedContinuation { waiters.append($0) }
  }
  func release() {
    open = true
    for w in waiters { w.resume() }
    waiters = []
  }
}

final class S213GatedTransport: BrainTransport, @unchecked Sendable {
  let inner: S213Transport
  let gate: S213Gate
  init(_ inner: S213Transport, _ gate: S213Gate) { self.inner = inner; self.gate = gate }
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if request.httpMethod == "GET", request.url!.path == "/sync/status" { await gate.pass() }
    return try await inner.send(request)
  }
}

@Suite("S2-13 Company stale reads")
struct S213StaleTests {
  @Test("STALE: a status read started before Pause never overwrites the paused state it lands after")
  func pauseWins() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    t.on("POST", "/sync/pause", S213Contract.status(state: "paused", notice: S213Contract.notice(), acknowledged: true, paused: true))
    let gate = S213Gate()
    let client = CompanyClient(brain: HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: S213Contract.base, token: "t")),
                                                      transport: S213GatedTransport(t, gate)))
    let svc = CompanyService(api: client, pollInterval: 0, connectTimeout: 5, sleep: { _ in })
    _ = try await svc.refresh()
    await gate.close()
    let poll = Task { await svc.statusQuietly() }
    while await gate.blocked == 0 { await Task.yield() }
    let paused = try await svc.setPaused(true)
    #expect(paused.paused)
    await gate.release()
    let polled = await poll.value
    #expect(polled.paused, "the stale read won")
    #expect(await svc.status?.paused == true)
  }

  @Test("STALE: Pause/Resume ignores a second press while the first is in flight")
  func busyGuard() throws {
    let model = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyModel.swift")))
    let body = try #require(S213Source.body(of: "togglePause", in: model))
    let guarded = body.contains("guard !busy") && body.contains("busy = true")
    #expect(guarded, "togglePause has no busy guard")
  }
}

// MARK: nullable fields (class-wide)

@Suite("S2-13 Company nullable fields")
struct S213NullableTests {
  @Test("NULLABLE: features null means unknown, never 'only workflow results'")
  func featuresUnknown() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true, features: "null"))
    #expect(!s.featuresKnown)
    #expect(CompanyVisibility.sees(s).contains(CompanyCopy.featuresUnknown))
    let known = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    #expect(known.featuresKnown)
    #expect(!CompanyVisibility.sees(known).contains(CompanyCopy.featuresUnknown))
  }

  @Test("NULLABLE: an outbox the brain did not report is not 'Up to date'")
  func outboxUnknown() throws {
    let s = try CompanyStatus.decode(S213Contract.noOutbox(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true)))
    #expect(CompanySyncState(s).detail(s) == "Connected.")
  }

  @Test("NULLABLE: no control URL means no self-view and no sign-in page is trusted")
  func controlUnknown() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true, controlUrl: nil))
    #expect(CompanySelfView.url(s) == nil)
    #expect(!CompanyAuthorize.isSafe(URL(string: S213Contract.authorizeURL)!, control: s.controlURL))
  }

  @Test("NULLABLE: a share response without `confirmed` is not queued")
  func confirmedUnknown() throws {
    let p = try SharePreview.decode(Data("{\"proposal\":\(S213Contract.proposal)}".utf8))
    #expect(!p.confirmed)
  }

  @Test("NULLABLE: no lastFlushAt reads 'not synced yet', never a sync time")
  func lastSyncUnknown() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    #expect(s.lastSyncAt == nil)
    #expect(CompanySyncState(s).label() == "Connected, not synced yet")
  }
}
