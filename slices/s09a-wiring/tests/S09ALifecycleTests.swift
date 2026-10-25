import Foundation
import Testing

// S09A: launching and supervising the brain, the observer CLI, permissions, onboarding, demo week, launch options.
// Process tests use small shell scripts written to a temp dir as stand-ins for bun and offload-observer.

private func tempDir() -> URL {
  let d = FileManager.default.temporaryDirectory.appendingPathComponent("s09a-\(UUID().uuidString)", isDirectory: true)
  try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
  return d
}

private func script(_ dir: URL, _ name: String, _ body: String) -> URL {
  let u = dir.appendingPathComponent(name)
  try? ("#!/bin/sh\n" + body + "\n").write(to: u, atomically: true, encoding: .utf8)
  try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: u.path)
  return u
}

private func waitUntil(_ timeout: TimeInterval, _ cond: () -> Bool) async -> Bool {
  let end = Date().addingTimeInterval(timeout)
  while Date() < end {
    if cond() { return true }
    try? await Task.sleep(nanoseconds: 50_000_000)
  }
  return cond()
}

private func alive(_ pid: Int32) -> Bool { kill(pid, 0) == 0 }

@Suite("S09A brain launch")
struct S09ALaunchTests {
  @Test("the first stdout line gives the port; only loopback URLs count")
  func parseListening() {
    #expect(BrainLaunch.parseListening("brain listening on http://127.0.0.1:51123/")?.absoluteString == "http://127.0.0.1:51123/")
    #expect(BrainLaunch.parseListening("brain listening on http://localhost:8080/  ")?.absoluteString == "http://127.0.0.1:8080/")
    #expect(BrainLaunch.parseListening("brain listening on http://10.0.0.5:51123/") == nil)
    #expect(BrainLaunch.parseListening("brain listening on https://127.0.0.1:51123/") == nil)
    #expect(BrainLaunch.parseListening("brain listening on http://127.0.0.1/") == nil)
    #expect(BrainLaunch.parseListening("hello") == nil)
  }

  @Test("s05c handshake: OFFLOAD_BRAIN_READY {port, token} gives the URL and the token")
  func parseReady() {
    let t = String(repeating: "k", count: 43)
    let r = BrainLaunch.parseReady("OFFLOAD_BRAIN_READY {\"port\":51200,\"token\":\"\(t)\"}")
    #expect(r?.url.absoluteString == "http://127.0.0.1:51200/")
    #expect(r?.token == t)
    #expect(BrainLaunch.parseReady("OFFLOAD_BRAIN_READY {\"port\":0,\"token\":\"\(t)\"}") == nil)
    #expect(BrainLaunch.parseReady("OFFLOAD_BRAIN_READY {\"port\":5,\"token\":\"short\"}") == nil)
    #expect(BrainLaunch.parseReady("OFFLOAD_BRAIN_READY not json") == nil)
    #expect(BrainLaunch.parseReady("brain listening on http://127.0.0.1:1/") == nil)
  }

  @Test("an OFFLOAD_TOKEN line is adopted only when long enough")
  func parseToken() {
    let t = String(repeating: "x", count: 43)
    #expect(BrainLaunch.parseToken("OFFLOAD_TOKEN=\(t)") == t)
    #expect(BrainLaunch.parseToken("OFFLOAD_TOKEN=short") == nil)
    #expect(BrainLaunch.parseToken("brain listening on x") == nil)
  }

  @Test("per-launch token: 43 url-safe characters, fresh every time")
  func token() {
    let a = BrainLaunch.newToken(), b = BrainLaunch.newToken()
    #expect(a.count == 43)
    #expect(a != b)
    #expect(a.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    #expect(a.count >= BrainLaunch.minTokenLength)
  }

