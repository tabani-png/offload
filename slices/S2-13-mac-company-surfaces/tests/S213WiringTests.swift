import Foundation
import Testing

// S2-13 review round 1 (PR #22, codex on a2e4d1a):
// [P1] the Company surfaces were reachable only from the snapshot harness, never from the running app.
// [P2] POST /sync/connect already opens the sign-in page in the brain (SyncClient.connect -> openInBrowser); the app
//      opened it a second time, two tabs for one single-use PKCE loopback.
// These tests read the app's own sources (no window server needed) so a surface that only snapshots construct, or a
// side effect owned by both layers, fails here.

enum S213Source {
  static var repo: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
  }
  static var app: URL { repo.appendingPathComponent("app/Sources") }

  /// The snapshot harness is not production: a type only it constructs is not shipped.
  static let snapshotOnly: Set<String> = ["Snapshotter.swift"]

  static func swiftFiles(_ dir: URL) -> [URL] {
    let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)
    return (e?.allObjects as? [URL] ?? []).filter { $0.pathExtension == "swift" }.sorted { $0.path < $1.path }
  }

  static func read(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

  /// Line and block comments out, so a name in prose is never a reference.
  static func code(_ s: String) -> String {
    var out = s.replacingOccurrences(of: #"/\*[\s\S]*?\*/"#, with: "", options: .regularExpression)
    out = out.components(separatedBy: "\n").map { line -> String in
      guard let r = line.range(of: "//") else { return line }
      return String(line[..<r.lowerBound])
    }.joined(separator: "\n")
    return out
  }

  static func matches(_ pattern: String, _ s: String, options: NSRegularExpression.Options = []) -> [NSTextCheckingResult] {
    let re = try! NSRegularExpression(pattern: pattern, options: options)
    return re.matches(in: s, range: NSRange(s.startIndex..., in: s))
  }

  static func group(_ m: NSTextCheckingResult, _ i: Int, _ s: String) -> String { String(s[Range(m.range(at: i), in: s)!]) }

  struct Chunk { var owner: String; var isExtension: Bool; var file: String; var text: String }

  /// Every top-level declaration (column 0) as one chunk: its owner and the code up to the next one.
  static func chunks(_ url: URL) -> [Chunk] {
    let s = code(read(url))
    let ms = matches(#"^(?:(?:public|private|fileprivate|internal|final|nonisolated)\s+)*(struct|class|enum|actor|protocol|extension)\s+([A-Za-z_]\w*)"#,
                     s, options: [.anchorsMatchLines])
    return ms.enumerated().map { i, m in
      let start = Range(m.range, in: s)!.lowerBound
      let end = i + 1 < ms.count ? Range(ms[i + 1].range, in: s)!.lowerBound : s.endIndex
      return Chunk(owner: group(m, 2, s), isExtension: group(m, 1, s) == "extension", file: url.lastPathComponent,
                   text: String(s[start..<end]))
    }
  }

  static var production: [Chunk] {
    swiftFiles(app).filter { !snapshotOnly.contains($0.lastPathComponent) }.flatMap(chunks)
  }

  /// Types reachable from `OffloadMain` (the app's entry point) through production code only.
  static func reachable() -> Set<String> {
    let all = production
    let declared = Set(all.filter { !$0.isExtension }.map(\.owner))
    var refs: [String: Set<String>] = [:]
    var roots: Set<String> = ["OffloadMain"]
    for c in all {
      let names = Set(matches(#"\b[A-Z]\w*\b"#, c.text).map { group($0, 0, c.text) }).intersection(declared)
      // An extension of a framework type (View, NSAppearance…) is callable from anywhere: its references count.
      if c.isExtension && !declared.contains(c.owner) { roots.formUnion(names); continue }
      refs[c.owner, default: []].formUnion(names)
    }
    var seen = roots
    var queue = Array(roots)
    while let t = queue.popLast() {
      for n in refs[t] ?? [] where !seen.contains(n) { seen.insert(n); queue.append(n) }
    }
    return seen
  }

  /// The top-level types S2-13 adds: everything under Surfaces/Company and Core/CompanyClient.swift, plus any other
  /// production type named Company… (the window controller lives in Windows.swift).
  static var companyTypes: [String] {
    let files = swiftFiles(app.appendingPathComponent("Surfaces/Company")) + [app.appendingPathComponent("Core/CompanyClient.swift")]
    var names = files.flatMap(chunks).filter { !$0.isExtension }.map(\.owner)
    for c in production where !c.isExtension && c.owner.hasPrefix("Company") && !names.contains(c.owner) { names.append(c.owner) }
    return names
  }

  static func productionText() -> String {
    swiftFiles(app).filter { !snapshotOnly.contains($0.lastPathComponent) }.map { code(read($0)) }.joined(separator: "\n")
  }

  /// The body of `func name` in `text`: from its signature to the next declaration at the same indent.
  static func body(of name: String, in text: String) -> String? {
    guard let r = text.range(of: "func \(name)") else { return nil }
    let rest = text[r.lowerBound...]
    let lines = rest.components(separatedBy: "\n")
    let indent = (text[..<r.lowerBound].components(separatedBy: "\n").last ?? "").count
    var out = [lines[0]]
    for line in lines.dropFirst() {
      let lead = line.prefix { $0 == " " }.count
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if !trimmed.isEmpty, lead <= indent, trimmed != "}" { break }
      out.append(line)
      if lead == indent, trimmed == "}" { break }
    }
    return out.joined(separator: "\n")
  }
}

// MARK: reachability (P1, class-wide)

@Suite("S2-13 Company wiring")
struct S213WiringTests {
  @Test("WIRING: every S2-13 type is reachable from the app's entry point, not only from the snapshot harness")
  func everyCompanyTypeShips() {
    let types = S213Source.companyTypes
    #expect(types.count >= 20, "found only \(types.count) Company types; the scan is broken")
    let reach = S213Source.reachable()
    #expect(reach.contains("AppDelegate") && reach.contains("RailView") && reach.contains("DashboardView"),
            "the reachability scan lost the app's own windows; it is broken")
    let missing = types.filter { !reach.contains($0) }
    #expect(missing.isEmpty, "snapshot-only (never shipped): \(missing.joined(separator: ", "))")
  }

  @Test("WIRING: the app builds the live company client, service, model and window (not only types named)")
  func liveConstruction() {
    let app = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("App/OffloadApp.swift")))
    for call in ["CompanyClient(brain:", "CompanyService(", "CompanyModel(", "CompanyWindowController(", "MockCompanyAPI("] {
      let calls = app.contains(call)
      #expect(calls, "OffloadApp.swift never calls \(call)")
    }
    // The More menu (the rail's ellipsis) offers the window; its title comes from the calm entry rule.
    let action = app.contains("openCompany"), calm = app.contains("CompanyEntry.menuTitle")
    #expect(action, "no Company menu action")
    #expect(calm, "the menu item does not use the calm entry title")
  }

  @Test("WIRING: the rail and the dashboard show company sync state from the live model")
  func railAndDashboard() {
    let prod = S213Source.productionText()
    let rail = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/RailView.swift")))
    let dash = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/DashboardView.swift")))
    let mark = rail.contains("CompanyRailMark("), row = dash.contains("CompanySyncRow(")
    let railRule = prod.contains("CompanyEntry.railState("), dashRule = prod.contains("CompanyEntry.showsOnDashboard(")
    #expect(mark, "the rail never shows the company mark")
    #expect(row, "the dashboard never shows the company row")
    #expect(railRule, "the rail does not apply the calm entry rule")
    #expect(dashRule, "the dashboard does not apply the calm entry rule")
  }
}

