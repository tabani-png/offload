import Foundation
import Testing

// S17: the Connections center. Any app Composio supports: search it, see its status dot, set it up once (Composio
// sign-in through the s10e connect flow, an API key saved straight into the Keychain, or a connector server), test it,
// then build the workflow. The secret never travels in a request body and is never shown again.

enum S17Fixture {
  /// The s10e lint, except "API key": the vendor's own word on its settings page.
  static let banned = try! NSRegularExpression(pattern: "\\b(token|tokens|MCP|SKILL|gate|json|env)\\b", options: [.caseInsensitive])
  static func plain(_ s: String) -> Bool { banned.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) == nil }

  static func row(_ id: String, _ name: String, _ status: ConnectionStatus, verified: Bool = false) -> ConnectionRow {
    ConnectionRow(id: id, name: name, toolkit: id.hasPrefix("tk-") ? String(id.dropFirst(3)) : id, description: "",
                  status: status, statusLine: "\(name) is not set up yet.", verified: verified, reads: 3, commits: 4, method: nil)
  }

  static let methods: [ConnectionMethodInfo] = [
    ConnectionMethodInfo(method: .composio, title: "Sign in once through Composio", detail: "Composio keeps the sign-in.", steps: ["Press Sign in."], recommended: true),
    ConnectionMethodInfo(method: .apiKey, title: "Paste an API key", detail: "Saved in your Keychain.", steps: ["Open settings."], recommended: false),
    ConnectionMethodInfo(method: .server, title: "Add a connector server", detail: "An https address.", steps: ["Copy the address."], recommended: false),
  ]

  static func detail(_ status: ConnectionStatus = .notSetUp) -> ConnectionDetail {
    ConnectionDetail(row: row("tk-linear", "Linear", status), methods: methods, sampleRead: ["Get teams"], sampleCommit: ["Create issue"],
                     setupMethod: nil, secretRef: nil, server: nil, lastTest: nil,
                     keychainService: "offload.connection.tk-linear", keychainAccount: "api-key", canBuild: true)
  }

  static let key = "lin_api_9f8e7d6c5b4a39281706f5e4d3c2b1a0"
}

/// A Keychain stand-in that records what was saved.
final class FakeSecretStore: SecretStore, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var saved: [String: String] = [:]
  var fail = false
  func save(_ secret: String, service: String, account: String) throws {
    if fail { throw SecretStoreError.failed("locked") }
    lock.withLock { saved["\(service)/\(account)"] = secret }
  }
  func contains(service: String, account: String) -> Bool { lock.withLock { saved["\(service)/\(account)"] != nil } }
}

// MARK: list

@Suite("S17 connections list")
struct S17ListTests {
  let rows = [S17Fixture.row("gmail", "Gmail", .connected, verified: true), S17Fixture.row("slack", "Slack", .needsYou, verified: true),
              S17Fixture.row("tk-linear", "Linear", .notSetUp)]

  @Test("status dots: green connected, amber needs you, grey not set up")
  func dots() {
    #expect(ConnectionStatus.connected.role == .done)
    #expect(ConnectionStatus.needsYou.role == .needsYou)
    #expect(ConnectionStatus.notSetUp.role == .neutral)
    #expect(ConnectionStatus.connected.label == "Connected")
    #expect(ConnectionStatus.needsYou.label == "Needs you")
    #expect(ConnectionStatus.notSetUp.label == "Not set up")
    #expect(ConnectionStatus(wire: "nonsense") == .notSetUp)
  }

  @Test("typing searches the brain with the trimmed words and starts at the first row")
  func typing() {
    var l = ConnectionsList()
    l.receive(rows)
    _ = l.handle(.down)
    #expect(l.type("  lin ") == [.search("lin")])
    #expect(l.selected == 0)
    #expect(l.query == "  lin ")
    #expect(l.type(String(repeating: "x", count: 120)) == [.search(String(repeating: "x", count: 80))])
  }

