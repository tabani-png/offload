import Foundation

// s25: `Offload --brain-check --home DIR`. Starts the brain the way the app does (BrainLaunch.locate, the launch spec,
// BrainSupervisor with its orphan guard), waits for the ready line, calls GET /status with the token, then stops it.
// Model stub: no key is needed and nothing is sent. Prints the source and the HTTP status; exit 0 only on 200.
// slices/s25-standalone-install/verify.sh runs it from a copy of the app outside the repo with no bun on PATH.
// s29: it also prints `key: set` or `key: missing` (the Claude key in the login Keychain), never the key, and launches
// the brain with the same Keychain reference the app uses.
// s31: like the app it runs the launch purge first (`purge: ...` line) and passes the observer the app would find.
// Check mode only (slices/s31-local-jobs): `--hold S` keeps the supervised brain up for S seconds, prints every state
// change (`brain state: ...`, `brain endpoint: URL`), writes the per-launch token to HOME/.brain-check-token (0600),
// restarts the brain on SIGUSR1 (the s29 key-change path) and stops it on SIGTERM. `--captioner stub|off` adds the
// brain's own flag. Nothing here changes a normal launch.
enum BrainCheck {
  static let usage = "usage: Offload --brain-check --home DIR [--hold SECONDS (0-3600)] [--captioner stub|off]"
  static let tokenFileName = ".brain-check-token"

  struct OptionError: Error, Equatable, CustomStringConvertible {
    var description: String
  }

  struct Options: Equatable, Sendable {
    var hold: TimeInterval = 0
    var captioner: String?

    static let maxHold: TimeInterval = 3600

    static func parse(_ args: [String]) throws -> Options {
      var o = Options()
      if let i = args.firstIndex(of: "--hold") {
        guard args.indices.contains(i + 1), let v = Double(args[i + 1]), v.isFinite, v >= 0, v <= maxHold else {
          throw OptionError(description: "--hold takes 0 to \(Int(maxHold)) seconds")
        }
        o.hold = v
      }
      if let i = args.firstIndex(of: "--captioner") {
        guard args.indices.contains(i + 1), ["stub", "off"].contains(args[i + 1]) else {
          throw OptionError(description: "--captioner in check mode is stub or off (the real captioners are the app's choice)")
        }
        o.captioner = args[i + 1]
      }
      return o
    }
  }

  static func sourceLine(_ l: BrainLocation?) -> String {
    guard let l else { return "brain source: none" }
    return "brain source: \(l.bundled ? "bundled" : "repo") \(l.bun.path) \(l.root.path)"
  }

  /// The check's serve launch: the app's spec with the stub model, the observer the app would find and, in check mode
  /// only, the captioner flag.
  static func launchSpec(location: BrainLocation, home: URL, token: String, environment env: [String: String],
                         keyStatus: ClaudeKeyStatus, observer: URL?, options: Options) -> BrainLaunchSpec {
    BrainLaunch.spec(location: location, home: home, token: token,
                     baseEnvironment: BrainLaunch.claudeKeyEnvironment(env, status: keyStatus), observer: observer,
                     model: "stub", understanding: options.captioner.map { ["--captioner", $0] } ?? [])
  }

