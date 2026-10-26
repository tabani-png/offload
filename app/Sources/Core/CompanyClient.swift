import Foundation

// S2-13: the Mac's company surfaces talk to the local brain's company-sync routes only (brain/API.md "Company sync",
// S2-02): status, connect (loopback PKCE sign-in in the browser, ADR 0111 §1), the notice ack, the share preview and
// confirm, pause and resume. The notice itself is the control plane's (S2-08) as the brain relays it in the status.
// Nothing here talks to the control plane directly except opening `/me` in the browser. The sign-in page is opened
// by the brain (SyncClient.connect opens it before POST /sync/connect returns): one owner, one tab, one PKCE flow.
// Foundation only, so every rule below is tested without a window server.

// MARK: status

enum CompanyPhase: String, Equatable, Sendable {
  case notConfigured = "not_configured", notConnected = "not_connected", connecting, connected, paused, revoked
}

/// The three sensitive features a tenant can turn on (common.schema.json `feature`).
enum CompanyFeature: String, CaseIterable, Equatable, Hashable, Sendable {
  case workflowMetrics = "workflow_metrics", perPersonViews = "per_person_views", workingTime = "working_time"

  var plain: String {
    switch self {
    case .workflowMetrics: return "Workflow results"
    case .perPersonViews: return "Your own numbers, by name"
    case .workingTime: return "Working time"
    }
  }
}

/// The notice the company requires before anything but its acknowledgement leaves this Mac.
struct CompanyNotice: Equatable, Sendable {
  var noticeVersionId: String
  var title: String
  var markdown: String
  var features: [CompanyFeature]
}

/// What the brain knows about the notice. Only `.required` with an acknowledgement opens sharing; `.unknown` (the brain
/// has not read the device config yet: `notice: null`) and `.noneRequired` (the config has `required: null`, so the
/// brain sends nothing) both fail closed.
enum CompanyNoticeState: Equatable, Sendable {
  case unknown, noneRequired
  case required(CompanyNotice)
}

/// `GET /sync/status` (SyncStatusDTO), the parts the app shows. Every nullable wire field decodes to its safe reading.
struct CompanyStatus: Equatable, Sendable {
  var phase: CompanyPhase
  var controlURL: URL?
  var configError: String?
  var tenantId: String?
  /// Not in SyncStatusDTO today: read when the brain relays it; `tenantLabel` falls back to the control plane's host.
  var tenantName: String?
  var enrolledAt: Date?
  var paused: Bool
  var noticeState: CompanyNoticeState
  var noticeAcknowledged: Bool
  var features: [CompanyFeature: Bool]
  /// `features: null` (config not read yet): what is on is unknown, never "only workflow results".
  var featuresKnown: Bool
  /// `outbox: null`: unknown, never "up to date".
  var queued: Int?
  var lastSyncAt: Date?
  var nextSyncAt: Date?
  var failures: Int
  var lastError: String?

  static let empty = CompanyStatus(phase: .notConfigured, controlURL: nil, configError: nil, tenantId: nil, tenantName: nil,
                                   enrolledAt: nil, paused: false, noticeState: .unknown, noticeAcknowledged: false, features: [:],
                                   featuresKnown: false, queued: nil, lastSyncAt: nil, nextSyncAt: nil, failures: 0, lastError: nil)

  /// The required notice, if the brain knows one. Setting it marks the notice required (nil: none required).
  var notice: CompanyNotice? {
    get { if case .required(let n) = noticeState { return n } else { return nil } }
    set { noticeState = newValue.map(CompanyNoticeState.required) ?? .noneRequired }
  }

  var isConnected: Bool { phase == .connected || phase == .paused }
  /// Connected, a notice is required and this Mac has not acknowledged it: nothing but the ack may leave.
  var waitingForNotice: Bool { isConnected && notice != nil && !noticeAcknowledged }
  /// Connected and the brain does not know of a notice to acknowledge (not read yet, or none published): nothing is
  /// shared, and the app says it is checking rather than "up to date".
  var checkingNotice: Bool { isConnected && notice == nil }
  /// The only state in which sharing and resuming may happen: a known, required notice, acknowledged.
  var consentReady: Bool { isConnected && notice != nil && noticeAcknowledged }
  /// Features that are on for me, in a fixed order.
  var featuresOn: [CompanyFeature] { CompanyFeature.allCases.filter { features[$0] == true } }

