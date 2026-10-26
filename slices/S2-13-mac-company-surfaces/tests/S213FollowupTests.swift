import Foundation
import Testing

// S2-13 follow-ups (round-4 reviewer P3s, after PR #22 merged):
// 1. a discarded read returned the old cached status and the model applied it, so it could undo a fresh Pause.
// 2. ack and pause can overlap, so odd/even generation parity was wrong: freshness needs an in-flight count.
// 3. the gate's refusal for "no notice published" said "still checking".

/// Holds each listed route ("METHOD /path") behind its own gate.
final class S213MultiGate: BrainTransport, @unchecked Sendable {
  let inner: S213Transport
  let gates: [String: S213Gate]
  init(_ inner: S213Transport, routes: [String]) {
    self.inner = inner
    gates = Dictionary(uniqueKeysWithValues: routes.map { ($0, S213Gate()) })
  }
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    if let g = gates["\(request.httpMethod ?? "GET") \(request.url!.path)"] { await g.pass() }
    return try await inner.send(request)
  }
}

@Suite("S2-13 follow-up freshness")
struct S213FreshnessTests {
  static var notice: String { S213Contract.notice() }

  @Test("FRESH: a read inside overlapping ack + pause (even generation) is not applied")
  func overlap() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: Self.notice))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: Self.notice, lastError: "stale read"))
    t.on("POST", "/sync/notice/ack", S213Contract.ack)
    t.on("POST", "/sync/pause", S213Contract.status(state: "paused", notice: Self.notice, paused: true))
    let m = S213MultiGate(t, routes: ["POST /sync/notice/ack", "POST /sync/pause"])
    let svc = S213R4.service(m)
    _ = try await svc.refresh()
    for g in m.gates.values { await g.close() }
    let ack = Task { try await svc.acknowledgeNotice() }
    while await m.gates["POST /sync/notice/ack"]!.blocked == 0 { await Task.yield() }
    let pause = Task { try await svc.setPaused(true) }
    while await m.gates["POST /sync/pause"]!.blocked == 0 { await Task.yield() }
    let mid = try await svc.refresh()
    #expect(mid.lastError == nil, "a read during two overlapping mutations was accepted")
    #expect(await svc.status?.lastError == nil)
    for g in m.gates.values { await g.release() }
    _ = try await pause.value
    _ = try? await ack.value
  }

  @Test("FRESH: the quiet read says whether it is fresh; a read crossed by a Pause is not")
  func quietReadFlag() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213R4.ready)
    t.on("POST", "/sync/pause", S213R4.pausedReady)
    let gate = S213Gate()
    let client = CompanyClient(brain: HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: S213Contract.base, token: "t")),
                                                      transport: S213GatedTransport(t, gate)))
    let svc = CompanyService(api: client, pollInterval: 0, connectTimeout: 5, sleep: { _ in })
    _ = try await svc.refresh()
    #expect(await svc.readQuietly().fresh)
    await gate.close()
    let read = Task { await svc.readQuietly() }
    while await gate.blocked == 0 { await Task.yield() }
    _ = try await svc.setPaused(true)
    await gate.release()
    let r = await read.value
    #expect(!r.fresh, "a read crossed by Pause claimed to be fresh")
  }

  @Test("FRESH: the model applies a background read only when fresh and no Pause is in flight")
  func modelGuards() throws {
    let model = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyModel.swift")))
    let body = try #require(S213Source.body(of: "refreshQuietly", in: model))
    let guarded = body.contains("readQuietly") && body.contains(".fresh") && body.contains("pausing")
    #expect(guarded, "refreshQuietly applies stale reads")
  }
}

@Suite("S2-13 follow-up gate copy")
struct S213GateCopyTests {
  @Test("GATE: sharing with no notice published says the company has not published one, not 'still checking'")
  func noNoticeMessage() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected"))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    do {
      _ = try await svc.sharePreview(workflowId: "wf-outreach")
      Issue.record("share should be refused")
    } catch {
      #expect(CompanyError.message(for: error) == "Your company hasn't published a notice yet. Nothing is shared until it does and you read it.")
    }
    #expect(!t.log.contains("POST /workflows/wf-outreach/share"))
  }
}
