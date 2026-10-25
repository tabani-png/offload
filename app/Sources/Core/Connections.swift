import Foundation

// s17: the Connections center. Any app Composio supports can be found, set up once and handed to the workflow
// builder. Three ways to set an app up: sign in through Composio (the s10e connect flow, reused as it is), an API key
// the app writes straight into the macOS Keychain (the brain only ever gets the item's name), or a connector server
// (an https address or a command). Nothing here approves or sends: setup and test only read, build ends in a dry run.

// MARK: models

enum ConnectionStatus: String, Equatable, Sendable {
  case connected
  case needsYou = "needs_you"
  case notSetUp = "not_set_up"

  init(wire: String) { self = ConnectionStatus(rawValue: wire) ?? .notSetUp }

  /// One colour map (s10e M7): green connected, amber needs you, grey not set up.
  var role: StatusRole {
    switch self {
    case .connected: return .done
    case .needsYou: return .needsYou
    case .notSetUp: return .neutral
    }
  }

  var label: String {
    switch self {
    case .connected: return "Connected"
    case .needsYou: return "Needs you"
    case .notSetUp: return "Not set up"
    }
  }
}

/// How an app is set up. The wire names are the brain's (`mcp` is a connector server).
enum SetupMethod: String, Equatable, Sendable, CaseIterable {
  case composio
  case apiKey = "api_key"
  case server = "mcp"
}

struct ConnectionRow: Equatable, Sendable, Identifiable {
  var id: String
  var name: String
  var toolkit: String?
  var description: String
  var status: ConnectionStatus
  var statusLine: String
  /// Hand-checked by Offload; false = from the Composio list, approved field by field.
  var verified: Bool
  var reads: Int
  var commits: Int
  var method: SetupMethod?
}

struct ConnectionsPage: Equatable, Sendable {
  var query: String
  var rows: [ConnectionRow]
  var apps: Int
  var tools: Int
  var syncedAt: Date?
  var stale: Bool
  var note: String?
}

struct ConnectionMethodInfo: Equatable, Sendable {
  var method: SetupMethod
  var title: String
  var detail: String
  var steps: [String]
  var recommended: Bool
}

struct ConnectionTest: Equatable, Sendable {
  var ok: Bool
  var detail: String
  var tools: Int?
}

struct ConnectionDetail: Equatable, Sendable {
  var row: ConnectionRow
  var methods: [ConnectionMethodInfo]
  var sampleRead: [String]
  var sampleCommit: [String]
  var setupMethod: SetupMethod?
  /// Where the secret lives, by name ("Keychain: offload.connection.tk-linear").
  var secretRef: String?
  var server: String?
  var lastTest: ConnectionTest?
  /// Where this connection's API key goes (generic password item).
  var keychainService: String
  var keychainAccount: String
  var canBuild: Bool
}

struct ConnectionBuild: Equatable, Sendable {
  var workflowId: String
  var workflowName: String
  var instances: Int
  var commitTool: String?
  var missing: [String]
}

/// What the app sends to POST /connections/:id/setup. References only: never a secret value.
enum ConnectionSetup: Equatable, Sendable {
  case apiKey(service: String, account: String, baseURL: String?, healthPath: String?)
  case serverURL(String, headerService: String? = nil, headerAccount: String? = nil)
  case serverCommand(String, args: [String])

  var body: [String: Any] {
    switch self {
    case .apiKey(let service, let account, let baseURL, let healthPath):
      var b: [String: Any] = ["method": "api_key", "secret": ["keychain": ["service": service, "account": account]]]
      if let baseURL { b["baseUrl"] = baseURL }
      if let healthPath { b["healthPath"] = healthPath }
      return b
    case .serverURL(let url, let service, let account):
      var b: [String: Any] = ["method": "mcp", "url": url]
      if let service, let account { b["headers"] = ["Authorization": ["keychain": ["service": service, "account": account]]] }
      return b
    case .serverCommand(let command, let args):
      return ["method": "mcp", "command": command, "args": args]
    }
  }
}

// MARK: secrets

enum SecretStoreError: Error, Equatable {
  case invalid(String)
  case failed(String)
}