  var tenantLabel: String {
    if let n = tenantName?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty { return n }
    return controlURL?.host ?? "your company"
  }

  private struct Wire: Decodable {
    struct Notice: Decodable {
      struct Required: Decodable { let noticeVersionId: String; let title: String; let markdown: String; let features: [String] }
      let required: Required?
      let acknowledged: Bool
    }
    struct Outbox: Decodable { let total: Int }
    let state: String
    let controlUrl: String?
    let configError: String?
    let tenantId: String?
    let tenantName: String?
    let enrolledAt: Double?
    let paused: Bool
    let notice: Notice?
    let features: [String: Bool]?
    let outbox: Outbox?
    let lastFlushAt: Double?
    let nextFlushAt: Double?
    let failures: Int?
    let lastError: String?
  }

  static func decode(_ data: Data) throws -> CompanyStatus {
    let w: Wire
    do { w = try JSONDecoder().decode(Wire.self, from: data) } catch { throw BrainError.badResponse("sync status") }
    guard let phase = CompanyPhase(rawValue: w.state) else { throw BrainError.badResponse("sync state \(w.state)") }
    func date(_ ms: Double?) -> Date? { ms.map { Date(timeIntervalSince1970: $0 / 1000) } }
    var features: [CompanyFeature: Bool] = [:]
    for (k, v) in w.features ?? [:] { if let f = CompanyFeature(rawValue: k) { features[f] = v } }
    let noticeState: CompanyNoticeState
    if let n = w.notice {
      noticeState = n.required.map {
        .required(CompanyNotice(noticeVersionId: $0.noticeVersionId, title: $0.title, markdown: $0.markdown,
                                features: $0.features.compactMap(CompanyFeature.init(rawValue:))))
      } ?? .noneRequired
    } else {
      noticeState = .unknown
    }
    return CompanyStatus(phase: phase, controlURL: w.controlUrl.flatMap(URL.init(string:)), configError: w.configError,
                         tenantId: w.tenantId, tenantName: w.tenantName, enrolledAt: date(w.enrolledAt), paused: w.paused,
                         noticeState: noticeState, noticeAcknowledged: w.notice?.acknowledged ?? false, features: features,
                         featuresKnown: w.features != nil, queued: w.outbox?.total, lastSyncAt: date(w.lastFlushAt),
                         nextSyncAt: date(w.nextFlushAt), failures: w.failures ?? 0, lastError: w.lastError)
  }
}

// MARK: sync state (rail and dashboard)

/// What the rail and the dashboard say about company sync. Colour means state only.
enum CompanySyncState: Equatable, Sendable {
  case notSetUp, notConnected, connecting, waitingForNotice, checkingNotice, syncing(last: Date?), paused, revoked

  init(_ s: CompanyStatus) {
    switch s.phase {
    case .notConfigured: self = .notSetUp
    case .notConnected: self = .notConnected
    case .connecting: self = .connecting
    case .revoked: self = .revoked
    case .connected, .paused:
      if s.waitingForNotice { self = .waitingForNotice }
      else if s.phase == .paused || s.paused { self = .paused }
      else if s.checkingNotice { self = .checkingNotice }
      else { self = .syncing(last: s.lastSyncAt) }
    }
  }

  var role: StatusRole {
    switch self {
    case .notSetUp, .notConnected, .paused: return .neutral
    case .connecting, .checkingNotice: return .working
    case .waitingForNotice, .revoked: return .needsYou
    case .syncing: return .done
    }
  }