  @Test("arrow keys move within the rows; return opens the selected one")
  func keys() {
    var l = ConnectionsList()
    l.receive(rows)
    #expect(l.handle(.up) == [])
    #expect(l.selected == 0)
    _ = l.handle(.down)
    _ = l.handle(.down)
    _ = l.handle(.down)
    #expect(l.selected == 2)
    #expect(l.handle(.open) == [.open("tk-linear")])
    #expect(l.selectedRow?.name == "Linear")
  }

  @Test("esc clears the search first, then closes; cmd-F focuses the search field")
  func escape() {
    var l = ConnectionsList()
    l.receive(rows)
    _ = l.type("lin")
    #expect(l.handle(.escape) == [.search("")])
    #expect(l.query == "")
    #expect(l.handle(.escape) == [.close])
    #expect(l.handle(.find) == [.focusSearch])
  }

  @Test("new rows keep the brain's order and clamp the selection")
  func receive() {
    var l = ConnectionsList()
    l.receive(rows)
    _ = l.handle(.down); _ = l.handle(.down)
    l.receive(Array(rows.prefix(1)))
    #expect(l.selected == 0)
    #expect(l.rows.map(\.id) == ["gmail"])
    l.receive([])
    #expect(l.handle(.open) == [])
  }

  @Test("the app list line says how many apps and tools, and when the list is not loaded")
  func universeLine() {
    let page = ConnectionsPage(query: "", rows: rows, apps: 1652, tools: 52594, syncedAt: Date(), stale: false, note: nil)
    #expect(ConnectionsCopy.universeLine(page) == "1,652 apps and 52,594 tools through Composio.")
    let none = ConnectionsPage(query: "", rows: rows, apps: 0, tools: 0, syncedAt: nil, stale: true, note: "The list of apps Composio supports is not loaded yet.")
    #expect(ConnectionsCopy.universeLine(none) == "The list of apps Composio supports is not loaded yet.")
    #expect(ConnectionsCopy.verifiedChip == "Checked by Offload")
  }
}

// MARK: sheet