/// Where the app keeps a connection's secret: the macOS Keychain in the app (KeychainStore.swift), a fake in tests.
protocol SecretStore: Sendable {
  /// Adds or replaces the generic password item. Never logs the value.
  func save(_ secret: String, service: String, account: String) throws
  /// True when the item exists (its value is not read).
  func contains(service: String, account: String) -> Bool
}

/// The secure field's content. It is handed over once and then cleared; it is never shown again.
struct APIKeyEntry: Equatable, Sendable {
  private(set) var text = ""
  private(set) var saved = false

  mutating func edit(_ s: String) {
    text = s
    saved = false
  }

  /// Why the text cannot be a key, in plain words; nil when it can.
  var problem: String? { Self.problem(text.trimmingCharacters(in: .whitespacesAndNewlines)) }

  static func problem(_ v: String) -> String? {
    if v.isEmpty { return "Paste the key first." }
    if v.count > 4096 { return "That is longer than any API key." }
    if v.rangeOfCharacter(from: .whitespacesAndNewlines) != nil { return "An API key has no spaces or line breaks. Copy just the key." }
    return nil
  }

  /// The trimmed key, once; the field is empty afterwards. nil when it is not a key.
  mutating func take() -> String? {
    let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !saved, Self.problem(v) == nil else { return nil }
    text = ""
    saved = true
    return v
  }
}

enum ConnectionKeySaver {
  /// Writes the key into the Keychain item the brain named for this connection, then tells the brain only the item's
  /// name. A key that is not plain, or a Keychain that refuses, stops before anything is sent.
  static func save(_ value: String, detail: ConnectionDetail, store: SecretStore, client: BrainClient) async throws -> ConnectionDetail {
    let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if let p = APIKeyEntry.problem(v) { throw SecretStoreError.invalid(p) }
    try store.save(v, service: detail.keychainService, account: detail.keychainAccount)
    return try await client.setupConnection(id: detail.row.id, .apiKey(service: detail.keychainService, account: detail.keychainAccount, baseURL: nil, healthPath: nil))
  }
}

// MARK: the list

/// The center's list: the search words, the brain's rows (in its order) and the selection. Keyboard-first.
struct ConnectionsList: Equatable, Sendable {
  enum Key: Equatable, Sendable { case up, down, open, escape, find }
  enum Effect: Equatable, Sendable {
    case search(String)
    case open(String)
    case close
    case focusSearch
  }

  static let queryMax = 80
  private(set) var query = ""
  private(set) var rows: [ConnectionRow] = []
  private(set) var selected = 0

  var selectedRow: ConnectionRow? { rows.indices.contains(selected) ? rows[selected] : nil }

  /// The search field changed: ask the brain (it ranks; the app never reorders).
  mutating func type(_ q: String) -> [Effect] {
    query = q
    selected = 0
    return [.search(String(q.trimmingCharacters(in: .whitespacesAndNewlines).prefix(Self.queryMax)))]
  }

  mutating func receive(_ r: [ConnectionRow]) {
    rows = r
    selected = min(selected, max(0, r.count - 1))
  }

  mutating func select(_ id: String) {
    if let i = rows.firstIndex(where: { $0.id == id }) { selected = i }
  }

  mutating func handle(_ k: Key) -> [Effect] {
    switch k {
    case .up:
      selected = max(0, selected - 1)
      return []
    case .down:
      selected = min(max(0, rows.count - 1), selected + 1)
      return []
    case .open:
      return selectedRow.map { [.open($0.id)] } ?? []
    case .escape:
      if !query.isEmpty { return type("") }
      return [.close]
    case .find:
      return [.focusSearch]
    }
  }
}

// MARK: the detail sheet

/// One app's sheet: choose a way, one white button, then test and build. Pure; the view runs the effects.
struct ConnectionSheetFlow: Equatable, Sendable {
  enum Phase: Equatable, Sendable {
    case choose, enterKey, enterServer
    case working(String)
    case ready
    case failed(String)
    case built(ConnectionBuild)
  }