  static func run(bundleURL: URL, environment env: [String: String], home: URL, keyStatus: ClaudeKeyStatus,
                  executableDir: URL? = nil, options: Options = Options(), timeout: TimeInterval = 30) -> Int32 {
    setvbuf(stdout, nil, _IOLBF, 0)  // line by line: a hold run is read while it runs
    let loc = BrainLaunch.locate(bundleURL: bundleURL, environment: env)
    print(sourceLine(loc))
    print(keyStatus.checkLine)
    guard let loc else { print("brain status: no brain (no bundled brain, no repo with bun)"); return 1 }
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    let observer = ObserverLocator.locate(environment: env, executableDir: executableDir, repo: loc.root)
    // The app's launch purge (AppDelegate.purgeOnce), before serve.
    if let ps = BrainLaunch.purgeSpec(location: loc, home: home, baseEnvironment: env, observer: observer) {
      let r = BrainLaunch.runPurge(ps)
      print("purge: \(r.status.map { "exit \($0)" } ?? "not finished") \(r.output)")
    } else {
      print("purge: none (this brain has no purge command)")
    }
    let token = BrainLaunch.newToken()
    let spec = launchSpec(location: loc, home: home, token: token, environment: env, keyStatus: keyStatus,
                          observer: observer, options: options)
    let box = BrainEndpointBox()
    let errLog = home.appendingPathComponent("brain-check.err.log")
    let tokenFile = home.appendingPathComponent(tokenFileName)
    let hold = options.hold > 0
    let sup = BrainSupervisor(spec: spec, token: token, endpoint: box, startupTimeout: timeout, stderrLog: errLog) { state in
      guard hold else { return }
      print("brain state: \(state.label)")
      if case .running(let url) = state {
        if let ep = box.endpoint { writeToken(ep.token, to: tokenFile) }
        print("brain endpoint: \(url.absoluteString)")
      }
    }
    sup.start()
    defer { sup.stop() }
    let deadline = Date().addingTimeInterval(timeout)
    while box.endpoint == nil && Date() < deadline {
      if case .failed(let why) = sup.state { print("brain status: \(why)"); return 1 }
      usleep(100_000)
    }
    guard let ep = box.endpoint else {
      print("brain status: no ready line within \(Int(timeout)) s (stderr: \(errLog.path))")
      return 1
    }
    var req = URLRequest(url: ep.baseURL.appendingPathComponent("status"), timeoutInterval: 10)
    req.setValue("Bearer \(ep.token)", forHTTPHeaderField: "Authorization")
    let done = DispatchSemaphore(value: 0)
    let result = ResultBox()
    let session = URLSession(configuration: .ephemeral)
    session.dataTask(with: req) { data, resp, err in
      result.set(code: (resp as? HTTPURLResponse)?.statusCode ?? 0, body: data ?? Data(), error: err)
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 15)
    session.invalidateAndCancel()
    let (code, body, error) = result.get()
    if let error { print("brain status: request failed: \(error.localizedDescription)"); return 1 }
    print("brain status: \(code) GET /status (\(body.count) bytes)")
    if hold && code == 200 { holdBrain(sup, home: home, spec: spec, seconds: options.hold, tokenFile: tokenFile) }
    return code == 200 ? 0 : 1
  }

  /// Check mode only: keeps the supervised brain up; SIGUSR1 restarts it like a key change, SIGTERM stops it.
  private static func holdBrain(_ sup: BrainSupervisor, home: URL, spec: BrainLaunchSpec, seconds: TimeInterval,
                                tokenFile: URL) {
    let q = DispatchQueue(label: "ai.offload.brain-check.signals")
    var sources: [DispatchSourceSignal] = []
    for sig in [SIGTERM, SIGUSR1] {
      signal(sig, SIG_IGN)
      let s = DispatchSource.makeSignalSource(signal: sig, queue: q)
      s.setEventHandler {
        if sig == SIGUSR1 {
          print("brain check: restarting the brain (key change path)")
          sup.restart(home: home, spec: spec)
        } else {
          print("brain check: stopping")
          sup.stop()
          try? FileManager.default.removeItem(at: tokenFile)
          exit(0)
        }
      }
      s.resume()
      sources.append(s)
    }
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { usleep(200_000) }
    sources.forEach { $0.cancel() }
    try? FileManager.default.removeItem(at: tokenFile)
    print("brain check: hold over")
  }

  private static func writeToken(_ token: String, to url: URL) {
    let fm = FileManager.default
    try? fm.removeItem(at: url)
    fm.createFile(atPath: url.path, contents: Data(token.utf8), attributes: [.posixPermissions: 0o600])
  }

  private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var code = 0
    private var body = Data()
    private var error: Error?
    func set(code: Int, body: Data, error: Error?) { lock.withLock { self.code = code; self.body = body; self.error = error } }
    func get() -> (Int, Data, Error?) { lock.withLock { (code, body, error) } }
  }
}