  func label(now: Date = Date()) -> String {
    switch self {
    case .notSetUp: return "Company sync is not set up"
    case .notConnected: return "Not connected"
    case .connecting: return "Finish signing in in your browser"
    case .waitingForNotice: return "Waiting for you to read the notice"
    case .checkingNotice: return "Checking your company's notice…"
    case .syncing(let last): return last.map { "Last sync \(Self.ago($0, now: now))" } ?? "Connected, not synced yet"
    case .paused: return "Sync paused"
    case .revoked: return "This Mac was disconnected by your company"
    }
  }

  /// Short form for the rail's tooltip row.
  var short: String {
    switch self {
    case .notSetUp, .notConnected: return "Not connected"
    case .connecting: return "Signing in"
    case .waitingForNotice: return "Notice to read"
    case .checkingNotice: return "Checking notice"
    case .syncing: return "Syncing"
    case .paused: return "Paused"
    case .revoked: return "Disconnected"
    }
  }

  /// One quiet sentence under the label. Never a status code.
  func detail(_ s: CompanyStatus) -> String {
    switch self {
    case .notSetUp: return "Your company has not set up Offload for teams on this Mac."
    case .notConnected: return "Connect to share workflow results with your company. Nothing is shared until you read its notice."
    case .connecting: return "Offload opened your company's sign-in page."
    case .waitingForNotice: return "Nothing leaves this Mac until you read and acknowledge it."
    case .checkingNotice:
      return s.noticeState == .noneRequired
        ? "Your company has not published a notice yet. Nothing is shared until it does and you read it."
        : "Nothing is shared until Offload has your company's notice and you read it."
    case .syncing:
      if s.failures >= 2 { return "Offload will try again on its own." }
      guard let queued = s.queued else { return "Connected." }
      return queued > 0 ? "\(Format.count(queued)) ready for the next sync." : "Up to date."
    case .paused: return "Nothing is sent until you resume."
    case .revoked: return "Connect again to keep sharing."
    }
  }

  static func ago(_ date: Date, now: Date) -> String {
    let s = max(0, now.timeIntervalSince(date))
    if s < 60 { return "just now" }
    if s < 3600 { return "\(Int(s / 60)) min ago" }
    if s < 86_400 { return "\(Int(s / 3600)) h ago" }
    let d = Int(s / 86_400)
    return d == 1 ? "yesterday" : "\(d) days ago"
  }
}

// MARK: notice

/// The block Markdown a notice uses: headings, bullets, numbered items, paragraphs. Inline marks (bold, links) stay
/// in the text for the view's inline renderer. Anything else (HTML, images) shows as plain text.
enum NoticeMarkdown {
  enum Block: Equatable, Sendable {
    case heading(Int, String)
    case bullet(String)
    case numbered(Int, String)
    case paragraph(String)
  }

  static func blocks(_ markdown: String) -> [Block] {
    var out: [Block] = []
    var para: [String] = []
    func flush() {
      if !para.isEmpty { out.append(.paragraph(para.joined(separator: " "))); para = [] }
    }
    for raw in markdown.components(separatedBy: .newlines) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty { flush(); continue }
      if let h = heading(line) { flush(); out.append(h); continue }
      if line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ") {
        flush(); out.append(.bullet(String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces))); continue
      }
      if let n = numbered(line) { flush(); out.append(n); continue }
      para.append(line)
    }
    flush()
    return out
  }

  private static func heading(_ line: String) -> Block? {
    let hashes = line.prefix { $0 == "#" }.count
    guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
    return .heading(hashes, line.dropFirst(hashes).trimmingCharacters(in: .whitespaces))
  }

  private static func numbered(_ line: String) -> Block? {
    let digits = line.prefix { $0.isNumber }
    guard !digits.isEmpty, digits.count <= 3, let n = Int(digits) else { return nil }
    let rest = line.dropFirst(digits.count)
    guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return .numbered(n, rest.dropFirst(2).trimmingCharacters(in: .whitespaces))
  }
}

