import AppKit
import SwiftUI

@main
enum OffloadMain {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--snapshot") {
      guard args.indices.contains(i + 1) else {
        FileHandle.standardError.write(Data("usage: Offload --snapshot DIR [--scale N]\n".utf8))
        exit(64)
      }
      MainActor.assumeIsolated {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        var scale: CGFloat = 2
        if let s = args.firstIndex(of: "--scale"), args.indices.contains(s + 1), let v = Double(args[s + 1]), v > 0 {
          scale = CGFloat(v)
        }
        exit(Snapshotter.run(into: URL(fileURLWithPath: args[i + 1], isDirectory: true), scale: scale))
      }
    }
    MainActor.assumeIsolated {
      let app = NSApplication.shared
      let delegate = AppDelegate()
      app.delegate = delegate
      app.setActivationPolicy(.accessory)  // menu-bar style: no Dock icon (LSUIElement also set)
      app.run()
    }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  private let client = MockBrainClient()
  private lazy var model = InboxModel(client: client)
  private var rail: RailController!
  private var card: CardController!
  private var hotKey: HotKey?
  private var review: ReviewWindowController?
  private var dashboard: DashboardWindowController?
  private let dashboardModel = DashboardModel(client: MockBrainClient())
  private var qaBackdrop: NSWindow?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // QA: `--qa-appearance light|dark` pins the appearance so both can be checked live on one Mac.
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--qa-appearance"), args.indices.contains(i + 1) {
      NSApp.appearance = NSAppearance(named: args[i + 1] == "light" ? .aqua : .darkAqua)
    }
    rail = RailController(model: model,
                          onInbox: { [weak self] in self?.card.toggle() },
                          onMore: { [weak self] view in self?.showMoreMenu(from: view) })
    card = CardController(model: model, rail: rail)
    card.onDashboard = { [weak self] in self?.openDashboard() }
    model.onClose = { [weak self] in self?.card.hide() }
    model.onConnect = { [weak self] c in self?.showConnectHelp(c) }
    model.onCommit = { [weak self] action in
      NSLog("Offload: committed %@", String(describing: action))
      if case .build(let insightId) = action {
        // The card has done its job; get it out from in front of the review window.
        self?.card.hide()
        self?.openReview(insightId: insightId)
      }
    }
    dashboardModel.onOpenWorkflow = { [weak self] id in self?.openReview(workflowId: id) }
    dashboardModel.onConnect = { [weak self] c in self?.showConnectHelp(c) }
    dashboardModel.onTogglePause = { [weak self] _ in self?.model.togglePause() }
    rail.show()
    hotKey = HotKey { [weak self] in MainActor.assumeIsolated { self?.card.toggle() } }
    if hotKey == nil { NSLog("Offload: %@ is taken by another app; open the card from the rail", HotKey.displayName) }
    Task {
      await model.load()
      runQAHooks()
    }
  }

  // MARK: windows

  /// POST /workflows/draft {insightId}, then the review window with its dry run.
  func openReview(insightId: String) {
    Task {
      guard let w = try? await client.workflow(forInsight: insightId) else {
        NSLog("Offload: no workflow draft for %@", insightId)
        return
      }
      presentReview(w)
    }
  }

  func openReview(workflowId: String) {
    Task {
      guard let w = try? await client.workflow(id: workflowId) else { return }
      presentReview(w)
    }
  }

  private func presentReview(_ w: Workflow, dryRun: DryRun? = nil) {
    if let r = review, r.model.workflow.id == w.id { r.show(); return }
    review?.window.close()
    let m = ReviewModel(workflow: w, dryRun: dryRun, client: client)
    m.onConnect = { [weak self] c in self?.showConnectHelp(c) }
    m.onApproved = { [weak self] _ in Task { await self?.dashboardModel.load() } }
    m.onDiscarded = { [weak self] _ in self?.review?.window.close() }
    let c = ReviewWindowController(model: m)
    c.onClose = { [weak self] in self?.review = nil }
    review = c
    c.show()
  }

  @objc func openDashboard() {
    if let d = dashboard { d.show(); return }
    let c = DashboardWindowController(model: dashboardModel)
    c.onClose = { [weak self] in self?.dashboard = nil }
    dashboard = c
    Task {
      await dashboardModel.load()
      c.show()
    }
  }

  /// Connect… / Add key… on a chip. The brain reads connectors from $OFFLOAD_HOME/connectors.json, secrets by env
  /// var name only (s05 AC-1); the app never asks for or stores a key itself.
  private func showConnectHelp(_ c: Connector) {
    let alert = NSAlert()
    alert.messageText = c.state == .missingEnv ? "\(c.name) needs its key" : "Connect \(c.name)"
    alert.informativeText = c.state == .missingEnv
      ? "The \(c.name) server is set up, but the environment variable it names is not set. Set it where the brain runs, then come back. Offload checks again when this window opens."
      : "Add \(c.name) to the brain's connectors.json (see brain/CONNECTORS.md: Composio or an MCP server). Keys are named by environment variable only. Offload checks again when this window opens."
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }

  // MARK: QA

  /// QA only. `--open-card` opens the card at launch; OFFLOAD_DEMO_KEYS="2,j,1" replays keys through the
  /// same path real keystrokes take, one per second. `--open-review`, `--open-dashboard` and `--qa-pointer`
  /// open the s08 windows. `--qa-glass white|dark` opens the card over our own backdrop window (never the user's
  /// windows) and writes the capture rect and window numbers to $OFFLOAD_QA_FILE.
  private func runQAHooks() {
    let args = CommandLine.arguments
    if args.contains("--open-review") { openReview(insightId: MockBrainClient.outreach.id) }
    if args.contains("--open-dashboard") {
      openDashboard()
      if args.contains("--qa-pointer") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.dashboardModel.send(.point) }
      }
    }
    // OFFLOAD_REVIEW_KEYS="approve,confirm" replays review keys one per second after the window opens.
    let reviewKeys = (ProcessInfo.processInfo.environment["OFFLOAD_REVIEW_KEYS"] ?? "").split(separator: ",").map(String.init)
    for (n, k) in reviewKeys.enumerated() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.5 + Double(n)) { [weak self] in
        let key: ReviewKey? = ["approve": .approve, "confirm": .confirm, "escape": .escape, "skill": .skill,
                               "rerun": .rerun, "edit": .edit, "discard": .discard][k]
        if let key { self?.review?.model.send(key) }
      }
    }
    if args.contains("--open-review") || args.contains("--open-dashboard") {
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
        let line = "review=\(self?.review?.window.windowNumber ?? 0) dashboard=\(self?.dashboard?.window.windowNumber ?? 0)\n"
        if let path = ProcessInfo.processInfo.environment["OFFLOAD_QA_FILE"] {
          try? line.write(toFile: path, atomically: true, encoding: .utf8)
        }
      }
    }
    if let i = args.firstIndex(of: "--qa-glass"), args.indices.contains(i + 1) {
      card.show()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.qaGlass(args[i + 1]) }
    }
    guard args.contains("--open-card") else { return }
    card.show()
    let keys = (ProcessInfo.processInfo.environment["OFFLOAD_DEMO_KEYS"] ?? "")
      .split(separator: ",").map { String($0) }
    for (i, k) in keys.enumerated() {
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(i + 1)) { [weak self] in
        let code: UInt16 = k == "esc" ? 53 : 0
        if let key = CardKey(characters: k == "esc" ? "\u{1b}" : k, keyCode: code, hasCommandOrControl: false) {
          self?.model.send(key)
          NSLog("Offload QA: sent %@ -> %@", k, self?.model.state.positionLabel ?? "")
        }
      }
    }
  }

  /// Puts a plain white (or near-black) window of our own under the card and rail, one level below them, and
  /// reports a capture rect that lies entirely on it, so a screenshot of that rect shows only our pixels.
  private func qaGlass(_ kind: String) {
    guard let screen = NSScreen.main else { return }
    let union = card.panel.frame.union(rail.panel.frame)
    let backdropFrame = union.insetBy(dx: -80, dy: -80).intersection(screen.frame)
    let w = NSWindow(contentRect: backdropFrame, styleMask: .borderless, backing: .buffered, defer: false)
    w.level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue - 1)
    w.isOpaque = true
    w.hasShadow = false
    w.ignoresMouseEvents = true
    w.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
    w.backgroundColor = kind == "dark" ? NSColor(srgbRed: 0.07, green: 0.07, blue: 0.08, alpha: 1) : .white
    if kind == "split" {
      // Left half white, right half black: the hardest case, both at once.
      let v = NSView(frame: NSRect(origin: .zero, size: backdropFrame.size))
      v.wantsLayer = true
      let black = CALayer()
      black.frame = CGRect(x: backdropFrame.width / 2, y: 0, width: backdropFrame.width / 2, height: backdropFrame.height)
      black.backgroundColor = NSColor.black.cgColor
      v.layer?.addSublayer(black)
      w.contentView = v
    }
    w.orderFrontRegardless()
    qaBackdrop = w
    rail.panel.orderFrontRegardless()
    card.panel.orderFrontRegardless()
    let capture = union.insetBy(dx: -40, dy: -40)
    let topLeftY = screen.frame.maxY - capture.maxY
    let line = String(format: "rect=%.0f,%.0f,%.0f,%.0f card=%d rail=%d backdrop=%d\n", capture.minX, topLeftY,
                      capture.width, capture.height, card.panel.windowNumber, rail.panel.windowNumber, w.windowNumber)
    if let path = ProcessInfo.processInfo.environment["OFFLOAD_QA_FILE"] {
      try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
    NSLog("Offload QA glass: %@", line)
  }

  private func showMoreMenu(from view: NSView) {
    let menu = NSMenu()
    menu.addItem(withTitle: "Open Inbox  \(HotKey.displayName)", action: #selector(openInbox), keyEquivalent: "").target = self
    let dash = menu.addItem(withTitle: "Dashboard", action: #selector(openDashboard), keyEquivalent: "d")
    dash.keyEquivalentModifierMask = .command
    dash.target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Offload", action: #selector(quit), keyEquivalent: "q").target = self
    let point = NSPoint(x: 0, y: view.bounds.midY)
    menu.popUp(positioning: nil, at: point, in: view)
  }

  @objc private func openInbox() { card.show() }
  @objc private func quit() { NSApp.terminate(nil) }
}
