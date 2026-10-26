import Foundation
import Testing

// S2-13 review round 2 (PR #22, codex on 1adf9ae):
// [P2] reconnecting a revoked Mac: the brain keeps reporting `revoked` until the new enrollment lands, so the app's
//      wait must not treat that as a failure.
// [P2] Pause was disabled while a new notice waited for acknowledgement. Privacy controls never wait on new terms.
// Class-wide: every app-side wait on brain status survives the states it can see mid-flow (revoked, error, 404,
// brain down); and every privacy control is enumerated across every company state.

// MARK: waits on brain status

@Suite("S2-13 Company waits")
struct S213WaitTests {
  static func service(_ t: S213Transport) -> CompanyService {
    CompanyService(api: S213.client(t), pollInterval: 1, connectTimeout: 6, sleep: { _ in })
  }

  @Test("WAIT: reconnecting a revoked Mac keeps waiting while the brain still says revoked, then lands connected")
  func revokedReconnect() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked"))
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    let svc = Self.service(t)
    _ = try await svc.refresh()
    let s = try await svc.connect()
    #expect(s.phase == .connected)
    #expect(s.waitingForNotice, "the notice comes up right after the new enrollment")
  }

  @Test("WAIT: a revoked Mac whose new sign-in fails says sign-in did not finish, not 'disconnected'")
  func revokedReconnectFails() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked", lastError: "device revoked"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked", lastError: "device revoked"))
    t.on("GET", "/sync/status", S213Contract.status(state: "revoked", lastError: "connect failed: sign-in cancelled"))
    let svc = Self.service(t)
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.signInTimedOut) { try await svc.connect() }
  }

  @Test("WAIT: a brain error, a 404 or a brain that is briefly down mid sign-in does not abort the wait",
        arguments: [500, 503, 404, 599])
  func transientMidWait(code: Int) async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    t.on("GET", "/sync/status", code, S213Contract.error("internal", "busy"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    let svc = Self.service(t)
    _ = try await svc.refresh()
    let s = try await svc.connect()
    #expect(s.phase == .connected)
  }

  @Test("WAIT: a brain that stays down still ends the wait at the timeout, calmly")
  func downForGood() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", 503, S213Contract.error("internal", "down"))
    let svc = Self.service(t)
    _ = try await svc.refresh()
    await #expect(throws: CompanyError.signInTimedOut) { try await svc.connect() }
  }

  @Test("WAIT: an acknowledgement that landed is not reported as failed when the status read after it fails")
  func ackThenRefreshFails() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice()))
    t.on("POST", "/sync/notice/ack", S213Contract.ack)
    t.on("GET", "/sync/status", 500, S213Contract.error("internal", "busy"))
    let svc = S213.service(t)
    _ = try await svc.refresh()
    let s = try await svc.acknowledgeNotice()
    #expect(s.noticeAcknowledged)
    #expect(!s.waitingForNotice)
  }
}

// MARK: privacy controls

@Suite("S2-13 Company privacy controls")
struct S213PrivacyTests {
  /// Every company state the brain can report, with and without a pending notice, paused or not.
  static var allStates: [CompanyStatus] {
    var out: [CompanyStatus] = []
    for phase in [CompanyPhase.notConfigured, .notConnected, .connecting, .connected, .paused, .revoked] {
      for notice in [false, true] {
        for acknowledged in [false, true] {
          var s = CompanyStatus.empty
          s.phase = phase
          s.controlURL = phase == .notConfigured ? nil : URL(string: S213Contract.control)
          s.paused = phase == .paused
          if notice {
            s.notice = CompanyNotice(noticeVersionId: S213Contract.noticeId, title: "Notice", markdown: "Hi", features: [.workflowMetrics])
          }
          s.noticeAcknowledged = acknowledged
          out.append(s)
        }
      }
    }
    return out
  }

  @Test("PRIVACY: pause and see-my-data are never gated on acknowledging new terms; only resume and share are")
  func neverGatedOnTerms() {
    for s in Self.allStates {
      let tag = "\(s.phase) notice=\(s.notice != nil) ack=\(s.noticeAcknowledged)"
      let paused = s.paused || s.phase == .paused
      // Pause: whenever there is something to pause, whatever the notice says.
      #expect(CompanyControls.pauseEnabled(s) == (s.isConnected && !paused), "pause \(tag)")
      #expect(CompanyGate.allows(.pause, status: s) == s.isConnected, "pause gate \(tag)")
      // See what my company sees: whenever connected, computed from the status alone (no request first).
      #expect((CompanySelfView.url(s) != nil) == s.isConnected, "self-view \(tag)")
      // Resume and share: the only controls that wait for the ack.
      // Round 3: an unknown notice (or none published) fails closed; only an acknowledged required notice resumes.
      #expect(CompanyControls.resumeEnabled(s) == (s.isConnected && paused && s.notice != nil && s.noticeAcknowledged), "resume \(tag)")
    }
  }

  @Test("PRIVACY: the Company window's pause button takes its state from CompanyControls, never the notice")
  func viewUsesControls() {
    let view = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyView.swift")))
    let usesControls = view.contains("CompanyControls.pauseEnabled") && view.contains("CompanyControls.resumeEnabled")
    #expect(usesControls, "the pause/resume button does not use CompanyControls")
    let gatedOnNotice = view.contains(".disabled(model.status.waitingForNotice)")
    #expect(!gatedOnNotice, "pause is disabled while a notice waits")
  }
}

// MARK: sign-in already pending

@Suite("S2-13 Company sign-in again")
struct S213ReopenTests {
  final class Box: @unchecked Sendable {
    var svc: CompanyService?
    var seen: [URL?] = []
  }

  @Test("REOPEN: while the sign-in is pending its page can be opened again on request; the URL clears after")
  func pendingURL() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", S213Contract.status(state: "not_connected"))
    t.on("POST", "/sync/connect", 202, S213Contract.connect)
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connecting"))
    t.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    let box = Box()
    let svc = CompanyService(api: S213.client(t), pollInterval: 1, connectTimeout: 6, sleep: { _ in
      let u = await box.svc?.pendingSignIn
      box.seen.append(u)
    })
    box.svc = svc
    _ = try await svc.refresh()
    _ = try await svc.connect()
    #expect(box.seen.contains(URL(string: S213Contract.authorizeURL)!))
    #expect(await svc.pendingSignIn == nil)
    #expect(CompanyCopy.reopenSignIn == "Open sign-in page again")
    let view = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyView.swift")))
    let shown = view.contains("CompanyCopy.reopenSignIn")
    #expect(shown, "the Company window never offers the sign-in page again")
  }
}
