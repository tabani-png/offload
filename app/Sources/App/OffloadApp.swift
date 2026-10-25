import AppKit
import Combine
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
  private let options = LaunchOptions.parse(arguments: CommandLine.arguments,
                                            environment: ProcessInfo.processInfo.environment)
  private let repo = BrainLaunch.findRepo(bundleURL: Bundle.main.bundleURL, environment: ProcessInfo.processInfo.environment)
  private let endpoint = BrainEndpointBox()
  private var supervisor: BrainSupervisor?
  private let token = BrainLaunch.newToken()
  private var home: URL
  private var observer: ObserverControl
  private let client: BrainClient
  private let model: InboxModel
  private var rail: RailController!
  private var card: CardController!
  private var hotKey: HotKey?
  private var review: ReviewWindowController?
  private var dashboard: DashboardWindowController?
  private var onboarding: OnboardingWindowController?
  private let dashboardModel: DashboardModel
  private var qaBackdrop: NSWindow?
  private var refreshTimer: Timer?
  private var lastObserverPaused: Bool?

  override init() {
    let env = ProcessInfo.processInfo.environment
    home = options.home
    let obsBin = ObserverLocator.locate(environment: env, executableDir: Bundle.main.executableURL?.deletingLastPathComponent(),
                                        repo: repo)
    let obs = ObserverControl(binary: obsBin, home: options.home)
    observer = obs
    switch options.brain {
    case .mock:
      client = MockBrainClient()
    case .attach(let url):
      endpoint.endpoint = BrainEndpoint(baseURL: url, token: env["OFFLOAD_TOKEN"] ?? "")
      client = HTTPBrainClient(endpoint: endpoint, permissions: { await obs.permissionRows() })
    case .spawn:
      endpoint.starting = true
      client = HTTPBrainClient(endpoint: endpoint, permissions: { await obs.permissionRows() })
    }
    model = InboxModel(client: client)
    dashboardModel = DashboardModel(client: client)
    super.init()
  }

  private var isMock: Bool { options.brain == .mock }

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
    model.onTogglePause = { [weak self] paused in self?.setObserverPaused(paused) }
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
    dashboardModel.onTogglePause = { [weak self] paused in self?.setObserverPaused(paused) }
    dashboardModel.onOpenURL = { NSWorkspace.shared.open($0) }
    dashboardModel.onReveal = { path in
      let url = URL(fileURLWithPath: path)
      if FileManager.default.fileExists(atPath: path) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
      else { NSWorkspace.shared.activateFileViewerSelecting([url.deletingLastPathComponent()]) }
    }
    rail.show()
    hotKey = HotKey { [weak self] in MainActor.assumeIsolated { self?.card.toggle() } }
    if hotKey == nil { NSLog("Offload: %@ is taken by another app; open the card from the rail", HotKey.displayName) }
    startBrain()
    startRefreshing()
    if OnboardingGate.shouldShow(arguments: args, onboarded: UserDefaults.standard.bool(forKey: OnboardingGate.defaultsKey)) {
      openOnboarding()
    }
    Task {
      await waitForBrain(timeout: 30)
      await model.load()
      await refreshObserver()
      runQAHooks()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    supervisor?.stop()
  }

  // MARK: brain + observer

  private func brainSpec(home: URL, demo: Bool = false) -> BrainLaunchSpec? {
    guard let repo, let bun = BrainLaunch.findBun(environment: ProcessInfo.processInfo.environment) else { return nil }
    let env = Self.environment(demo: demo || options.demo)
    try? FileManager.default.createDirectory(at: Self.brainLogFile.deletingLastPathComponent(), withIntermediateDirectories: true)
    return BrainLaunch.spec(bun: bun, repo: repo, home: home, token: token,
                            baseEnvironment: env, observer: observer.binary,
                            model: BrainLaunch.model(environment: env, demo: demo || options.demo),
                            logFile: Self.brainLogFile)
  }

  /// Demo homes use raw key files (OFFLOAD_KEYS=file): nothing touches the real Keychain.
  static func environment(demo: Bool) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    if demo { env["OFFLOAD_KEYS"] = "file" }
    return env
  }

  nonisolated private static var brainLog: URL {
    URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Offload/brain.err.log")
  }

  /// s10d: `serve --log-file`: the brain's own scrubbed log lines (it rotates this file itself at 5 MB, keeping 2).
  nonisolated static var brainLogFile: URL {
    URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/Offload/brain.log")
  }

  private var logTimer: Timer?

  /// REVIEW-2: rotate the brain log now and every minute.
  private func startLogRotation() {
    LogRotation.rotateIfNeeded(Self.brainLog)
    let t = Timer(timeInterval: LogRotation.interval, repeats: true) { _ in LogRotation.rotateIfNeeded(Self.brainLog) }
    RunLoop.main.add(t, forMode: .common)
    logTimer = t
  }

  /// REVIEW-2: one `cli.ts purge` before serve, so expired days go even if serve never starts. Skipped when the
  /// brain has no purge command.
  private func purgeOnce(home: URL) {
    guard let repo, let bun = BrainLaunch.findBun(environment: ProcessInfo.processInfo.environment),
          let args = BrainLaunch.purgeArguments(repo: repo, home: home) else { return }
    let p = Process()
    p.executableURL = bun
    p.arguments = args
    p.environment = Self.environment(demo: options.demo)
    p.currentDirectoryURL = repo
    p.standardInput = FileHandle.nullDevice
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    do {
      try p.run()
      // Bounded: a stuck purge must not hold the app's launch. serve purges again on start and hourly.
      let deadline = Date().addingTimeInterval(10)
      while p.isRunning && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
      if p.isRunning { p.terminate(); NSLog("Offload: brain purge took over 10 s; stopped it"); return }
      if p.terminationStatus != 0 { NSLog("Offload: brain purge exited %d", p.terminationStatus) }
    } catch {
      NSLog("Offload: brain purge did not run: %@", String(describing: error))
    }
  }

  private func startBrain() {
    startLogRotation()
    guard options.brain == .spawn else { return }
    purgeOnce(home: home)
    guard let spec = brainSpec(home: home) else {
      endpoint.starting = false
      NSLog("Offload: cannot start the brain (repo %@, bun not found or brain/src/cli.ts missing)", repo?.path ?? "none")
      return
    }
    let s = BrainSupervisor(spec: spec, token: token, endpoint: endpoint, stderrLog: Self.brainLog) { [weak self] state in
      NSLog("Offload brain: %@", state.label)
      if case .running = state {
        Task { @MainActor [weak self] in await self?.brainCameUp() }
      } else if case .waiting = state {
        Task { @MainActor [weak self] in await self?.model.load() }
      }
    }
    supervisor = s
    s.start()
  }

  private func brainCameUp() async {
    await model.load()
    if dashboard != nil { await dashboardModel.load() }
  }

  /// Waits until the supervisor has an endpoint (or gives up), so the first load is not a "not running".
  private func waitForBrain(timeout: TimeInterval) async {
    guard options.brain == .spawn, supervisor != nil else { return }
    let deadline = Date().addingTimeInterval(timeout)
    while endpoint.endpoint == nil && Date() < deadline {
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
  }

  /// Every 30 s: the inbox and rail from the brain; every 10 s: the observer's pause flag and permissions.
  private func startRefreshing() {
    var tick = 0
    let t = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        tick += 1
        Task {
          await self?.refreshObserver()
          if tick % 3 == 0 { await self?.model.load() }
        }
      }
    }
    RunLoop.main.add(t, forMode: .common)
    refreshTimer = t
  }

  private func refreshObserver() async {
    guard !isMock else { return }
    let report = await observerReport()
    let rows = report?.permissionRows() ?? PermissionState.unknownRows
    lastObserverPaused = report?.paused
    if let p = report?.paused { model.applyObserverPaused(p) }
    dashboardModel.updatePermissions(rows, paused: report?.paused)
  }

  /// The brain's GET /observer (s05c) first, then the observer CLI directly.
  private func observerReport() async -> ObserverReport? {
    if let r = try? await client.observer() { return r }
    return try? await observer.status()
  }

  /// Rail or dashboard Pause: `offload-observer pause|resume`, then re-read both sides.
  private func setObserverPaused(_ paused: Bool) {
    guard !isMock else { return }
    Task {
      do {
        try await observer.setPaused(paused)
      } catch {
        NSLog("Offload: observer %@ failed: %@", paused ? "pause" : "resume", String(describing: error))
        let alert = NSAlert()
        alert.messageText = paused ? "Could not pause" : "Could not resume"
        alert.informativeText = (error as? ObserverControlError)?.userMessage ?? "The observer did not answer. Nothing was changed."
        alert.runModal()
      }
      await refreshObserver()
      await model.load()
      if let p = lastObserverPaused { model.applyObserverPaused(p) }
    }
  }

  // MARK: onboarding

  func openOnboarding() {
    if let o = onboarding { o.show(); return }
    let m = OnboardingModel(readPermissions: { [weak self] in
      await self?.observerReport()?.permissionRows() ?? PermissionState.unknownRows
    })
    m.onFinish = { [weak self] in
      UserDefaults.standard.set(true, forKey: OnboardingGate.defaultsKey)
      self?.onboarding?.window.close()
    }
    m.onDemoWeek = { [weak self] in await self?.useDemoWeek() }
    let c = OnboardingWindowController(model: m)
    c.onClose = { [weak self] in self?.onboarding = nil }
    onboarding = c
    c.show()
    // QA: `--qa-onboarding-step 2` opens on the permissions step (live permission reads from the observer).
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--qa-onboarding-step"), args.indices.contains(i + 1), let n = Int(args[i + 1]) {
      for _ in 1..<max(1, n) { m.next() }
    }
    qaRecord("onboarding", c.window)
  }

  /// Seeds the fixture week into the demo home (never the real one) and points the brain at it.
  private func useDemoWeek() async -> String? {
    guard let repo, let bun = BrainLaunch.findBun(environment: ProcessInfo.processInfo.environment) else {
      return "The demo week needs the Offload source folder and bun. Run scripts/demo.sh instead."
    }
    let appSupport = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    let demo = DemoWeek.home(repo: repo, appSupport: appSupport)
    guard DemoWeek.isSafeDemoHome(demo, realHome: options.home) || options.demo else {
      return "Offload is already pointed at a demo folder."
    }
    let args = DemoWeek.generatorArguments(repo: repo, out: demo, start: DemoWeek.startDay(now: Date()))
    let ok: Bool = await withCheckedContinuation { cont in
      let p = Process()
      p.executableURL = bun
      p.environment = Self.environment(demo: true)
      p.arguments = args
      p.currentDirectoryURL = repo
      p.standardInput = FileHandle.nullDevice
      p.standardOutput = FileHandle.nullDevice
      p.standardError = FileHandle.nullDevice
      p.terminationHandler = { cont.resume(returning: $0.terminationStatus == 0) }
      do { try p.run() } catch { cont.resume(returning: false) }
    }
    guard ok else { return "The demo week could not be written. Nothing else was changed." }
    home = demo
    observer = ObserverControl(binary: observer.binary, home: demo, environment: Self.environment(demo: true))
    if let s = supervisor, let spec = brainSpec(home: demo, demo: true) {
      s.restart(home: demo, spec: spec)
      await waitForBrain(timeout: 30)
    }
    await model.load()
    return nil
  }

  // MARK: windows

  /// POST /workflows/draft {insightId}, then the review window with its dry run.
  func openReview(insightId: String) {
    Task {
      do {
        presentReview(try await client.workflow(forInsight: insightId))
      } catch {
        NSLog("Offload: no workflow draft for %@: %@", insightId, String(describing: error))
        showProblem("Could not draft the workflow", error)
      }
    }
  }

  func openReview(workflowId: String) {
    Task {
      do {
        presentReview(try await client.workflow(id: workflowId))
      } catch {
        showProblem("Could not open the workflow", error)
      }
    }
  }

  private func showProblem(_ title: String, _ error: Error) {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = BrainError.message(for: error)
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    alert.runModal()
  }

  private func presentReview(_ w: Workflow, dryRun: DryRun? = nil) {
    if let r = review, r.model.workflow.id == w.id { r.show(); return }
    review?.window.close()
    // s10d: the dry run runs on "last week's emails", plural. A limit under 3 exists to cap model calls; the offline
    // sample model costs nothing, so with it the dry run always shows at least 3 real examples.
    let stub = BrainLaunch.model(environment: Self.environment(demo: options.demo), demo: options.demo) == "stub"
    let m = ReviewModel(workflow: w, dryRun: dryRun, client: client,
                        dryRunLimit: stub ? max(3, options.dryRunLimit) : options.dryRunLimit)
    m.onConnect = { [weak self] c in self?.showConnectHelp(c) }
    m.onApproved = { [weak self] _ in Task { await self?.dashboardModel.load() } }
    m.onDiscarded = { [weak self] _ in self?.review?.window.close() }
    let c = ReviewWindowController(model: m)
    c.onClose = { [weak self] in self?.review = nil }
    review = c
    c.show()
    qaRecord("review", c.window)
    qaWatchReview(m, window: c.window)
  }

  private var qaBag: Set<AnyCancellable> = []

  /// QA: once the dry run is in, record it and replay OFFLOAD_REVIEW_KEYS one per second ("approve,confirm,…";
  /// "dashboard" opens the dashboard; anything else waits a second). Records "review-approved" when it turns on.
  private func qaWatchReview(_ m: ReviewModel, window: NSWindow) {
    let env = ProcessInfo.processInfo.environment
    guard env["OFFLOAD_QA_WINDOWS"] != nil || env["OFFLOAD_REVIEW_KEYS"] != nil else { return }
    let keys = (env["OFFLOAD_REVIEW_KEYS"] ?? "").split(separator: ",").map(String.init)
    m.$dryRun.compactMap { $0 }.first().sink { [weak self] _ in
      self?.qaRecord("review-dryrun", window)
      for (n, k) in keys.enumerated() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2 + Double(n)) { [weak self] in
          if k == "dashboard" { self?.openDashboard(); return }
          if k == "scroll-dryrun" { m.scrollRequest = ReviewModel.dryRunSectionId; return }
          let key: ReviewKey? = ["approve": .approve, "confirm": .confirm, "escape": .escape, "skill": .skill,
                                 "rerun": .rerun, "edit": .edit, "discard": .discard][k]
          if let key { m.send(key) }
          if key == .approve {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
              if let sheet = window.attachedSheet { self?.qaRecord("review-confirm", sheet) }
            }
          }
        }
      }
    }.store(in: &qaBag)
    m.$message.compactMap { $0 }.sink { [weak self] msg in
      NSLog("Offload QA review message: %@", msg)
      if msg.hasPrefix("Turned on") { self?.qaRecord("review-approved", window) }
      else { self?.qaRecord("review-message", window) }
    }.store(in: &qaBag)
  }

  @objc func openDashboard() {
    // s10d QA: `--qa-dashboard-section overview|automations|week|observing` opens on that page.
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--qa-dashboard-section"), args.indices.contains(i + 1),
       let s = DashboardSection(rawValue: args[i + 1]) {
      dashboardModel.show(s)
    }
    if let d = dashboard { d.show(); return }
    let c = DashboardWindowController(model: dashboardModel)
    c.onClose = { [weak self] in self?.dashboard = nil }
    dashboard = c
    Task {
      await dashboardModel.load()
      await refreshObserver()
      c.show()
      qaRecord("dashboard", c.window)
    }
  }

  /// QA: appends `name=windowNumber` to $OFFLOAD_QA_WINDOWS so live captures take our windows only.
  private func qaRecord(_ name: String, _ w: NSWindow) {
    guard let path = ProcessInfo.processInfo.environment["OFFLOAD_QA_WINDOWS"] else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
      let line = "\(name)=\(w.windowNumber)\n"
      if let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile()
        h.write(Data(line.utf8))
        h.closeFile()
      } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
      }
    }
  }

  /// Connect… / Sign in… on a chip or the confirm sheet. The brain reads connectors from its own settings; the app
  /// never asks for or stores a password itself. s10d: plain words, and a sheet on the window you are in (stacked on
  /// the confirm sheet when that is up), never a modal that stops the app.
  private func showConnectHelp(_ c: Connector) {
    let alert = NSAlert()
    if c.state == .missingEnv {
      alert.messageText = "Sign in to \(c.name)"
      alert.informativeText = "\(c.name) is set up on this Mac but signed out, so steps that use it wait. Signing in from inside Offload is not ready yet: whoever set up Offload here can sign it back in. Offload checks again each time this window opens."
    } else {
      alert.messageText = "Connect \(c.name)"
      alert.informativeText = "Offload is not connected to \(c.name) yet, so steps that use it wait. Connecting accounts from inside Offload is not ready yet: whoever set up Offload here can connect \(c.name). Offload checks again each time this window opens."
    }
    alert.addButton(withTitle: "OK")
    NSApp.activate(ignoringOtherApps: true)
    let host = review?.window.isKeyWindow == true ? review?.window : (dashboard?.window.isKeyWindow == true ? dashboard?.window : (review?.window ?? dashboard?.window))
    guard let base = host else { alert.runModal(); return }
    let on = base.attachedSheet ?? base
    alert.beginSheetModal(for: on) { _ in }
    if let r = review?.window, base === r { qaRecord("review-message", r) }
  }

  // MARK: QA

  /// QA only. `--open-card` opens the card at launch; OFFLOAD_DEMO_KEYS="2,j,1" replays keys through the
  /// same path real keystrokes take, one per second. `--open-review`, `--open-dashboard` and `--qa-pointer`
  /// open the s08 windows. `--qa-glass white|dark` opens the card over our own backdrop window (never the user's
  /// windows) and writes the capture rect and window numbers to $OFFLOAD_QA_FILE.
  private func runQAHooks() {
    let args = CommandLine.arguments
    if args.contains("--open-review") { openReview(insightId: model.state.insights.first?.id ?? MockBrainClient.outreach.id) }
    if args.contains("--open-dashboard") {
      openDashboard()

      if args.contains("--qa-pointer") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.dashboardModel.send(.point) }
      }
      if args.contains("--qa-evidence") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.dashboardModel.send(.evidence) }
      }
      if args.contains("--qa-autosend") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
          guard let self, let a = self.dashboardModel.automations.first(where: { $0.workflowId != nil }) else { return }
          self.dashboardModel.show(.automations)
          self.dashboardModel.offerAutoSend(a)
        }
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
    qaRecord("card", card.panel)
    qaRecord("rail", rail.panel)
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
    menu.addItem(withTitle: "Welcome and permissions…", action: #selector(openOnboardingMenu), keyEquivalent: "").target = self
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit Offload", action: #selector(quit), keyEquivalent: "q").target = self
    let point = NSPoint(x: 0, y: view.bounds.midY)
    menu.popUp(positioning: nil, at: point, in: view)
  }

  @objc private func openInbox() { card.show() }
  @objc private func openOnboardingMenu() { openOnboarding() }
  @objc private func quit() { NSApp.terminate(nil) }
}