/// What the company sees and never sees, said the same way everywhere (the notice sheet, the company window).
enum CompanyVisibility {
  static let runs = "How often each shared workflow ran, and whether it worked"
  static let timeSaved = "Time saved, as numbers"
  static let reviews = "How long reviews took, in seconds"
  static let perPerson = "Those numbers with your name on them"
  static let workingTime = "Daily working time, as totals"

  /// What the company sees for this status: unknown features add one line saying so, never an understatement.
  static func sees(_ s: CompanyStatus) -> [String] {
    sees(features: s.features) + (s.featuresKnown ? [] : [CompanyCopy.featuresUnknown])
  }

  static func sees(features: [CompanyFeature: Bool]) -> [String] {
    var out = [runs, timeSaved, reviews]
    if features[.perPersonViews] == true { out.append(perPerson) }
    if features[.workingTime] == true { out.append(workingTime) }
    return out
  }

  static let neverSees = [
    "Your screen, keystrokes or window titles",
    "Email recipients, subjects or bodies",
    "Documents, files or what you typed in them",
    "Websites and apps you used",
  ]
}

// MARK: share

/// `POST /workflows/:id/share`: the exact `workflow_proposal` the brain would send, in plain words, plus the JSON.
struct SharePreview: Equatable, Sendable {
  struct Line: Equatable, Sendable { var label: String; var value: String }

  var localWorkflowId: String
  var name: String
  var hash: String
  var confirmed: Bool
  var lines: [Line]
  /// The proposal object, pretty-printed with sorted keys (View source).
  var source: String

  static let neverIncluded = "Recipients, email text, the values of your facts and anything on your screen stay on this Mac."

  static func decode(_ data: Data) throws -> SharePreview {
    guard let top = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let p = top["proposal"] as? [String: Any],
          let name = p["name"] as? String, let hash = p["definitionHash"] as? String
    else { throw BrainError.badResponse("share preview") }
    let pretty = try JSONSerialization.data(withJSONObject: p, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    var lines: [Line] = []
    if let d = p["description"] as? String, !d.isEmpty { lines.append(Line(label: "What it does", value: d)) }
    if let t = p["trigger"] as? [String: Any] {
      lines.append(Line(label: "When it runs", value: when(type: t["type"] as? String ?? "manual", cron: t["cron"] as? String,
                                                           timezone: t["timezone"] as? String)))
    }
    if let steps = p["steps"] as? [[String: Any]], !steps.isEmpty {
      let text = steps.enumerated().map { i, s -> String in
        var line = "\(i + 1). \(s["title"] as? String ?? "Step")"
        if let c = s["connection"] as? [String: Any], let label = c["label"] as? String, !label.isEmpty { line += ", with \(label)" }
        switch s["gate"] as? String {
        case "approval": line += ", after approval"
        case "overnight_policy": line += ", within the overnight rules"
        default: break
        }
        return line
      }.joined(separator: "\n")
      lines.append(Line(label: "Steps", value: text))
    }
    if let keys = p["factsKeys"] as? [String], !keys.isEmpty {
      lines.append(Line(label: "Facts it uses", value: "\(keys.count) \(keys.count == 1 ? "name" : "names") (\(keys.joined(separator: ", "))), never their values"))
    }
    if let l = p["limits"] as? [String: Any], let items = l["maxItemsPerRun"] as? Int, let runs = l["maxRunsPerDay"] as? Int {
      lines.append(Line(label: "Limits", value: "Up to \(items) \(items == 1 ? "item" : "items") a run, \(runs) \(runs == 1 ? "run" : "runs") a day"))
    }
    return SharePreview(localWorkflowId: p["localWorkflowId"] as? String ?? "", name: name, hash: hash,
                        confirmed: top["confirmed"] as? Bool ?? false, lines: lines,
                        source: String(decoding: pretty, as: UTF8.self))
  }

  /// A trigger in words. Simple daily and weekday crons read as a time; anything else shows the cron itself.
  static func when(type: String, cron: String?, timezone: String?) -> String {
    switch type {
    case "manual": return "When you start it"
    case "event": return "When something new arrives"
    default: break
    }
    guard let cron else { return "On a schedule" }
    let tz = timezone.map { " (\($0))" } ?? ""
    let f = cron.split(separator: " ").map(String.init)
    if f.count == 5, let m = Int(f[0]), let h = Int(f[1]), (0..<60).contains(m), (0..<24).contains(h), f[2] == "*", f[3] == "*" {
      let time = String(format: "%d:%02d", h, m)
      if f[4] == "*" { return "Every day at \(time)\(tz)" }
      if f[4] == "1-5" { return "Weekdays at \(time)\(tz)" }
    }
    return "On a schedule (\(cron)\(timezone.map { ", \($0)" } ?? ""))"
  }
}

// MARK: links

/// Only the control plane's own sign-in page is opened, over https (http only on this Mac).
enum CompanyAuthorize {
  static func isSafe(_ url: URL, control: URL?) -> Bool {
    guard let control, let host = url.host, host == control.host, url.port == control.port,
          url.scheme == control.scheme, CompanyLinks.schemeAllowed(url) else { return false }
    let base = control.path.hasSuffix("/") ? String(control.path.dropLast()) : control.path
    return url.path == base + "/auth/login"
  }
}

enum CompanyLinks {
  static func schemeAllowed(_ url: URL) -> Bool {
    url.scheme == "https" || (url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost"))
  }
}

/// "See what my company sees": the control plane's `/me` page in the browser.
enum CompanySelfView {
  static func url(controlURL: URL?) -> URL? {
    guard let c = controlURL, CompanyLinks.schemeAllowed(c) else { return nil }
    return c.appendingPathComponent("me")
  }