  enum Effect: Equatable, Sendable {
    /// The s10e connect sheet for this connector (Composio sign-in).
    case signIn(Connector)
    /// Save the key into the Keychain, then send its name.
    case saveKey
    case addServer(ConnectionSetup)
    case test
    case build
    case openReview(String)
    case close
  }

  private(set) var detail: ConnectionDetail
  private(set) var method: SetupMethod
  private(set) var phase: Phase
  /// The last plain sentence about this connection (a test result, the build).
  private(set) var status: String?
  var key = APIKeyEntry()
  var serverText = ""

  init(detail: ConnectionDetail) {
    self.detail = detail
    method = detail.methods.first(where: \.recommended)?.method ?? detail.methods.first?.method ?? .composio
    phase = detail.row.status == .connected ? .ready : .choose
    status = detail.row.status == .notSetUp ? nil : detail.row.statusLine
  }

  var name: String { detail.row.name }
  var methodInfo: ConnectionMethodInfo? { detail.methods.first { $0.method == method } }

  /// 1, 2, 3: pick a way (only while choosing).
  mutating func chooseNumber(_ n: Int) {
    guard phase == .choose || phase == .ready, detail.methods.indices.contains(n - 1) else { return }
    method = detail.methods[n - 1].method
    phase = .choose
  }

  var primaryTitle: String? {
    switch phase {
    case .choose:
      switch method {
      case .composio: return "Sign in to \(name)"
      case .apiKey: return "Paste the API key"
      case .server: return "Add the server"
      }
    case .enterKey: return "Save in Keychain"
    case .enterServer: return "Add and check"
    case .working: return nil
    case .ready: return detail.canBuild ? "Build workflow" : "Done"
    case .failed: return "Try again"
    case .built: return "Open the review"
    }
  }

  var primaryEnabled: Bool {
    switch phase {
    case .enterKey: return key.problem == nil
    case .enterServer: return Self.parseServer(serverText) != nil
    case .working: return false
    default: return true
    }
  }

  var serverProblem: String? {
    let s = serverText.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.isEmpty { return nil }
    if s.hasPrefix("http://") && !(s.hasPrefix("http://127.0.0.1") || s.hasPrefix("http://localhost")) { return "The address must start with https://." }
    return Self.parseServer(s) == nil ? "Paste the server's https address, or the command that starts it." : nil
  }

  /// An https address (plain http only on this Mac) or a command line; nil when it is neither or carries a secret.
  static func parseServer(_ raw: String) -> ConnectionSetup? {
    let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !s.isEmpty, s.count <= 500, !s.contains("\n") else { return nil }
    let secretish = try! NSRegularExpression(pattern: "([?&](api[_-]?key|token|secret|key|access_token)=)|(--?(api[_-]?key|token|secret|password)=)|(Bearer\\s)|([A-Za-z0-9_]{32,})", options: [.caseInsensitive])
    if secretish.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil { return nil }
    if s.hasPrefix("https://") || s.hasPrefix("http://127.0.0.1") || s.hasPrefix("http://localhost") {
      guard let u = URL(string: s), u.host != nil, u.user == nil else { return nil }
      return .serverURL(s)
    }
    if s.contains("://") { return nil }
    let words = s.split(separator: " ").map(String.init)
    guard let cmd = words.first else { return nil }
    return .serverCommand(cmd, args: Array(words.dropFirst()))
  }

  mutating func primary() -> [Effect] {
    switch phase {
    case .choose:
      switch method {
      case .composio:
        return [.signIn(Connector(id: detail.row.id, name: name, kind: .composio, connected: false))]
      case .apiKey:
        phase = .enterKey
        return []
      case .server:
        phase = .enterServer
        return []
      }
    case .enterKey:
      guard key.problem == nil else { return [] }
      phase = .working(ConnectionsCopy.saving)
      return [.saveKey]
    case .enterServer:
      guard let s = Self.parseServer(serverText) else { return [] }
      phase = .working(ConnectionsCopy.checking)
      return [.addServer(s)]
    case .working:
      return []
    case .ready:
      guard detail.canBuild else { return [.close] }
      phase = .working(ConnectionsCopy.building)
      return [.build]
    case .failed:
      phase = method == .apiKey ? .enterKey : method == .server ? .enterServer : .choose
      return []
    case .built(let b):
      return [.openReview(b.workflowId)]
    }
  }