  @Test("bun: OFFLOAD_BUN, then ~/.bun, Homebrew, /usr/local, then PATH")
  func findBun() {
    let has: Set<String> = ["/u/.bun/bin/bun", "/opt/homebrew/bin/bun", "/x/bin/bun"]
    #expect(BrainLaunch.findBun(environment: [:], userHome: "/u", isExecutable: has.contains)?.path == "/u/.bun/bin/bun")
    #expect(BrainLaunch.findBun(environment: ["OFFLOAD_BUN": "/x/bin/bun"], userHome: "/u", isExecutable: has.contains)?.path == "/x/bin/bun")
    #expect(BrainLaunch.findBun(environment: ["PATH": "/x/bin"], userHome: "/none", isExecutable: { $0 == "/x/bin/bun" })?.path == "/x/bin/bun")
    #expect(BrainLaunch.findBun(environment: [:], userHome: "/none", isExecutable: { _ in false }) == nil)
  }

  @Test("the repo is found by walking up from app/.build/Offload.app, or from OFFLOAD_REPO")
  func findRepo() {
    let exists: (String) -> Bool = { $0 == "/r/brain/src/cli.ts" || $0 == "/other/brain/src/cli.ts" }
    let bundle = URL(fileURLWithPath: "/r/app/.build/Offload.app")
    #expect(BrainLaunch.findRepo(bundleURL: bundle, environment: [:], exists: exists)?.path == "/r")
    #expect(BrainLaunch.findRepo(bundleURL: bundle, environment: ["OFFLOAD_REPO": "/other"], exists: exists)?.path == "/other")
    #expect(BrainLaunch.findRepo(bundleURL: URL(fileURLWithPath: "/Applications/Offload.app"), environment: [:], exists: exists) == nil)
  }

  @Test("launch spec: serve on port 0, token and home in the env, bun's folder on PATH")
  func spec() {
    let s = BrainLaunch.spec(bun: URL(fileURLWithPath: "/u/.bun/bin/bun"), repo: URL(fileURLWithPath: "/r"),
                             home: URL(fileURLWithPath: "/h"), token: "T", baseEnvironment: ["PATH": "/usr/bin", "KEEP": "1"],
                             observer: URL(fileURLWithPath: "/r/engine/.build/offload-observer"), userHome: "/u")
    #expect(s.arguments == ["run", "/r/brain/src/cli.ts", "serve", "--home", "/h", "--port", "0"])
    #expect(s.environment["OFFLOAD_TOKEN"] == "T")
    #expect(s.environment["OFFLOAD_HOME"] == "/h")
    #expect(s.environment["OFFLOAD_OBSERVER_BIN"] == "/r/engine/.build/offload-observer")
    #expect(s.environment["KEEP"] == "1")
    #expect(s.environment["PATH"]?.hasPrefix("/u/.bun/bin:") == true)
    #expect(s.environment["PATH"]?.hasSuffix(":/usr/bin") == true)
  }

  @Test("backoff: 1, 2, 4 … capped at 30 s; a minute of uptime starts over")
  func backoff() {
    var b = Backoff()
    #expect((0..<7).map { _ in b.delay(afterRunning: 1) } == [1, 2, 4, 8, 16, 30, 30])
    #expect(b.delay(afterRunning: 61) == 1)
    #expect(b.delay(afterRunning: 2) == 2)
    b.reset()
    #expect(b.delay(afterRunning: 0) == 1)
  }

  @Test("line buffer: partial chunks join, complete lines come out")
  func lines() {
    var l = LineBuffer()
    #expect(l.append(Data("brain list".utf8)) == [])
    #expect(l.append(Data("ening on x\nOFFLOAD_".utf8)) == ["brain listening on x"])
    #expect(l.append(Data("TOKEN=y\n".utf8)) == ["OFFLOAD_TOKEN=y"])
  }
}

@Suite("S09A brain supervisor (real processes)", .serialized)
struct S09ASupervisorTests {
  private func spec(_ exe: URL, home: URL) -> BrainLaunchSpec {
    BrainLaunchSpec(executable: exe, arguments: [], environment: ["PATH": "/usr/bin:/bin"], workingDirectory: home, home: home)
  }