  static func url(_ s: CompanyStatus) -> URL? { s.isConnected ? url(controlURL: s.controlURL) : nil }
}

// MARK: gate

/// The app's own copy of the consent gate (the brain and the server check again): before the notice is
/// acknowledged, only the acknowledgement (and pausing) may happen.
enum CompanyGate {
  enum Action { case connect, acknowledge, share, pause, resume }

  static func allows(_ a: Action, status s: CompanyStatus) -> Bool {
    switch a {
    case .connect: return !s.isConnected
    case .acknowledge: return s.waitingForNotice
    case .pause: return s.isConnected
    case .share, .resume: return s.consentReady
    }
  }
}

// MARK: entry

/// Where the company shows up outside its own window. The app leads with where your time goes: company sync never
/// pushes itself. Not connected is one calm menu item and one dashboard row; the rail shows it only once a company
/// is in play. Nothing here carries per-person data: state only.
enum CompanyEntry {
  static let connectTitle = "Connect your company…"
  static let openTitle = "Company…"

  static func menuTitle(_ s: CompanySyncState) -> String {
    switch s {
    case .notSetUp, .notConnected, .revoked: return connectTitle
    default: return openTitle
    }
  }

  /// The rail's company mark, or nil to show nothing.
  static func railState(_ s: CompanySyncState) -> CompanySyncState? {
    switch s {
    case .notSetUp, .notConnected: return nil
    default: return s
    }
  }

  /// The dashboard row: hidden when this Mac has no company to connect to.
  static func showsOnDashboard(_ s: CompanySyncState) -> Bool { s != .notSetUp }
}

/// The privacy controls and when they work. Pause and "see what my company sees" never wait for acknowledging new
/// terms and are decided from the status alone (no request first); only Resume (and sharing) wait for the ack.
/// There is no disconnect or consent-withdrawal control: the brain has no such route (brain/API.md, S2-02).
enum CompanyControls {
  static func isPaused(_ s: CompanyStatus) -> Bool { s.paused || s.phase == .paused }
  static func pauseEnabled(_ s: CompanyStatus) -> Bool { s.isConnected && !isPaused(s) }
  static func resumeEnabled(_ s: CompanyStatus) -> Bool { isPaused(s) && s.consentReady }
}

/// What the dashboard's company row needs: the status (tenant, queue) and the state the Company window shows.
struct CompanyGlance: Equatable, Sendable {
  var status: CompanyStatus
  var state: CompanySyncState
}

// MARK: errors and copy

enum CompanyError: Error, Equatable {
  case noticeFirst, noticeUnknown, noNotice, notConnected, unsafeURL, signInTimedOut, revoked, changedSincePreview, badHash

