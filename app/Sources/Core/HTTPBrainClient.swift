import Foundation

// s09a: the live BrainClient. Talks to the brain's local API (brain/API.md) on 127.0.0.1 with the per-launch
// bearer token, decodes the BrainWire mirror and maps it onto the view models. Every error becomes a BrainError,
// which the UI shows as one calm sentence (BrainError.userMessage).

/// Where the brain listens right now and the token it expects. Changes when the supervisor restarts it.
struct BrainEndpoint: Equatable, Sendable {
  var baseURL: URL
  var token: String
}

/// Thread-safe holder for the current endpoint. The supervisor writes it; the client reads it per request.
final class BrainEndpointBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: BrainEndpoint?
  private var startingFlag = false

  init(_ e: BrainEndpoint? = nil) { value = e }

  var endpoint: BrainEndpoint? {
    get { lock.withLock { value } }
    set { lock.withLock { value = newValue } }
  }

  /// True while the app has launched the brain and waits for its first line.
  var starting: Bool {
    get { lock.withLock { startingFlag } }
    set { lock.withLock { startingFlag = newValue } }
  }
}

/// One HTTP exchange. URLSession in the app, a stub in tests.
protocol BrainTransport: Sendable {
  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

struct URLSessionTransport: BrainTransport {
  let session: URLSession

  /// Ephemeral: no cache, no cookies, no proxy (loopback only).
  init(timeout: TimeInterval = HTTPBrainClient.defaultTimeout) {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = timeout
    c.timeoutIntervalForResource = timeout * 2
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    c.urlCache = nil
    c.httpCookieStorage = nil
    c.httpShouldSetCookies = false
    c.connectionProxyDictionary = [:]
    c.waitsForConnectivity = false
    session = URLSession(configuration: c)
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw BrainError.badResponse("not an HTTP response") }
    return (data, http)
  }
}

struct HTTPBrainClient: BrainClient {
  static let defaultTimeout: TimeInterval = 10
  /// Dry runs draft with a model; give them longer.
  static let dryRunTimeout: TimeInterval = 120

  let endpoint: BrainEndpointBox
  let transport: BrainTransport
  /// Observer permissions for the dashboard's Observing section (from `offload-observer status --json`).
  let permissions: @Sendable () async -> [PermissionState]
  let calendar: Calendar

  init(endpoint: BrainEndpointBox, transport: BrainTransport = URLSessionTransport(),
       permissions: @escaping @Sendable () async -> [PermissionState] = { [] }, calendar: Calendar = .current) {
    self.endpoint = endpoint
    self.transport = transport
    self.permissions = permissions
    self.calendar = calendar
  }

  // MARK: requests

  /// Percent-encodes one path segment (ids never carry a slash through).
  static func segment(_ s: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#%")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
  }