  /// Esc: back one step, then close.
  mutating func back() -> [Effect] {
    switch phase {
    case .enterKey, .enterServer, .failed:
      phase = .choose
      return []
    default:
      return [.close]
    }
  }

  /// The s10e connect sheet reported connected.
  mutating func signedIn() {
    detail.row.status = .connected
    status = "\(name) is connected."
    phase = .ready
  }

  /// The brain stored the reference: check it right away.
  mutating func saved(_ d: ConnectionDetail) {
    detail = d
    status = ConnectionsCopy.savedInKeychain
    phase = .working(ConnectionsCopy.checking)
  }

  mutating func tested(_ t: ConnectionTest) {
    status = t.detail
    if t.ok {
      detail.row.status = .connected
      phase = .ready
    } else {
      detail.row.status = .needsYou
      phase = .failed(t.detail)
    }
  }

  mutating func built(_ b: ConnectionBuild) {
    status = "Drafted \"\(b.workflowName)\" and tried it on \(b.instances) of your past items. Nothing was sent."
    phase = .built(b)
  }

  mutating func failed(_ message: String) {
    status = message
    phase = .failed(message)
  }
}

// MARK: copy

enum ConnectionsCopy {
  static let title = "Connections"
  static let subtitle = "Any app Offload can use for you"
  static let searchPlaceholder = "Search any app"
  static let verifiedChip = "Checked by Offload"
  static let savedInKeychain = "Saved in your Keychain. Offload never shows it again."
  static let saving = "Saving in your Keychain…"
  static let checking = "Checking with one read…"
  static let building = "Drafting the workflow and trying it on your past items…"
  static let keyPlaceholder = "Paste the API key"
  static let serverPlaceholder = "https://… or the command that starts it"
  static let nothingSent = "Setting up and testing only read. Nothing is sent until you approve a batch."
  static let empty = "No app matches. Try the app's name or what you do in it."

  static func universeLine(_ p: ConnectionsPage) -> String {
    if let note = p.note { return note }
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "en_US")
    let apps = f.string(from: NSNumber(value: p.apps)) ?? "\(p.apps)"
    let tools = f.string(from: NSNumber(value: p.tools)) ?? "\(p.tools)"
    return "\(apps) apps and \(tools) tools through Composio." + (p.stale ? " Updating the list in the background." : "")
  }

  static func missingLine(_ b: ConnectionBuild) -> String? {
    guard !b.missing.isEmpty else { return nil }
    let words = b.missing.map { m -> String in
      let spaced = m.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression)
        .replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: ".", with: " ").lowercased()
      return spaced.replacingOccurrences(of: "\\bid\\b", with: "ID", options: .regularExpression).replacingOccurrences(of: "\\bids\\b", with: "IDs", options: .regularExpression)
    }
    return "Set up once before it can save: \(words.joined(separator: ", "))."
  }

  static func rowCounts(_ r: ConnectionRow) -> String {
    if r.reads + r.commits == 0 { return r.verified ? "Checked by Offload" : "" }
    return "\(r.reads) ways to read, \(r.commits) actions you approve"
  }

  static var all: [String] {
    [title, subtitle, searchPlaceholder, verifiedChip, savedInKeychain, saving, checking, building, keyPlaceholder, serverPlaceholder, nothingSent, empty,
     "Sign in to Linear", "Paste the API key", "Add the server", "Save in Keychain", "Add and check", "Build workflow", "Try again", "Open the review",
     "The address must start with https://.", "Paste the server's https address, or the command that starts it.",
     APIKeyEntry.problem("") ?? "", APIKeyEntry.problem("a b") ?? "", APIKeyEntry.problem(String(repeating: "a", count: 5000)) ?? ""]
  }
}

// MARK: wire (brain/src/api/types.ts "s17")