  @Test("reads the port from the child's first line and publishes the endpoint")
  func running() async {
    let d = tempDir()
    let fake = script(d, "fake-bun", "echo 'brain listening on http://127.0.0.1:49999/'\nexec sleep 30")
    let box = BrainEndpointBox()
    let s = BrainSupervisor(spec: spec(fake, home: d), token: "TOKEN", endpoint: box)
    s.start()
    #expect(await waitUntil(5) { box.endpoint != nil })
    #expect(box.endpoint == BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:49999/")!, token: "TOKEN"))
    #expect(s.state == .running(URL(string: "http://127.0.0.1:49999/")!))
    s.stop()
  }

  @Test("the s05c ready line is read too, and its token replaces the app's")
  func readyLine() async {
    let d = tempDir()
    let tok = String(repeating: "r", count: 43)
    let fake = script(d, "fake-bun", "echo 'OFFLOAD_BRAIN_READY {\"port\":49996,\"token\":\"\(tok)\"}'\nexec sleep 30")
    let box = BrainEndpointBox()
    let s = BrainSupervisor(spec: spec(fake, home: d), token: "APP", endpoint: box)
    s.start()
    #expect(await waitUntil(5) { box.endpoint != nil })
    #expect(box.endpoint == BrainEndpoint(baseURL: URL(string: "http://127.0.0.1:49996/")!, token: tok))
    s.stop()
  }

  @Test("restarts with backoff when the brain dies")
  func restarts() async {
    let d = tempDir()
    let count = d.appendingPathComponent("count")
    let fake = script(d, "fake-bun", "echo x >> '\(count.path)'\necho 'brain listening on http://127.0.0.1:49998/'\nsleep 0.2\nexit 1")
    let box = BrainEndpointBox()
    let s = BrainSupervisor(spec: spec(fake, home: d), token: "T", endpoint: box,
                            backoff: Backoff(base: 0.1, factor: 2, cap: 0.2, stableAfter: 60))
    s.start()
    let restarted = await waitUntil(6) {
      ((try? String(contentsOf: count, encoding: .utf8)) ?? "").split(separator: "\n").count >= 3
    }
    #expect(restarted)
    s.stop()
  }