// MARK: one owner per side effect (P2, class-wide)

@Suite("S2-13 Company side effects")
struct S213SideEffectTests {
  @Test("ONE OPEN: the brain opens the sign-in page; the app never opens the URL /sync/connect returns")
  func brainOwnsBrowser() throws {
    let brain = S213Source.read(S213Source.repo.appendingPathComponent("brain/src/sync/client.ts"))
    let connect = try #require(S213Source.body(of: "connect", in: brain.replacingOccurrences(of: "async connect()", with: "func connect()")))
    #expect(connect.contains("openInBrowser"), "the brain no longer opens the sign-in page; pick one owner again")

    let core = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Core/CompanyClient.swift")))
    let opener = core.contains("func connect(open")
    #expect(!opener, "CompanyService.connect still takes a URL opener")
    let model = S213Source.code(S213Source.read(S213Source.app.appendingPathComponent("Surfaces/Company/CompanyModel.swift")))
    let start = try #require(S213Source.body(of: "startConnect", in: model))
    let opens = start.contains("onOpenURL") || start.contains("NSWorkspace")
    #expect(!opens, "startConnect opens the sign-in URL in the app too")
  }

  @Test("ONE OPEN: no production app code opens a URL returned by /sync/connect")
  func noAppOpenOfAuthorize() {
    let prod = S213Source.productionText()
    #expect(S213Source.matches(#"authorizeUrl[\s\S]{0,200}NSWorkspace\.shared\.open"#, prod).isEmpty)
  }
}