@Suite("S17 connection sheet")
struct S17SheetTests {
  @Test("the recommended way is chosen first; 1-3 pick a way; the one primary says what it does")
  func choose() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    #expect(f.method == .composio)
    #expect(f.phase == .choose)
    #expect(f.primaryTitle == "Sign in to Linear")
    f.chooseNumber(2)
    #expect(f.method == .apiKey)
    #expect(f.primaryTitle == "Paste the API key")
    f.chooseNumber(3)
    #expect(f.primaryTitle == "Add the server")
    f.chooseNumber(9)
    #expect(f.method == .server)
  }

  @Test("Composio sign-in hands off to the s10e connect flow with a Composio connector")
  func signIn() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    let e = f.primary()
    #expect(e == [.signIn(Connector(id: "tk-linear", name: "Linear", kind: .composio, connected: false))])
    f.signedIn()
    #expect(f.phase == .ready)
    #expect(f.primaryTitle == "Build workflow")
    #expect(f.primary() == [.build])
  }

  @Test("API key: enter, save (only when it looks like a key), then test, then build")
  func apiKey() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    f.chooseNumber(2)
    #expect(f.primary() == [])
    #expect(f.phase == .enterKey)
    #expect(f.primaryTitle == "Save in Keychain")
    #expect(f.primaryEnabled == false)
    f.key.edit("has space inside")
    #expect(f.primaryEnabled == false)
    #expect(f.key.problem != nil)
    f.key.edit(S17Fixture.key)
    #expect(f.primaryEnabled)
    #expect(f.primary() == [.saveKey])
    f.saved(S17Fixture.detail(.needsYou))
    #expect(f.phase == .working(ConnectionsCopy.checking))
    f.tested(ConnectionTest(ok: true, detail: "The key for Linear is saved in your Keychain.", tools: nil))
    #expect(f.phase == .ready)
    #expect(f.status == "The key for Linear is saved in your Keychain.")
  }

  @Test("a failed test says why and offers Try again; esc goes back a step, then closes")
  func failed() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    f.chooseNumber(2)
    _ = f.primary()
    f.tested(ConnectionTest(ok: false, detail: "Linear refused the sign-in.", tools: nil))
    #expect(f.phase == .failed("Linear refused the sign-in."))
    #expect(f.primaryTitle == "Try again")
    #expect(f.primary() == [])
    #expect(f.phase == .enterKey)
    #expect(f.back() == [])
    #expect(f.phase == .choose)
    #expect(f.back() == [.close])
  }

  @Test("a connector server takes an https address or a command; plain http elsewhere is refused")
  func server() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    f.chooseNumber(3)
    _ = f.primary()
    #expect(f.phase == .enterServer)
    f.serverText = "http://mcp.linear.app/mcp"
    #expect(f.primaryEnabled == false)
    #expect(f.serverProblem == "The address must start with https://.")
    f.serverText = "https://mcp.linear.app/mcp"
    #expect(f.primary() == [.addServer(.serverURL("https://mcp.linear.app/mcp"))])
    f.serverText = "npx -y @acme/linear-server"
    #expect(ConnectionSheetFlow.parseServer(f.serverText) == .serverCommand("npx", args: ["-y", "@acme/linear-server"]))
    #expect(ConnectionSheetFlow.parseServer("https://x.io/?api_key=abc") == nil)
  }

  @Test("building ends with the workflow drafted and a dry run, nothing sent; the primary opens the review")
  func build() {
    var f = ConnectionSheetFlow(detail: S17Fixture.detail(.connected))
    #expect(f.phase == .ready)
    #expect(f.primary() == [.build])
    #expect(f.phase == .working(ConnectionsCopy.building))
    let b = ConnectionBuild(workflowId: "wf_1", workflowName: "Reply to support tickets", instances: 5, commitTool: "composio:LINEAR_CREATE_LINEAR_COMMENT", missing: ["issueId"])
    f.built(b)
    #expect(f.primaryTitle == "Open the review")
    #expect(f.primary() == [.openReview("wf_1")])
    #expect(f.status == "Drafted \"Reply to support tickets\" and tried it on 5 of your past items. Nothing was sent.")
    #expect(ConnectionsCopy.missingLine(b) == "Set up once before it can save: issue ID.")
  }

  @Test("every sentence the center shows is plain (the s10e lint, with API key allowed)")
  func copy() {
    var all = ConnectionsCopy.all
    var f = ConnectionSheetFlow(detail: S17Fixture.detail())
    for n in 1...3 { f.chooseNumber(n); all.append(f.primaryTitle ?? "") }
    for s in all { #expect(S17Fixture.plain(s), "\(s)") }
  }
}

// MARK: secrets

@Suite("S17 secrets")
struct S17SecretTests {
  @Test("the key is saved in the Keychain under the connection's own item; the brain gets only the item's name")
  func saves() async throws {
    let store = FakeSecretStore()
    let t = StubTransport(["POST /connections/tk-linear/setup": (200, Data(S17Wire.detailJSON.utf8))])
    let c = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5000/")!, token: String(repeating: "t", count: 40))), transport: t)
    let d = try await ConnectionKeySaver.save(S17Fixture.key, detail: S17Fixture.detail(), store: store, client: c)
    #expect(store.saved["offload.connection.tk-linear/api-key"] == S17Fixture.key)
    #expect(d.row.id == "tk-linear")
    let body = String(data: t.seen.first?.httpBody ?? Data(), encoding: .utf8) ?? ""
    #expect(!body.contains(S17Fixture.key))
    #expect(body.contains("\"service\":\"offload.connection.tk-linear\""))
    #expect(body.contains("\"method\":\"api_key\""))
  }

  @Test("the Keychain item comes from the connection id, never from the brain's answer")
  func derivedItem() async throws {
    let store = FakeSecretStore()
    let t = StubTransport(["POST /connections/tk-linear/setup": (200, Data(S17Wire.detailJSON.utf8))])
    let c = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5000/")!, token: String(repeating: "t", count: 40))), transport: t)
    var d = S17Fixture.detail()
    d.keychainService = "offload.connection.gmail"
    _ = try await ConnectionKeySaver.save(S17Fixture.key, detail: d, store: store, client: c)
    #expect(Array(store.saved.keys) == ["offload.connection.tk-linear/api-key"])
    #expect(ConnectionKeySaver.keychainItem(for: "../x") == nil)
  }