  var userMessage: String {
    switch self {
    case .noticeFirst: return "Read your company's notice first. Nothing is shared before you acknowledge it."
    case .noticeUnknown: return "Offload is still checking your company's notice. Nothing is shared until you read it."
    case .noNotice: return "Your company has no notice for you to acknowledge right now."
    case .notConnected: return "Connect to your company first."
    case .unsafeURL: return "That sign-in page is not your company's address. Do not sign in there; Offload stopped waiting."
    case .signInTimedOut: return "Sign-in did not finish. Try again when you are ready."
    case .revoked: return "Your company disconnected this Mac. Connect again to keep sharing."
    case .changedSincePreview: return "This workflow changed since you looked. Review it again before sharing."
    case .badHash: return "That preview cannot be shared. Open it again."
    }
  }

  static func message(for error: Error) -> String {
    if let c = error as? CompanyError { return c.userMessage }
    return BrainError.message(for: error)
  }
}

enum CompanyCopy {
  static let title = "Company"
  static let subtitle = "Offload for teams"
  static let connect = "Connect to company"
  static let connectNote = "Opens your company's sign-in page in your browser. Offload never sees your password."
  static let waiting = "Finish signing in in your browser"
  static let reopenSignIn = "Open sign-in page again"
  static let readNotice = "Read the notice"
  static let acknowledge = "I have read it"
  static let noticeLater = "Later"
  static let noticeNote = "Until you acknowledge this, nothing but your acknowledgement leaves this Mac."
  static let sees = "What your company sees"
  static let neverSees = "What it never sees"
  static let featuresOn = "On for you"
  static let noFeatures = "Only workflow results. Nothing about you by name."
  static let featuresUnknown = "Checking what else is on for you…"
  static let shareTitle = "Share with my team"
  static let shareAction = "Share"
  static let shareConfirm = "Share with my team"
  static let shareNote = "Your team gets the workflow's steps so they can use it too."
  static let shareQueued = "Queued. It goes to your team with the next sync."
  static let viewSource = "View source"
  static let hideSource = "Hide source"
  static let selfView = "See what my company sees"
  static let pause = "Pause sync"
  static let resume = "Resume sync"

  static func connected(_ s: CompanyStatus) -> String { "Connected to \(s.tenantLabel)" }
}

// MARK: client

/// What the company surfaces need from the brain. HTTP in the app; the snapshot mock implements it in memory.
protocol CompanyAPI: Sendable {
  func status() async throws -> CompanyStatus
  func connect() async throws -> URL
  func acknowledge(noticeVersionId: String) async throws
  func sharePreview(workflowId: String) async throws -> SharePreview
  func confirmShare(workflowId: String, hash: String) async throws -> SharePreview
  func setPaused(_ paused: Bool) async throws -> CompanyStatus
  /// Asks the brain to read the device config now (GET /sync/preview refreshes it the way a flush would). The brain's
  /// `/sync/status` never refreshes config itself, so right after sign-in the notice is unknown until this runs.
  func refreshConfig() async throws
}

/// The brain's company-sync routes over the same loopback endpoint, token and transport as every other route.
struct CompanyClient: CompanyAPI {
  let brain: HTTPBrainClient

  private func raw(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil) async throws -> Data {
    var request = try brain.makeRequest(method, path, query: query, body: body)
    // `path` is already percent-encoded per segment (HTTPBrainClient.segment); URLComponents.path would encode the
    // "%" again (a%2Fb -> a%252Fb), so set the encoded path as is.
    if let url = request.url, var c = URLComponents(url: url, resolvingAgainstBaseURL: false) {
      c.percentEncodedPath = "/" + path
      request.url = c.url ?? url
    }
    let data: Data
    let response: HTTPURLResponse
    do { (data, response) = try await brain.transport.send(request) } catch { throw HTTPBrainClient.map(error) }
    guard (200..<300).contains(response.statusCode) else { throw HTTPBrainClient.error(status: response.statusCode, data: data, path: path) }
    return data
  }