  func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil,
                   timeout: TimeInterval = HTTPBrainClient.defaultTimeout) throws -> URLRequest {
    guard let ep = endpoint.endpoint else { throw endpoint.starting ? BrainError.starting : BrainError.unreachable }
    guard var c = URLComponents(url: ep.baseURL, resolvingAgainstBaseURL: false) else { throw BrainError.unreachable }
    c.path = "/" + path.drop(while: { $0 == "/" })
    c.queryItems = query.isEmpty ? nil : query
    guard let url = c.url else { throw BrainError.badRequest(path) }
    var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    r.httpMethod = method
    r.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
    r.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      r.setValue("application/json", forHTTPHeaderField: "Content-Type")
      r.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
    }
    return r
  }

  /// Maps a non-2xx response onto a BrainError, using the brain's `{ error, message }` body when present.
  static func error(status: Int, data: Data, path: String) -> BrainError {
    let body = try? BrainWire.decoder.decode(ErrorResponse.self, from: data)
    let message = body?.message ?? ""
    switch status {
    case 401, 403: return .unauthorized
    case 404: return .notFound(message.isEmpty ? path : message)
    case 409: return .conflict(message)
    case 400, 405, 413: return .badRequest(message.isEmpty ? (body?.error ?? "\(status)") : message)
    default: return .server(status, message.isEmpty ? (body?.error ?? "status \(status)") : message)
    }
  }

  static func map(_ error: Error) -> BrainError {
    if let b = error as? BrainError { return b }
    if let u = error as? URLError {
      switch u.code {
      case .timedOut: return .timedOut
      case .cannotConnectToHost, .networkConnectionLost, .cannotFindHost, .notConnectedToInternet,
           .dnsLookupFailed, .resourceUnavailable, .badServerResponse:
        return .unreachable
      default: return .unreachable
      }
    }
    if error is DecodingError { return .badResponse("decode") }
    return .unreachable
  }

  func call<T: Decodable>(_ type: T.Type, _ method: String, _ path: String, query: [URLQueryItem] = [],
                          body: [String: Any]? = nil, timeout: TimeInterval = HTTPBrainClient.defaultTimeout) async throws -> T {
    let request = try makeRequest(method, path, query: query, body: body, timeout: timeout)
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.send(request)
    } catch {
      throw Self.map(error)
    }
    guard (200..<300).contains(response.statusCode) else {
      throw Self.error(status: response.statusCode, data: data, path: path)
    }
    do {
      return try BrainWire.decoder.decode(T.self, from: data)
    } catch {
      throw BrainError.badResponse("\(path): \(error)")
    }
  }

  private func get<T: Decodable>(_ type: T.Type, _ path: String, query: [URLQueryItem] = []) async throws -> T {
    try await call(type, "GET", path, query: query)
  }

  // MARK: BrainClient

  func status() async throws -> ObserverStatus { try await get(StatusResponse.self, "status").toObserverStatus() }

  func insights() async throws -> [Insight] { try await get(InsightsResponse.self, "insights").toInsights() }

  func evidence(insightId: String) async throws -> [EvidenceSpan] {
    try await get(EvidenceResponse.self, "insights/\(Self.segment(insightId))/evidence").toEvidenceSpans()
  }

  func automations() async throws -> [Automation] { try await get(DashboardResponse.self, "dashboard").toAutomations() }

  func connectorStates() async throws -> [String: ConnectorState] {
    try await get(ConnectorsResponse.self, "connectors").states()
  }

  /// s10e: POST /connectors/:id/link. The brain starts Composio's sign-in (or its demo simulation); nothing is sent.
  func startLink(connectorId: String) async throws -> ConnectLink {
    try await call(ConnectLinkDTO.self, "POST", "connectors/\(Self.segment(connectorId))/link", body: [:]).toLink()
  }

  /// s10e: GET /connectors/:id/link, polled by the connect sheet.
  func linkStatus(connectorId: String) async throws -> ConnectLink {
    try await get(ConnectLinkDTO.self, "connectors/\(Self.segment(connectorId))/link").toLink()
  }

  func workflow(id: String) async throws -> Workflow {
    let dto = try await get(WorkflowDTO.self, "workflows/\(Self.segment(id))")
    return dto.toWorkflow(dryRunHash: dto.pendingDryRunHash)
  }

  /// POST /workflows/draft: 201 new, 200 the existing draft for this insight.
  func workflow(forInsight insightId: String) async throws -> Workflow {
    let dto = try await call(WorkflowDTO.self, "POST", "workflows/draft", body: ["insightId": insightId])
    return dto.toWorkflow(dryRunHash: dto.pendingDryRunHash)
  }

  func dryRun(workflowId: String, limit: Int) async throws -> DryRun {
    let n = min(50, max(1, limit))
    return try await call(DryRunResponse.self, "POST", "workflows/\(Self.segment(workflowId))/dry-run",
                          body: ["limit": n], timeout: Self.dryRunTimeout).toDryRun()
  }

  /// GET /workflows/:id/dry-runs/latest (s09b). nil when none is stored (404) or the brain predates the route.
  func latestDryRun(workflowId: String) async throws -> DryRun? {
    do {
      return try await get(DryRunResponse.self, "workflows/\(Self.segment(workflowId))/dry-runs/latest").toDryRun()
    } catch BrainError.notFound {
      return nil
    } catch BrainError.badRequest {
      return nil
    }
  }

  /// POST approve, then GET the detail (the approve response carries the summary only, without steps).
  func approve(workflowId: String, batchHash: String) async throws -> Workflow {
    let r = try await call(ApproveResponse.self, "POST", "workflows/\(Self.segment(workflowId))/approve",
                           body: ["batchHash": batchHash])
    if let full = try? await get(WorkflowDTO.self, "workflows/\(Self.segment(workflowId))") {
      return full.toWorkflow(dryRunHash: batchHash)
    }
    return r.workflow.toWorkflow(dryRunHash: batchHash)
  }

  func discard(workflowId: String) async throws {
    struct Deleted: Decodable { var deleted: String }
    _ = try await call(Deleted.self, "DELETE", "workflows/\(Self.segment(workflowId))")
  }

  func toneCard(workflowId: String) async throws -> ToneCard {
    try await get(ToneCard.self, "workflows/\(Self.segment(workflowId))/tone")
  }

  func saveToneCard(workflowId: String, text: String) async throws -> ToneCard {
    try await call(ToneCard.self, "PUT", "workflows/\(Self.segment(workflowId))/tone", body: ["text": text])
  }

  func skill(workflowId: String) async throws -> SkillDoc {
    try await get(SkillDoc.self, "workflows/\(Self.segment(workflowId))/skill")
  }

  func saveSkill(workflowId: String, edit: SkillEdit) async throws -> SkillDoc {
    try await call(SkillDoc.self, "PUT", "workflows/\(Self.segment(workflowId))/skill", body: edit.body)
  }

  /// GET /observer (s05c). nil when the brain could not ask the observer, or is older than s05c (404).
  func observer() async throws -> ObserverReport? {
    do {
      return try await get(ObserverResponseDTO.self, "observer").report
    } catch BrainError.notFound {
      return nil
    }
  }

  /// POST /workflows/:id/auto-run {enabled} (s10b): the summary carries `autoRunPin` when it was turned on.
  func setAutoRun(workflowId: String, enabled: Bool) async throws -> AutoRunResult {
    let dto = try await call(WorkflowDTO.self, "POST", "workflows/\(Self.segment(workflowId))/auto-run", body: ["enabled": enabled])
    return AutoRunResult(workflowId: dto.id, enabled: dto.autoRun, pin: dto.autoRunPin)
  }

  /// GET /observer keptFiles (s10b). Empty from an older brain.
  func keptFiles() async throws -> [KeptFile] {
    do {
      return (try await get(ObserverResponseDTO.self, "observer").keptFiles ?? []).map(KeptFile.init)
    } catch BrainError.notFound {
      return []
    }
  }

  /// Permission rows: the brain's GET /observer first, then the app's own observer CLI.
  func permissionRows() async -> [PermissionState] {
    if let r = try? await observer() { return r.permissionRows() }
    return await permissions()
  }

  /// GET /dashboard + /status + /workflows + /connectors + one /timeline per stored day (at most 7).
  func dashboard() async throws -> DashboardData {
    async let dash = get(DashboardResponse.self, "dashboard")
    async let st = get(StatusResponse.self, "status")
    async let wfs = get(WorkflowsResponse.self, "workflows")
    let (d, s, w) = try await (dash, st, wfs)
    let connectors = (try? await connectorStates()) ?? [:]
    let days = DashboardComposer.timelineDays(s)
    let timelines = await withTaskGroup(of: TimelineResponse?.self) { group -> [TimelineResponse] in
      for day in days {
        group.addTask { try? await self.get(TimelineResponse.self, "timeline", query: [URLQueryItem(name: "day", value: day)]) }
      }
      var out: [TimelineResponse] = []
      for await t in group { if let t { out.append(t) } }
      return out
    }
    return DashboardComposer.compose(dashboard: d, status: s, workflows: w.workflows, connectors: connectors,
                                     timelines: timelines, permissions: await permissionRows(), calendar: calendar, now: Date())
  }
}