struct ConnectionRowDTO: Codable, Equatable {
  struct Tools: Codable, Equatable { var read: Int; var commit: Int; var denied: Int }
  var id: String
  var name: String
  var toolkit: String?
  var description: String
  var status: String
  var statusLine: String
  var verified: Bool
  var tools: Tools
  var method: String?

  func toRow() -> ConnectionRow {
    ConnectionRow(id: id, name: name, toolkit: toolkit, description: description, status: ConnectionStatus(wire: status), statusLine: statusLine,
                  verified: verified, reads: tools.read, commits: tools.commit, method: method.flatMap(SetupMethod.init(rawValue:)))
  }
}

struct UniverseStatusWireDTO: Codable, Equatable {
  var syncedAt: Double?
  var stale: Bool
  var toolkits: Int
  var tools: Int
}

struct ConnectionsResponseDTO: Codable, Equatable {
  var query: String
  var connections: [ConnectionRowDTO]
  var universe: UniverseStatusWireDTO
  var note: String?

  func toPage() -> ConnectionsPage {
    ConnectionsPage(query: query, rows: connections.map { $0.toRow() }, apps: universe.toolkits, tools: universe.tools,
                    syncedAt: universe.syncedAt.map(BrainWire.date(ms:)), stale: universe.stale, note: note)
  }
}

struct ConnectionDetailDTO: Codable, Equatable {
  struct Method: Codable, Equatable { var method: String; var title: String; var detail: String; var steps: [String]; var recommended: Bool }
  struct Sample: Codable, Equatable { var read: [String]; var commit: [String] }
  struct Test: Codable, Equatable { var ok: Bool; var detail: String; var tools: Int? }
  struct Setup: Codable, Equatable { var method: String; var secretRef: String?; var server: String?; var test: Test? }
  struct Keychain: Codable, Equatable { var service: String; var account: String }
  var id: String
  var name: String
  var toolkit: String?
  var description: String
  var status: String
  var statusLine: String
  var verified: Bool
  var tools: ConnectionRowDTO.Tools
  var method: String?
  var methods: [Method]
  var sample: Sample
  var setup: Setup?
  var keychain: Keychain
  var canBuild: Bool

  func toDetail() -> ConnectionDetail {
    let row = ConnectionRowDTO(id: id, name: name, toolkit: toolkit, description: description, status: status, statusLine: statusLine, verified: verified, tools: tools, method: method).toRow()
    return ConnectionDetail(
      row: row,
      methods: methods.compactMap { m in SetupMethod(rawValue: m.method).map { ConnectionMethodInfo(method: $0, title: m.title, detail: m.detail, steps: m.steps, recommended: m.recommended) } },
      sampleRead: sample.read, sampleCommit: sample.commit,
      setupMethod: setup.flatMap { SetupMethod(rawValue: $0.method) }, secretRef: setup?.secretRef, server: setup?.server,
      lastTest: setup?.test.map { ConnectionTest(ok: $0.ok, detail: $0.detail, tools: $0.tools) },
      keychainService: keychain.service, keychainAccount: keychain.account, canBuild: canBuild)
  }
}

struct ConnectionTestDTO: Codable, Equatable {
  var ok: Bool
  var detail: String
  var tools: Int?
  func toTest() -> ConnectionTest { ConnectionTest(ok: ok, detail: detail, tools: tools) }
}

struct ConnectionBuildDTO: Codable, Equatable {
  struct WF: Codable, Equatable { var id: String; var name: String }
  struct Dry: Codable, Equatable { var instances: Int; var commitTool: String?; var missing: [String] }
  var workflow: WF
  var dryRun: Dry
  func toBuild() -> ConnectionBuild {
    ConnectionBuild(workflowId: workflow.id, workflowName: workflow.name, instances: dryRun.instances, commitTool: dryRun.commitTool, missing: dryRun.missing)
  }
}

// MARK: the sample brain (snapshots, --mock, tests)