  func status() async throws -> CompanyStatus { try CompanyStatus.decode(try await raw("GET", "sync/status")) }

  func connect() async throws -> URL {
    struct Started: Decodable { let authorizeUrl: String }
    let data = try await raw("POST", "sync/connect")
    guard let s = try? JSONDecoder().decode(Started.self, from: data), let url = URL(string: s.authorizeUrl) else {
      throw BrainError.badResponse("sync connect")
    }
    return url
  }

  func acknowledge(noticeVersionId: String) async throws {
    _ = try await raw("POST", "sync/notice/ack", body: ["noticeVersionId": noticeVersionId])
  }

  func sharePreview(workflowId: String) async throws -> SharePreview {
    try SharePreview.decode(try await raw("POST", "workflows/\(HTTPBrainClient.segment(workflowId))/share"))
  }

  func confirmShare(workflowId: String, hash: String) async throws -> SharePreview {
    do {
      let data = try await raw("POST", "workflows/\(HTTPBrainClient.segment(workflowId))/share",
                               query: [URLQueryItem(name: "confirm", value: "1"), URLQueryItem(name: "hash", value: hash)])
      return try SharePreview.decode(data)
    } catch BrainError.conflict {
      throw CompanyError.changedSincePreview
    }
  }

  func setPaused(_ paused: Bool) async throws -> CompanyStatus {
    try CompanyStatus.decode(try await raw("POST", paused ? "sync/pause" : "sync/resume"))
  }

