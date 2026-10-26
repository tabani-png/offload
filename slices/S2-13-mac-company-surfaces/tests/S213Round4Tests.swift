import Foundation
import Testing

// S2-13 review round 4 (PR #22, independent review of 626fd7a):
// [P2] Pause shared the `busy` flag with acknowledge and share, so a Pause during a slow share confirm was dropped.
//      Pause never waits on, or is swallowed by, another request.
// [P3] `required: null` read "Checking your company's notice…" (untrue) and was never re-nudged.
// [P3] a status read that started while a pause/ack was in flight and finished before it was accepted.

/// Holds one route ("METHOD /path") until released.
final class S213RouteGate: BrainTransport, @unchecked Sendable {
  let inner: S213Transport
  let route: String
  let gate = S213Gate()
  init(_ inner: S213Transport, route: String) { self.inner = inner; self.route = route }
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if "\(request.httpMethod ?? "GET") \(request.url!.path)" == route { await gate.pass() }
    return try await inner.send(request)
  }
}

enum S213R4 {
  static func service(_ t: BrainTransport) -> CompanyService {
    CompanyService(api: CompanyClient(brain: HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: S213Contract.base, token: "t")),
                                                             transport: t)),
                   pollInterval: 0, connectTimeout: 5, sleep: { _ in })
  }
  static var ready: Data { S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true) }
  static var pausedReady: Data { S213Contract.status(state: "paused", notice: S213Contract.notice(), acknowledged: true, paused: true) }
}

@Suite("S2-13 Company pause is independent")
struct S213PauseTests {
  @Test("PAUSE: a Pause pressed while a share confirm is still in flight lands before the confirm returns")
  func pauseDuringShare() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213R4.ready)
    t.on("POST", "/workflows/wf-outreach/share", S213Contract.shareConfirmed)
    t.on("POST", "/sync/pause", S213R4.pausedReady)
    let gated = S213RouteGate(t, route: "POST /workflows/wf-outreach/share")
    let svc = S213R4.service(gated)
    _ = try await svc.refresh()
    await gated.gate.close()
    let share = Task { try await svc.confirmShare(workflowId: "wf-outreach", hash: S213Contract.hash) }
    while await gated.gate.blocked == 0 { await Task.yield() }
    let paused = try await svc.setPaused(true)
    #expect(paused.paused)
    #expect(t.log.contains("POST /sync/pause"))
    await gated.gate.release()
    _ = try await share.value
    #expect(await svc.status?.paused == true)
  }

  @Test("PAUSE: the model's Pause has its own in-flight flag, never the shared busy flag, and says it is working")
  func ownFlag() throws {
    let model = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyModel.swift")))
    let body = try #require(S213Source.body(of: "togglePause", in: model))
    let usesBusy = body.contains("busy")
    #expect(!usesBusy, "togglePause still uses the shared busy flag")
    let view = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyView.swift")))
    let feedback = view.contains("CompanyCopy.pausing") && view.contains("CompanyCopy.resuming")
    #expect(feedback, "no feedback while Pause/Resume is in flight")
    #expect(CompanyCopy.pausing == "Pausing…")
    #expect(CompanyCopy.resuming == "Resuming…")
  }
}

@Suite("S2-13 Company no notice published")
struct S213NoNoticeTests {
  @Test("NO NOTICE: none published says so plainly, still blocks sharing, and is not green")
  func copy() throws {
    let s = try CompanyStatus.decode(S213Contract.status(state: "connected"))
    let state = CompanySyncState(s)
    #expect(state.label() == "Your company hasn't published a notice yet")
    #expect(state.role != .done)
    #expect(!CompanyGate.allows(.share, status: s))
    #expect(!state.detail(s).contains("Checking"))
  }

  @Test("NO NOTICE: the background read nudges the config while none is published, so a later notice is picked up")
  func nudges() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    t.on("GET", "/sync/preview", Data("{\"envelope\":null,\"body\":null,\"held\":0,\"queued\":0}".utf8))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let s = await svc.statusQuietly()
    #expect(t.log.contains("GET /sync/preview"))
    #expect(s.waitingForNotice)
  }
}

@Suite("S2-13 Company reads during a mutation")
struct S213MidMutationTests {
  @Test("MID-MUTATION: a status read that starts and ends while Pause is in flight does not replace the state")
  func readInsideMutation() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213R4.ready)
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true,
                                                    lastError: "stale read"))
    t.on("POST", "/sync/pause", S213R4.pausedReady)
    let gated = S213RouteGate(t, route: "POST /sync/pause")
    let svc = S213R4.service(gated)
    _ = try await svc.refresh()
    await gated.gate.close()
    let pause = Task { try await svc.setPaused(true) }
    while await gated.gate.blocked == 0 { await Task.yield() }
    let mid = try await svc.refresh()
    #expect(mid.lastError == nil, "the read inside the mutation was accepted")
    #expect(await svc.status?.lastError == nil)
    await gated.gate.release()
    let paused = try await pause.value
    #expect(paused.paused)
    #expect(await svc.status?.paused == true)
  }
}