enum MockConnections {
  static let methods: [ConnectionMethodInfo] = [
    ConnectionMethodInfo(method: .composio, title: "Sign in once through Composio", detail: "Composio keeps the sign-in for Offload. Offload never sees your password.",
                         steps: ["Press Sign in. Your browser opens the app's own sign-in page.", "Allow access, then come back here. Offload checks by itself.", "Nothing is sent until you approve a batch."], recommended: true),
    ConnectionMethodInfo(method: .apiKey, title: "Paste an API key", detail: "The key is saved straight into your Mac's Keychain and is never shown again.",
                         steps: ["Open the app's settings and create an API key.", "Paste it into the secure field. Offload stores it in your Keychain, not in a file.", "Offload checks it with one read and nothing else."], recommended: false),
    ConnectionMethodInfo(method: .server, title: "Add a connector server", detail: "For apps that publish their own connector server: its https address, or the command that starts it on this Mac.",
                         steps: ["Copy the server's address or command from the app's help pages.", "If it needs a sign-in, paste it into the secure field. It goes into your Keychain.", "Offload lists what the server offers and calls nothing."], recommended: false),
  ]

  static func row(_ id: String, _ name: String, _ status: ConnectionStatus, verified: Bool, reads: Int, commits: Int, line: String? = nil, description: String = "") -> ConnectionRow {
    let l = line ?? (status == .connected ? "\(name) is connected." : status == .needsYou ? "\(name) needs you: the last check did not pass." : "\(name) is not set up yet.")
    return ConnectionRow(id: id, name: name, toolkit: id.hasPrefix("tk-") ? String(id.dropFirst(3)) : id, description: description, status: status, statusLine: l, verified: verified, reads: reads, commits: commits, method: nil)
  }

  static let rows: [ConnectionRow] = [
    row("gmail", "Gmail", .connected, verified: true, reads: 3, commits: 2),
    row("google-sheets", "Google Sheets", .connected, verified: true, reads: 4, commits: 1),
    row("hubspot", "HubSpot", .needsYou, verified: true, reads: 12, commits: 1, line: "HubSpot needs its sign-in setting."),
    row("slack", "Slack", .notSetUp, verified: true, reads: 9, commits: 1),
    row("tk-linear", "Linear", .notSetUp, verified: false, reads: 18, commits: 21, description: "Issue tracking and project planning for teams."),
    row("tk-stripe", "Stripe", .needsYou, verified: false, reads: 160, commits: 120, line: "Stripe refused the sign-in. Check the API key in Stripe's settings and save it again.", description: "Online payments and billing."),
    row("tk-shopify", "Shopify", .notSetUp, verified: false, reads: 70, commits: 55, description: "Online stores: orders, products and customers."),
    row("tk-freshdesk", "Freshdesk", .notSetUp, verified: false, reads: 30, commits: 25, description: "Customer support software with ticketing."),
    row("tk-asana", "Asana", .notSetUp, verified: false, reads: 40, commits: 38, description: "Work management for teams."),
  ]

  static func page(_ q: String) -> ConnectionsPage {
    let t = q.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let rows = t.isEmpty ? Self.rows : Self.rows.filter { $0.name.lowercased().contains(t) || $0.description.lowercased().contains(t) }
      .sorted { ($0.name.lowercased().hasPrefix(t) ? 0 : 1, $0.verified ? 0 : 1) < ($1.name.lowercased().hasPrefix(t) ? 0 : 1, $1.verified ? 0 : 1) }
    return ConnectionsPage(query: q, rows: rows, apps: 1651, tools: 65602, syncedAt: Date(timeIntervalSince1970: 1_792_500_000), stale: false, note: nil)
  }

  static func detail(_ id: String) -> ConnectionDetail? {
    guard let r = rows.first(where: { $0.id == id }) else { return nil }
    let keyless = r.id == "tk-freshdesk"
    return ConnectionDetail(row: r, methods: keyless ? methods.filter { $0.method != .apiKey } : methods,
                            sampleRead: r.id == "tk-linear" ? ["Get teams", "Search issues", "Get issue"] : ["List items"],
                            sampleCommit: r.id == "tk-linear" ? ["Create issue", "Create a comment", "Update issue"] : ["Create item"],
                            setupMethod: r.status == .notSetUp ? nil : .apiKey, secretRef: r.status == .notSetUp ? nil : "Keychain: offload.connection.\(r.id)",
                            server: nil, lastTest: r.status == .needsYou ? ConnectionTest(ok: false, detail: r.statusLine, tools: nil) : nil,
                            keychainService: "offload.connection.\(r.id)", keychainAccount: "api-key", canBuild: true)
  }