  @Test("stop ends the child and does not restart it")
  func stops() async {
    let d = tempDir()
    let pidFile = d.appendingPathComponent("pid")
    let fake = script(d, "fake-bun", "echo $$ > '\(pidFile.path)'\necho 'brain listening on http://127.0.0.1:49997/'\nexec sleep 30")
    let box = BrainEndpointBox()
    let s = BrainSupervisor(spec: spec(fake, home: d), token: "T", endpoint: box)
    s.start()
    #expect(await waitUntil(5) { box.endpoint != nil })
    let pid = Int32((try? String(contentsOf: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
    #expect(pid > 0 && alive(pid))
    s.stop()
    #expect(await waitUntil(5) { !alive(pid) })
    #expect(box.endpoint == nil)
    #expect(s.state == .stopped)
    try? await Task.sleep(nanoseconds: 1_500_000_000)
    #expect(s.state == .stopped)
  }

  @Test("no first line in time counts as a failed start and is retried")
  func startupTimeout() async {
    let d = tempDir()
    let fake = script(d, "fake-bun", "exec sleep 30")
    let box = BrainEndpointBox()
    let states = StateLog()
    let s = BrainSupervisor(spec: spec(fake, home: d), token: "T", endpoint: box, backoff: Backoff(base: 5),
                            startupTimeout: 0.5, onState: { states.add($0) })
    s.start()
    #expect(await waitUntil(5) { states.all.contains(.waiting(retryIn: 5)) })
    #expect(box.endpoint == nil)
    s.stop()
  }

  @Test("the guard stops the brain when its parent is gone")
  func orphanGuard() async throws {
    let parent = Process()
    parent.executableURL = URL(fileURLWithPath: "/bin/sleep")
    parent.arguments = ["1"]
    try parent.run()
    let g = Process()
    g.executableURL = URL(fileURLWithPath: "/bin/sh")
    g.arguments = ["-c", BrainLaunch.guardScript, "sh", String(parent.processIdentifier), "/bin/sleep", "30"]
    try g.run()
    #expect(await waitUntil(6) { !g.isRunning })
  }
}

final class StateLog: @unchecked Sendable {
  private let lock = NSLock()
  private var states: [BrainSupervisor.State] = []
  func add(_ s: BrainSupervisor.State) { lock.withLock { states.append(s) } }
  var all: [BrainSupervisor.State] { lock.withLock { states } }
}

@Suite("S09A observer")
struct S09AObserverTests {
  @Test("the real status JSON decodes; rows are Screen Recording, Accessibility, Input Monitoring")
  func decode() throws {
    let r = try JSONDecoder().decode(ObserverReport.self, from: S09AFixture.data("observer-status.json"))
    #expect(r.schemaVersion == 1)
    #expect(r.keepDays == 7)
    let rows = r.permissionRows()
    #expect(rows.map(\.name) == ["Screen Recording", "Accessibility", "Input Monitoring"])
    #expect(rows.map(\.required) == [true, true, false])
    #expect(!rows.contains { $0.name == "Microphone" })
  }

  @Test("no permissions in the report: every row is unknown, none amber")
  func unknown() {
    let r = ObserverReport(schemaVersion: 1, home: "/h", running: false, paused: false, daysStored: [], keepDays: 7,
                           permissions: nil, permissionsSource: "unknown", keysMode: "file", nextPurgeAt: nil)
    #expect(r.permissionRows().allSatisfy { $0.grant == .unknown && $0.role == .neutral && $0.label == "Unknown" })
  }

  @Test("Screen Recording off is required and amber; Input Monitoring off is optional and grey")
  func roles() {
    let sr = PermissionState(.screenRecording, granted: false)
    #expect(sr.role == .needsYou && sr.label == "Not allowed" && sr.offersSettings)
    let im = PermissionState(.inputMonitoring, granted: false)
    #expect(im.role == .neutral && im.label == "Off, optional")
    let ok = PermissionState(.accessibility, granted: true)
    #expect(ok.label == "Allowed" && !ok.offersSettings)
    #expect(PermissionKind.screenRecording.purpose.contains("on-screen text"))
  }

  @Test("Open Settings deep-links to the right Privacy & Security pane")
  func settingsURLs() {
    let prefix = "x-apple.systempreferences:com.apple.preference.security?"
    #expect(PermissionKind.screenRecording.settingsURL.absoluteString == prefix + "Privacy_ScreenCapture")
    #expect(PermissionKind.accessibility.settingsURL.absoluteString == prefix + "Privacy_Accessibility")
    #expect(PermissionKind.inputMonitoring.settingsURL.absoluteString == prefix + "Privacy_ListenEvent")
  }

  @Test("the mock dashboard has the real three rows and no microphone")
  func mockRows() {
    let p = MockBrainClient.dashboardObserving.permissions
    #expect(p.compactMap(\.kind) == PermissionKind.allCases)
    #expect(!p.contains { $0.grant == .notNeeded })
  }

  @Test("binary: OFFLOAD_OBSERVER_BIN, then beside the app, then engine/.build")
  func locate() {
    let has: Set<String> = ["/App/Contents/MacOS/offload-observer", "/r/engine/.build/offload-observer", "/env/obs"]
    let mac = URL(fileURLWithPath: "/App/Contents/MacOS")
    let repo = URL(fileURLWithPath: "/r")
    #expect(ObserverLocator.locate(environment: [:], executableDir: mac, repo: repo, isExecutable: has.contains)?.path == "/App/Contents/MacOS/offload-observer")
    #expect(ObserverLocator.locate(environment: ["OFFLOAD_OBSERVER_BIN": "/env/obs"], executableDir: mac, repo: repo, isExecutable: has.contains)?.path == "/env/obs")
    #expect(ObserverLocator.locate(environment: [:], executableDir: nil, repo: repo, isExecutable: has.contains)?.path == "/r/engine/.build/offload-observer")
    #expect(ObserverLocator.locate(environment: [:], executableDir: nil, repo: nil, isExecutable: has.contains) == nil)
  }

  @Test("status, pause and resume call the CLI with --home; failures are typed")
  func control() async throws {
    let d = tempDir()
    let log = d.appendingPathComponent("args")
    let json = String(decoding: S09AFixture.data("observer-status.json"), as: UTF8.self).replacingOccurrences(of: "'", with: "")
    let fake = script(d, "offload-observer", "echo \"$@\" >> '\(log.path)'\ncase \"$1\" in status) cat <<'EOF'\n\(json)\nEOF\n;; pause|resume) echo ok ;; *) exit 2 ;; esac")
    let c = ObserverControl(binary: fake, home: URL(fileURLWithPath: "/tmp/h"))
    let r = try await c.status()
    #expect(r.keepDays == 7)
    try await c.setPaused(true)
    try await c.setPaused(false)
    let calls = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
    #expect(calls.split(separator: "\n") == ["status --json --home /tmp/h", "pause --home /tmp/h", "resume --home /tmp/h"])
    let broken = script(d, "broken", "echo nope >&2\nexit 1")
    await #expect(throws: ObserverControlError.self) { try await ObserverControl(binary: broken, home: d).status() }
    await #expect(throws: ObserverControlError.notInstalled) { try await ObserverControl(binary: nil, home: d).setPaused(true) }
    #expect(await ObserverControl(binary: nil, home: d).permissionRows() == PermissionState.unknownRows)
  }

  @Test("the real observer binary, when built, answers status --json on an empty home")
  func realObserver() async throws {
    let bin = S09AFixture.repo.appendingPathComponent("engine/.build/offload-observer")
    guard FileManager.default.isExecutableFile(atPath: bin.path) else { return }
    var env = ProcessInfo.processInfo.environment
    env["OFFLOAD_KEYS"] = "file"
    let c = ObserverControl(binary: bin, home: tempDir(), environment: env)
    let r = try await c.status()
    #expect(r.schemaVersion == 1)
    #expect(r.running == false)
    #expect(r.permissionRows().count == 3)
  }
}

@Suite("S09A onboarding, demo week, launch options")
struct S09AOnboardingTests {
  @Test("four steps (s14 added the context step), counter, back and next stop at the ends")
  func steps() {
    var f = OnboardingFlow()
    #expect(f.step == .watches && f.step.counter == "1 of 4" && f.isFirst)
    f.back()
    #expect(f.step == .watches)
    f.next(); f.next(); f.next(); f.next()
    #expect(f.step == .comeBack && f.isLast && f.primaryTitle == "Done")
    #expect(OnboardingStep.comeBack.title == "Come back in a few days")
  }

  @Test("step one says what it watches and what it never stores")
  func copy() {
    #expect(OnboardingFlow.watches.count == 3)
    #expect(OnboardingFlow.neverStores.contains { $0.contains("Passwords") })
    #expect(OnboardingFlow.neverStores.contains { $0.contains("7 days") })
    #expect(OnboardingFlow.localNote.contains("on this Mac"))
  }

  @Test("live ticks: the first read is not a tick; a grant seen while open is")
  func ticks() {
    var f = OnboardingFlow()
    let off = PermissionKind.allCases.map { PermissionState($0, granted: false) }
    #expect(f.update(off).isEmpty)
    #expect(f.primaryTitle == "Continue")  // still on step 1
    f.next()
    #expect(f.primaryTitle == "Continue for now")
    var on = off
    on[0] = PermissionState(.screenRecording, granted: true)
    #expect(f.update(on) == [.screenRecording])
    #expect(f.justGranted == [.screenRecording])
    #expect(f.permissionsNote.contains("Accessibility"))
    on[1] = PermissionState(.accessibility, granted: true)
    f.update(on)
    #expect(f.requiredMissing.isEmpty && f.primaryTitle == "Continue")
  }

  @Test("an observer that does not answer reads as unknown, calmly")
  func unknownNote() {
    let f = OnboardingFlow()
    #expect(f.permissionsNote.contains("not answering"))
  }

  @Test("first run shows the window; --onboarding forces it; QA and mock runs skip it")
  func gate() {
    #expect(OnboardingGate.shouldShow(arguments: ["Offload"], onboarded: false))
    #expect(!OnboardingGate.shouldShow(arguments: ["Offload"], onboarded: true))
    #expect(OnboardingGate.shouldShow(arguments: ["Offload", "--onboarding"], onboarded: true))
    #expect(!OnboardingGate.shouldShow(arguments: ["Offload", "--mock"], onboarded: false))
    #expect(!OnboardingGate.shouldShow(arguments: ["Offload", "--open-card"], onboarded: false))
  }

  @Test("demo week: seven days ending yesterday, encrypted fixture, never the real home")
  func demoWeek() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "America/Toronto")!
    let now = cal.date(from: DateComponents(year: 2026, month: 10, day: 25, hour: 9))!
    #expect(DemoWeek.startDay(now: now, calendar: cal) == "2026-10-18")
    let repo = URL(fileURLWithPath: "/r")
    let home = DemoWeek.home(repo: repo, appSupport: URL(fileURLWithPath: "/as"))
    #expect(home.path == "/r/scratch/demo")
    #expect(DemoWeek.home(repo: nil, appSupport: URL(fileURLWithPath: "/as")).path == "/as/Offload Demo")
    #expect(DemoWeek.generatorArguments(repo: repo, out: home, start: "2026-10-18")
            == ["run", "/r/brain/fixtures/gen.ts", "--out", "/r/scratch/demo", "--start", "2026-10-18", "--encrypted"])
    let real = LaunchOptions.defaultHome(userHome: "/u")
    #expect(DemoWeek.isSafeDemoHome(home, realHome: real))
    #expect(!DemoWeek.isSafeDemoHome(real, realHome: real))
    #expect(!DemoWeek.isSafeDemoHome(real.appendingPathComponent("demo"), realHome: real))
    #expect(!DemoWeek.isSafeDemoHome(URL(fileURLWithPath: "/u/Documents"), realHome: real))
  }