// MARK: calm entry

@Suite("S2-13 Company entry")
struct S213EntryTests {
  @Test("ENTRY: not connected reads as a calm invitation; connected opens the window by name")
  func menuTitle() {
    #expect(CompanyEntry.menuTitle(.notSetUp) == "Connect your company…")
    #expect(CompanyEntry.menuTitle(.notConnected) == "Connect your company…")
    #expect(CompanyEntry.menuTitle(.revoked) == "Connect your company…")
    for s: CompanySyncState in [.connecting, .waitingForNotice, .syncing(last: nil), .paused] {
      #expect(CompanyEntry.menuTitle(s) == "Company…")
    }
  }

  @Test("ENTRY: the rail shows company only once a company is in play; never pushes it otherwise")
  func rail() {
    #expect(CompanyEntry.railState(.notSetUp) == nil)
    #expect(CompanyEntry.railState(.notConnected) == nil)
    for s: CompanySyncState in [.connecting, .waitingForNotice, .syncing(last: nil), .paused, .revoked] {
      #expect(CompanyEntry.railState(s) == s)
    }
  }

  @Test("ENTRY: the dashboard row shows when a company can be connected, not when none is set up")
  func dashboard() {
    #expect(!CompanyEntry.showsOnDashboard(.notSetUp))
    for s: CompanySyncState in [.notConnected, .connecting, .waitingForNotice, .syncing(last: nil), .paused, .revoked] {
      #expect(CompanyEntry.showsOnDashboard(s))
    }
  }

  @Test("ENTRY: a brain without company sync (404) or not reachable reads as not set up, never an error")
  func quietStatus() async throws {
    let t = S213Transport()
    t.on("GET", "/sync/status", 404, S213Contract.error("not_found", "no route"))
    let svc = S213.service(t)
    let s = await svc.statusQuietly()
    #expect(s.phase == .notConfigured)
    #expect(CompanySyncState(s) == .notSetUp)

    let t2 = S213Transport()
    t2.on("GET", "/sync/status", S213Contract.status(state: "connected", notice: S213Contract.notice(), acknowledged: true))
    t2.on("GET", "/sync/status", 500, S213Contract.error("internal", "boom"))
    let svc2 = S213.service(t2)
    #expect(await svc2.statusQuietly().phase == .connected)
    #expect(await svc2.statusQuietly().phase == .connected, "a failed refresh keeps the last known state")
  }
}