  @Test("a value that is not one plain key is refused before anything is stored or sent")
  func refuses() async {
    let store = FakeSecretStore()
    let t = StubTransport()
    let c = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5000/")!, token: String(repeating: "t", count: 40))), transport: t)
    for bad in ["", "   ", "two words", String(repeating: "a", count: 5000), "line\nbreak"] {
      await #expect(throws: SecretStoreError.self) { _ = try await ConnectionKeySaver.save(bad, detail: S17Fixture.detail(), store: store, client: c) }
    }
    #expect(store.saved.isEmpty)
    #expect(t.seen.isEmpty)
  }

  @Test("after saving, the field is empty and never shows the value again")
  func clears() {
    var e = APIKeyEntry()
    e.edit("  \(S17Fixture.key)\n")
    #expect(e.problem == nil)
    let v = e.take()
    #expect(v == S17Fixture.key)
    #expect(e.text == "")
    #expect(e.saved)
    #expect(e.take() == nil)
    #expect(ConnectionsCopy.savedInKeychain == "Saved in your Keychain. Offload never shows it again.")
  }

  @Test("a Keychain that cannot save stops there: nothing goes to the brain")
  func keychainFails() async {
    let store = FakeSecretStore()
    store.fail = true
    let t = StubTransport()
    let c = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5000/")!, token: String(repeating: "t", count: 40))), transport: t)
    await #expect(throws: SecretStoreError.self) { _ = try await ConnectionKeySaver.save(S17Fixture.key, detail: S17Fixture.detail(), store: store, client: c) }
    #expect(t.seen.isEmpty)
  }

  @Test("setup bodies carry references only")
  func bodies() throws {
    let a = ConnectionSetup.apiKey(service: "offload.connection.tk-linear", account: "api-key", baseURL: nil, healthPath: nil).body
    #expect((a["secret"] as? [String: Any])?["keychain"] != nil)
    let s = ConnectionSetup.serverURL("https://mcp.linear.app/mcp", headerService: "offload.connection.tk-linear", headerAccount: "server").body
    let headers = try #require(s["headers"] as? [String: Any])
    #expect((headers["Authorization"] as? [String: Any])?["keychain"] != nil)
    #expect(ConnectionSetup.serverCommand("npx", args: ["-y", "srv"]).body["command"] as? String == "npx")
  }
}

// MARK: wire

enum S17Wire {
  static let detailJSON = """
  {"version":1,"id":"tk-linear","name":"Linear","toolkit":"linear","description":"Issue tracking.","status":"needs_you",
   "statusLine":"Setup for Linear has started. Finish it, then test it.","verified":false,"tools":{"read":3,"commit":4,"denied":0},
   "method":"api_key","methods":[{"method":"composio","title":"Sign in once through Composio","detail":"d","steps":["a"],"recommended":true},
   {"method":"api_key","title":"Paste an API key","detail":"d","steps":["b"],"recommended":false},
   {"method":"mcp","title":"Add a connector server","detail":"d","steps":["c"],"recommended":false}],
   "sample":{"read":["Get teams"],"commit":["Create issue"]},
   "setup":{"method":"api_key","startedAt":1792500000000,"secretRef":"Keychain: offload.connection.tk-linear","server":null,
            "test":{"ok":false,"detail":"Linear refused the sign-in.","tools":null,"at":1792500001000}},
   "keychain":{"service":"offload.connection.tk-linear","account":"api-key"},"canBuild":true,"model":"stub"}
  """
  static let listJSON = """
  {"version":1,"query":"lin","connections":[{"id":"tk-linear","name":"Linear","toolkit":"linear","description":"","status":"not_set_up",
   "statusLine":"Linear is not set up yet.","verified":false,"tools":{"read":3,"commit":4,"denied":1},"method":null},
   {"id":"linkedin","name":"LinkedIn","toolkit":"linkedin","description":"","status":"connected","statusLine":"LinkedIn is connected.",
   "verified":true,"tools":{"read":0,"commit":0,"denied":0},"method":null}],
   "universe":{"version":1,"syncedAt":1792500000000,"stale":false,"complete":true,"toolkits":1652,"tools":52594,
   "classes":{"read":1,"draft":0,"commit":2,"denied":3},"cliVersion":"0.4.2"},"note":null}
  """
  static let buildJSON = """
  {"version":1,"connectionId":"tk-linear","workflow":{"id":"wf_abc","name":"Reply to support tickets"},
   "dryRun":{"instances":5,"commitTool":"composio:LINEAR_CREATE_LINEAR_COMMENT","missing":["issueId"],"sent":0,"warnings":[]}}
  """
}