  @Test("launch options: spawn by default, --mock, --brain-url, --home over OFFLOAD_HOME, dry-run limit clamped")
  func options() {
    let d = LaunchOptions.parse(arguments: ["Offload"], environment: [:], userHome: "/u")
    #expect(d.brain == .spawn)
    #expect(d.home.path == "/u/Library/Application Support/Offload")
    #expect(d.dryRunLimit == 5)
    #expect(LaunchOptions.parse(arguments: ["O", "--mock"], environment: [:]).brain == .mock)
    #expect(LaunchOptions.parse(arguments: ["O", "--brain-url", "http://127.0.0.1:9/"], environment: [:]).brain
            == .attach(URL(string: "http://127.0.0.1:9/")!))
    #expect(LaunchOptions.parse(arguments: ["O"], environment: ["OFFLOAD_HOME": "/e"]).home.path == "/e")
    #expect(LaunchOptions.parse(arguments: ["O", "--home", "/a"], environment: ["OFFLOAD_HOME": "/e"]).home.path == "/a")
    #expect(LaunchOptions.parse(arguments: ["O"], environment: ["OFFLOAD_DRYRUN_LIMIT": "1"]).dryRunLimit == 1)
    #expect(LaunchOptions.parse(arguments: ["O", "--dry-run-limit", "900"], environment: [:]).dryRunLimit == 50)
    #expect(LaunchOptions.parse(arguments: ["O", "--demo"], environment: [:]).demo)
  }

  @Test("review messages: scheduled run, waiting for a connector, or started by hand")
  func reviewMessages() {
    var w = MockBrainClient.outreachWorkflow
    w.schedule.nextRunAt = nil
    w.needsYou = []
    #expect(ReviewMessages.approved(w, now: Date()).hasPrefix("Turned on. It runs when you start it"))
    w.needsYou = ["a required connector is missing: Gmail"]
    #expect(ReviewMessages.approved(w, now: Date()) == "Turned on. Before it can send: A required connector is missing: Gmail.")
    #expect(ReviewMessages.dryRunFailed(BrainError.unreachable).contains("Brain is not running"))
    #expect(ReviewMessages.approvalFailed(BrainError.timedOut).hasSuffix("Nothing was turned on."))
  }
}