  func refreshConfig() async throws { _ = try await raw("GET", "sync/preview") }
}

// MARK: service

/// Holds the last status and enforces the gate before any request: the surfaces call this, never the client.
actor CompanyService {
  let api: CompanyAPI
  let pollInterval: Double
  let connectTimeout: Double
  private let sleep: @Sendable (Double) async -> Void
  private(set) var status: CompanyStatus?
  /// The sign-in page of the flow this Mac is waiting on, so the person can open it again if they closed the tab
  /// (the brain does not reopen it for a flow that is already running). Nil when not waiting.
  private(set) var pendingSignIn: URL?

  init(api: CompanyAPI, pollInterval: Double = 1, connectTimeout: Double = 300,
       sleep: @escaping @Sendable (Double) async -> Void = { s in try? await Task.sleep(nanoseconds: UInt64(s * 1_000_000_000)) }) {
    self.api = api
    self.pollInterval = pollInterval
    self.connectTimeout = connectTimeout
    self.sleep = sleep
  }

  /// Bumped before and after every request that changes sync state (pause, resume, ack): a status read that was in
  /// flight across one is stale and is dropped, so a 30 s poll can never undo Pause on screen.
  private var generation = 0

  @discardableResult
  func refresh() async throws -> CompanyStatus {
    let started = generation
    let s = try await api.status()
    if started != generation, let current = status { return current }
    status = s
    return s
  }

  private func mutate<T>(_ body: () async throws -> T) async rethrows -> T {
    generation += 1
    defer { generation += 1 }
    return try await body()
  }

  /// The background read for the rail, the dashboard and the menu: a brain without company sync (404), or one that
  /// is not up yet, reads as "not set up" (or the last state seen), never as an error.
  ///
  /// While connected with the notice unknown, it first nudges the brain to read the config, so the first-run notice
  /// shows up without waiting for the brain's next flush.
  func statusQuietly() async -> CompanyStatus {
    if let s = status, s.isConnected, s.noticeState == .unknown { try? await api.refreshConfig() }
    do { return try await refresh() } catch { return status ?? .empty }
  }

  /// After sign-in: the brain has not read the device config yet, so ask it to, and poll a few times for the notice.
  private func settleNotice(_ connected: CompanyStatus) async -> CompanyStatus {
    var s = connected
    var tries = 0
    while s.noticeState == .unknown, tries < 5 {
      try? await api.refreshConfig()
      if let now = try? await refresh() { s = now }
      if s.noticeState != .unknown { break }
      tries += 1
      await sleep(pollInterval)
    }
    return s
  }

  private func current() async throws -> CompanyStatus {
    if let status { return status }
    return try await refresh()
  }

  /// Starts the brain's PKCE loopback sign-in, then polls the status until this Mac is connected (or revoked, or the
  /// wait times out). The brain opens the sign-in page itself (one tab for its one loopback listener); the app never
  /// opens the URL it gets back, it only checks it is the control plane's `/auth/login` and stops waiting if not.
  ///
  /// What the wait can see mid-flow, and what it does:
  /// - `connecting`: keep waiting. `connected`/`paused`: done.
  /// - `revoked` when this Mac started revoked: keep waiting (the brain keeps the revoked flag until the new
  ///   enrollment lands); a new "connect failed" error from the brain ends it. `revoked` otherwise: revoked.
  /// - `not_connected`/`not_configured` after the first poll: the brain's flow ended without enrolling.
  /// - a failed read (brain error, 404, brain restarting or down): keep polling; only the timeout ends it.
  func connect(onPending: @escaping @Sendable (URL) -> Void = { _ in }) async throws -> CompanyStatus {
    let s = try await current()
    guard CompanyGate.allows(.connect, status: s) else { return s }
    let url = try await api.connect()
    guard CompanyAuthorize.isSafe(url, control: s.controlURL) else { throw CompanyError.unsafeURL }
    pendingSignIn = url
    onPending(url)
    defer { pendingSignIn = nil }
    let startedRevoked = s.phase == .revoked
    let errorBefore = s.lastError
    var waited = 0.0
    while true {
      if let now = try? await refresh() {
        if now.isConnected { return await settleNotice(now) }
        if now.lastError != errorBefore, now.lastError?.hasPrefix("connect failed") == true { throw CompanyError.signInTimedOut }
        switch now.phase {
        case .connecting: break
        case .revoked where startedRevoked: break
        case .revoked: throw CompanyError.revoked
        default: if waited > 0 { throw CompanyError.signInTimedOut }
        }
      }
      if waited >= connectTimeout { throw CompanyError.signInTimedOut }
      await sleep(pollInterval)
      waited += max(pollInterval, 0.001)
    }
  }

  func acknowledgeNotice() async throws -> CompanyStatus {
    let s = try await current()
    guard let notice = s.notice, CompanyGate.allows(.acknowledge, status: s) else {
      throw s.isConnected ? CompanyError.noNotice : CompanyError.notConnected
    }
    try await mutate { try await api.acknowledge(noticeVersionId: notice.noticeVersionId) }
    // The ack landed; a failed read after it must not report it as failed.
    if let now = try? await refresh() { return now }
    var acked = s
    acked.noticeAcknowledged = true
    status = acked
    return acked
  }

  func sharePreview(workflowId: String) async throws -> SharePreview {
    try gate(.share, try await current())
    return try await api.sharePreview(workflowId: workflowId)
  }

  func confirmShare(workflowId: String, hash: String) async throws -> SharePreview {
    try gate(.share, try await current())
    guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { throw CompanyError.badHash }
    return try await api.confirmShare(workflowId: workflowId, hash: hash)
  }

  func setPaused(_ paused: Bool) async throws -> CompanyStatus {
    try gate(paused ? .pause : .resume, try await current())
    let s = try await mutate { try await api.setPaused(paused) }
    status = s
    return s
  }

  private func gate(_ a: CompanyGate.Action, _ s: CompanyStatus) throws {
    guard CompanyGate.allows(a, status: s) else {
      if s.waitingForNotice { throw CompanyError.noticeFirst }
      if s.checkingNotice { throw CompanyError.noticeUnknown }
      throw CompanyError.notConnected
    }
  }
}