extension WorkflowDTO {
  /// The pending dry-run batch's hash: approving it marks the workflow reviewed.
  var pendingDryRunHash: String? {
    guard let b = pendingBatch, b.kind == "dry_run", b.state == "pending" else { return nil }
    return b.hash
  }
}

/// Builds the dashboard's view model from the brain's routes. Pure, so it is tested without a brain.
enum DashboardComposer {
  /// Named tasks get the three pastels; the rest share the neutral "Everything else" row.
  static let namedTasks = 3
  static let otherTaskId = "other"

  /// The newest stored days, oldest first, at most keepDays.
  static func timelineDays(_ s: StatusResponse) -> [String] {
    Array(s.store.days.map(\.day).sorted().suffix(max(1, s.retention.keepDays)))
  }

  static func compose(dashboard d: DashboardResponse, status s: StatusResponse, workflows: [WorkflowDTO],
                      connectors: [String: ConnectorState], timelines: [TimelineResponse],
                      permissions: [PermissionState], calendar: Calendar = .current, now: Date? = nil) -> DashboardData {
    let byId = Dictionary(workflows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let autos = d.automations.map { a -> DashboardAutomation in
      let wf = byId[a.workflowId ?? a.id]
      var m = a.toDashboardAutomation(taskId: wf?.taskId)
      m.autoRun = wf?.autoRun ?? false
      m.activatedAt = wf?.activatedAt.map(BrainWire.date(ms:))
      m.autoRunPeople = wf?.autoRunPin?.pinnedRecipients.count
      m.connectors = m.connectors.map { $0.applying(connectors) }
      // The brain's reasons are fragments ("connect Gmail first"); the row shows sentences.
      if let reasons = a.needsYou, !reasons.isEmpty { m.needsYouReason = reasons.map(BrainError.sentence).joined(separator: " ") }
      return m
    }

    // Tasks by total minutes across the week; the top three keep their names.
    var minutes: [String: (name: String, minutes: Double)] = [:]
    for t in timelines { for b in t.byTask { minutes[b.taskId, default: (b.name, 0)].minutes += b.minutes } }
    let ranked = minutes.sorted { ($0.value.minutes, $1.key) > ($1.value.minutes, $0.key) }
    let named = Array(ranked.prefix(namedTasks))
    let namedIds = Set(named.map(\.key))
    var activeSince: [String: Date] = [:]
    for w in workflows {
      if let at = w.activatedAt { activeSince[w.taskId] = BrainWire.date(ms: at) }
    }
    var tasks = named.enumerated().map { i, e in
      TimelineTask(id: e.key, name: e.value.name, tint: i, automated: activeSince[e.key] != nil)
    }
    if ranked.count > named.count { tasks.append(TimelineTask(id: otherTaskId, name: "Everything else", tint: 3, automated: false)) }

    var days = timelines.sorted { $0.day < $1.day }.map { t -> TimelineDay in
      var day = t.toTimelineDay(activeSince: activeSince, calendar: calendar)
      day.bars = day.bars.map { b in
        var b = b
        if !namedIds.contains(b.taskId) { b.taskId = otherTaskId }
        return b
      }
      return day
    }

    // s10d: today always has a row (empty until the observer writes it), so the "now" marker has somewhere to sit.
    if let now {
      let today = calendar.startOfDay(for: now)
      if !days.contains(where: { calendar.isDate($0.date, inSameDayAs: today) }), days.last.map({ $0.date < today }) ?? true {
        let f = DateFormatter()
        f.calendar = calendar
        f.timeZone = calendar.timeZone
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        days.append(TimelineDay(day: f.string(from: today), date: today, bars: []))
      }
    }

    let observing = ObservingState(
      state: ObserverState(wire: s.observer.state), daysStored: s.store.days.count, keepDays: s.retention.keepDays,
      nextPurgeDay: s.retention.nextPurgeDay, nextPurgeAt: s.retention.nextPurgeAt.map(BrainWire.date(ms:)),
      permissions: permissions)
    return DashboardData(automations: autos, hours: d.hoursSaved, observing: observing, tasks: tasks, days: days)
  }
}