@Suite("S09A live brain (bun, fixture week; no model calls)", .serialized)
struct S09ALiveBrainTests {
  @Test("the supervisor launches the real brain; the client reads the outreach insight and drafts its workflow")
  func liveBrain() async throws {
    let repo = S09AFixture.repo
    let env = ProcessInfo.processInfo.environment
    guard let bun = BrainLaunch.findBun(environment: env),
          FileManager.default.fileExists(atPath: repo.appendingPathComponent("brain/src/cli.ts").path) else { return }
    let home = tempDir().appendingPathComponent("demo-home")
    let gen = Process()
    gen.executableURL = bun
    gen.arguments = DemoWeek.generatorArguments(repo: repo, out: home, start: DemoWeek.startDay(now: Date()))
    gen.standardOutput = FileHandle.nullDevice
    var genEnv = env
    genEnv["OFFLOAD_KEYS"] = "file"
    gen.environment = genEnv
    try gen.run()
    gen.waitUntilExit()
    #expect(gen.terminationStatus == 0)

    var base = env
    base["OFFLOAD_OBSERVER_BIN"] = nil
    base["OFFLOAD_KEYS"] = "file"  // fixtures never touch the real Keychain
    let token = BrainLaunch.newToken()
    let spec = BrainLaunch.spec(bun: bun, repo: repo, home: home, token: token, baseEnvironment: base)
    let box = BrainEndpointBox()
    let sup = BrainSupervisor(spec: spec, token: token, endpoint: box, startupTimeout: 30)
    sup.start()
    defer { sup.stop() }
    #expect(await waitUntil(30) { box.endpoint != nil })
    let c = HTTPBrainClient(endpoint: box)
    let ins = try await c.insights()
    #expect(ins.first?.taskPhrase == "outreach emails")
    let st = try await c.status()
    #expect(st.daysStored == 7)
    let w = try await c.workflow(forInsight: try #require(ins.first).id)
    #expect(w.steps.contains { $0.type == .approvalGate })
    await #expect(throws: BrainError.self) { try await c.approve(workflowId: w.id, batchHash: String(repeating: "0", count: 64)) }
    #expect(box.endpoint?.token == token)  // READY echoes the env token
    let tone = try await c.toneCard(workflowId: w.id)
    #expect(tone.workflowId == w.id)
    let skill = try await c.skill(workflowId: w.id)
    #expect(!skill.gates.isEmpty)
    _ = try await c.observer()  // available or not, it answers
    let bad = HTTPBrainClient(endpoint: BrainEndpointBox(BrainEndpoint(baseURL: box.endpoint!.baseURL, token: "wrong")))
    await #expect(throws: BrainError.unauthorized) { try await bad.status() }
  }
}