  static let build = ConnectionBuild(workflowId: "wf_support_tickets", workflowName: "Reply to support tickets", instances: 5,
                                     commitTool: "composio:LINEAR_CREATE_LINEAR_COMMENT", missing: ["issueId"])
}

// MARK: clients

extension BrainClient {
  func connections(query: String) async throws -> ConnectionsPage { throw BrainError.notFound("connections") }
  func connection(id: String) async throws -> ConnectionDetail { throw BrainError.notFound("connections/\(id)") }
  func setupConnection(id: String, _ setup: ConnectionSetup) async throws -> ConnectionDetail { throw BrainError.notFound("connections/\(id)/setup") }
  func testConnection(id: String) async throws -> ConnectionTest { throw BrainError.notFound("connections/\(id)/test") }
  func buildWorkflow(connectionId: String) async throws -> ConnectionBuild { throw BrainError.notFound("connections/\(connectionId)/build") }
}

extension MockBrainClient {
  func connections(query: String) async throws -> ConnectionsPage { MockConnections.page(query) }

  func connection(id: String) async throws -> ConnectionDetail {
    guard let d = MockConnections.detail(id) else { throw BrainError.notFound(id) }
    return d
  }

  func setupConnection(id: String, _ setup: ConnectionSetup) async throws -> ConnectionDetail {
    guard var d = MockConnections.detail(id) else { throw BrainError.notFound(id) }
    switch setup {
    case .apiKey(let service, _, _, _):
      d.setupMethod = .apiKey
      d.secretRef = "Keychain: \(service)"
    case .serverURL(let url, _, _):
      d.setupMethod = .server
      d.server = url
    case .serverCommand(let cmd, let args):
      d.setupMethod = .server
      d.server = ([cmd] + args).joined(separator: " ")
    }
    d.row.status = .needsYou
    d.row.statusLine = "Setup for \(d.row.name) has started. Finish it, then test it."
    return d
  }

  func testConnection(id: String) async throws -> ConnectionTest {
    guard let d = MockConnections.detail(id) else { throw BrainError.notFound(id) }
    return ConnectionTest(ok: true, detail: "Demo test for \(d.row.name): nothing was read or started.", tools: nil)
  }

  func buildWorkflow(connectionId: String) async throws -> ConnectionBuild { MockConnections.build }
}

extension HTTPBrainClient {
  /// GET /connections?q=: the brain ranks (catalog first, then the Composio list).
  func connections(query: String) async throws -> ConnectionsPage {
    let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return try await call(ConnectionsResponseDTO.self, "GET", "connections", query: q.isEmpty ? [] : [URLQueryItem(name: "q", value: String(q.prefix(ConnectionsList.queryMax)))]).toPage()
  }

  func connection(id: String) async throws -> ConnectionDetail {
    try await call(ConnectionDetailDTO.self, "GET", "connections/\(Self.segment(id))").toDetail()
  }

  /// POST /connections/:id/setup with references only (ConnectionSetup.body); the brain answers with the detail.
  func setupConnection(id: String, _ setup: ConnectionSetup) async throws -> ConnectionDetail {
    try await call(ConnectionDetailDTO.self, "POST", "connections/\(Self.segment(id))/setup", body: setup.body).toDetail()
  }

  func testConnection(id: String) async throws -> ConnectionTest {
    try await call(ConnectionTestDTO.self, "POST", "connections/\(Self.segment(id))/test", body: [:]).toTest()
  }

  /// POST /connections/:id/build: drafts the workflow with this connection and runs its dry run (nothing is sent).
  func buildWorkflow(connectionId: String) async throws -> ConnectionBuild {
    try await call(ConnectionBuildDTO.self, "POST", "connections/\(Self.segment(connectionId))/build", body: [:], timeout: 120).toBuild()
  }
}