@Suite("S17 wire")
struct S17WireTests {
  @Test("the list, the detail and a build decode from the brain's answers")
  func decode() throws {
    let page = try BrainWire.decoder.decode(ConnectionsResponseDTO.self, from: Data(S17Wire.listJSON.utf8)).toPage()
    #expect(page.rows.map(\.id) == ["tk-linear", "linkedin"])
    #expect(page.rows[0].status == .notSetUp)
    #expect(page.rows[1].verified)
    #expect(page.apps == 1652)
    let d = try BrainWire.decoder.decode(ConnectionDetailDTO.self, from: Data(S17Wire.detailJSON.utf8)).toDetail()
    #expect(d.methods.map(\.method) == [.composio, .apiKey, .server])
    #expect(d.lastTest == ConnectionTest(ok: false, detail: "Linear refused the sign-in.", tools: nil))
    #expect(d.secretRef == "Keychain: offload.connection.tk-linear")
    #expect(d.keychainService == "offload.connection.tk-linear")
    let b = try BrainWire.decoder.decode(ConnectionBuildDTO.self, from: Data(S17Wire.buildJSON.utf8)).toBuild()
    #expect(b == ConnectionBuild(workflowId: "wf_abc", workflowName: "Reply to support tickets", instances: 5, commitTool: "composio:LINEAR_CREATE_LINEAR_COMMENT", missing: ["issueId"]))
  }

  @Test("the client asks the brain's routes: search, detail, test and build")
  func routes() async throws {
    let t = StubTransport([
      "GET /connections": (200, Data(S17Wire.listJSON.utf8)),
      "GET /connections/tk-linear": (200, Data(S17Wire.detailJSON.utf8)),
      "POST /connections/tk-linear/test": (200, Data(#"{"version":1,"connectionId":"tk-linear","ok":true,"detail":"Linear is signed in to Composio.","tools":null,"testedAt":1}"#.utf8)),
      "POST /connections/tk-linear/build": (200, Data(S17Wire.buildJSON.utf8)),
    ])
    let c = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:5000/")!, token: String(repeating: "t", count: 40))), transport: t)
    #expect(try await c.connections(query: "lin").rows.count == 2)
    #expect(t.seen[0].url?.query == "q=lin")
    #expect(try await c.connection(id: "tk-linear").row.name == "Linear")
    #expect(try await c.testConnection(id: "tk-linear").ok)
    #expect(try await c.buildWorkflow(connectionId: "tk-linear").workflowId == "wf_abc")
  }

  @Test("the sample brain answers the center without a network")
  func mock() async throws {
    let m = MockBrainClient()
    let all = try await m.connections(query: "")
    #expect(all.rows.contains { $0.status == .connected })
    #expect(all.rows.contains { $0.status == .needsYou })
    #expect(all.rows.contains { $0.status == .notSetUp && !$0.verified })
    let lin = try await m.connections(query: "lin")
    #expect(lin.rows.first?.id == "tk-linear")
    let d = try await m.connection(id: "tk-linear")
    #expect(d.methods.count == 3)
  }
}
