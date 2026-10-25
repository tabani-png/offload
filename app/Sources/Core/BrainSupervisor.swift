import Foundation

// s09a: the app launches the brain as a child process and keeps it alive.
//
//   bun run brain/src/cli.ts serve --home DIR --port 0      (env OFFLOAD_TOKEN = a fresh per-launch token)
//
// Token handoff: the app generates the token and passes it in the environment (brain/API.md: "The app passes its
// per-launch token in the env"). The port comes from the brain's first stdout line. Two formats are read: the s05c
// handshake `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}` (its token is adopted), and the v1 line
// `brain listening on http://127.0.0.1:PORT/` (then a later `OFFLOAD_TOKEN=…` line, if any, is adopted). A shell guard kills the brain when the app dies, so a
// crash never leaves an orphan listening.

struct BrainLaunchSpec: Equatable, Sendable {
  var executable: URL
  var arguments: [String]
  var environment: [String: String]
  var workingDirectory: URL
  var home: URL
}

enum BrainLaunch {
  static let listeningPrefix = "brain listening on "
  /// s05c handshake (brain/src/api/types.ts BRAIN_READY_PREFIX): `OFFLOAD_BRAIN_READY {"port":N,"token":"..."}`.
  static let readyPrefix = "OFFLOAD_BRAIN_READY"

  /// The s05c ready line → loopback URL and token. Port 1..65535, token at least minTokenLength.
  static func parseReady(_ line: String) -> (url: URL, token: String)? {
    let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.hasPrefix(readyPrefix + " ") else { return nil }
    struct Ready: Decodable { var port: Int; var token: String }
    guard let r = try? JSONDecoder().decode(Ready.self, from: Data(t.dropFirst(readyPrefix.count + 1).utf8)),
          r.port > 0, r.port < 65536, r.token.count >= minTokenLength else { return nil }
    var c = URLComponents()
    c.scheme = "http"
    c.host = "127.0.0.1"
    c.port = r.port
    c.path = "/"
    guard let u = c.url else { return nil }
    return (u, r.token)
  }
  static let tokenPrefix = "OFFLOAD_TOKEN="

  /// `brain listening on http://127.0.0.1:51123/` → that URL. Loopback hosts and a real port only.
  static func parseListening(_ line: String) -> URL? {
    let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.hasPrefix(listeningPrefix) else { return nil }
    let raw = String(t.dropFirst(listeningPrefix.count)).trimmingCharacters(in: .whitespaces)
    guard let u = URL(string: raw), u.scheme == "http", let host = u.host, ["127.0.0.1", "localhost"].contains(host),
          let port = u.port, port > 0, port < 65536 else { return nil }
    var c = URLComponents()
    c.scheme = "http"
    c.host = "127.0.0.1"
    c.port = port
    c.path = "/"
    return c.url
  }

  /// `OFFLOAD_TOKEN=…` → the token, when it is long enough to be one the brain accepts.
  static func parseToken(_ line: String) -> String? {
    let t = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard t.hasPrefix(tokenPrefix) else { return nil }
    let v = String(t.dropFirst(tokenPrefix.count))
    return v.count >= minTokenLength ? v : nil
  }

  /// brain/src/api/server.ts MIN_TOKEN_LENGTH.
  static let minTokenLength = 32

  /// 32 random bytes, base64url without padding (43 characters).
  static func newToken() -> String {
    var g = SystemRandomNumberGenerator()
    let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &g) }
    return Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Where bun usually lives. A GUI app gets a bare PATH, so the usual install places are tried first.
  static func findBun(environment env: [String: String], userHome: String = NSHomeDirectory(),
                      isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> URL? {
    var candidates: [String] = []
    if let b = env["OFFLOAD_BUN"], !b.isEmpty { candidates.append(b) }
    candidates += ["\(userHome)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
    candidates += (env["PATH"] ?? "").split(separator: ":").map { "\($0)/bun" }
    return candidates.first(where: isExecutable).map { URL(fileURLWithPath: $0) }
  }

  /// The repo root (holds brain/src/cli.ts): OFFLOAD_REPO, else up to six folders above the app bundle
  /// (app/.build/Offload.app sits three below it).
  static func findRepo(bundleURL: URL, environment env: [String: String],
                       exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> URL? {
    if let r = env["OFFLOAD_REPO"], !r.isEmpty, exists("\(r)/brain/src/cli.ts") { return URL(fileURLWithPath: r) }
    var dir = bundleURL.standardizedFileURL
    for _ in 0..<6 {
      dir = dir.deletingLastPathComponent()
      if exists(dir.appendingPathComponent("brain/src/cli.ts").path) { return dir }
    }
    return nil
  }

  /// PATH for the brain: the usual tool folders first (the Agent SDK looks for node and claude on it).
  static func path(base: String?, bun: URL, userHome: String = NSHomeDirectory()) -> String {
    var parts = [bun.deletingLastPathComponent().path, "\(userHome)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    parts += (base ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
    var seen = Set<String>()
    return parts.filter { seen.insert($0).inserted }.joined(separator: ":")
  }

  /// `model`: "stub" or "real" for `serve --model` (s09b); nil leaves the brain's default (real).
  static func spec(bun: URL, repo: URL, home: URL, token: String, baseEnvironment: [String: String],
                   observer: URL? = nil, userHome: String = NSHomeDirectory(), model: String? = nil) -> BrainLaunchSpec {
    var env = baseEnvironment
    env["OFFLOAD_TOKEN"] = token
    env["OFFLOAD_HOME"] = home.path
    env["PATH"] = path(base: baseEnvironment["PATH"], bun: bun, userHome: userHome)
    if let observer { env["OFFLOAD_OBSERVER_BIN"] = observer.path }
    return BrainLaunchSpec(
      executable: bun,
      arguments: ["run", repo.appendingPathComponent("brain/src/cli.ts").path, "serve", "--home", home.path, "--port", "0"]
        + (model.map { ["--model", $0] } ?? []),
      environment: env, workingDirectory: repo, home: home)
  }

  /// `bun run brain/src/cli.ts purge --home DIR` (REVIEW-2): deletes expired days before serve starts. nil when this
  /// brain has no purge command yet.
  static func purgeArguments(repo: URL, home: URL, fileManager fm: FileManager = .default) -> [String]? {
    let cli = repo.appendingPathComponent("brain/src/cli.ts")
    guard let src = try? String(contentsOf: cli, encoding: .utf8), src.contains("\"purge\"") else { return nil }
    return ["run", cli.path, "purge", "--home", home.path]
  }

  /// Which model the brain drafts with: OFFLOAD_BRAIN_MODEL when set, else the stub for the demo week (its drafts are
  /// labelled "Sample drafts"), else the brain's default.
  static func model(environment: [String: String], demo: Bool) -> String? {
    if let m = environment["OFFLOAD_BRAIN_MODEL"], ["stub", "real"].contains(m) { return m }
    return demo ? "stub" : nil
  }

  /// The orphan guard: `sh -c GUARD sh PARENT_PID cmd args…` runs the command, stops it on TERM, and stops it when
  /// the parent pid is gone. Exits with the command's status.
  static let guardScript = """
    parent="$1"; shift
    "$@" &
    child=$!
    trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 143' TERM INT HUP
    while kill -0 "$parent" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 1; done
    kill -TERM "$child" 2>/dev/null
    wait "$child"
    """
}

/// Restart delays: 1, 2, 4 … 30 s; a run that lasted a minute counts as healthy and starts over at 1 s.
struct Backoff: Equatable, Sendable {
  var base: TimeInterval = 1
  var factor: Double = 2
  var cap: TimeInterval = 30
  var stableAfter: TimeInterval = 60
  private(set) var failures = 0

  init(base: TimeInterval = 1, factor: Double = 2, cap: TimeInterval = 30, stableAfter: TimeInterval = 60) {
    self.base = base
    self.factor = factor
    self.cap = cap
    self.stableAfter = stableAfter
  }

  mutating func delay(afterRunning uptime: TimeInterval) -> TimeInterval {
    if uptime >= stableAfter { failures = 0 }
    let d = min(cap, base * pow(factor, Double(failures)))
    failures += 1
    return d
  }

  mutating func reset() { failures = 0 }
}

/// Splits a byte stream into lines.
struct LineBuffer: Sendable {
  private var pending = Data()

  mutating func append(_ d: Data) -> [String] {
    pending.append(d)
    var lines: [String] = []
    while let nl = pending.firstIndex(of: 0x0A) {
      lines.append(String(decoding: pending[pending.startIndex..<nl], as: UTF8.self))
      pending = Data(pending[pending.index(after: nl)...])
    }
    return lines
  }
}

/// Runs the brain, reads its port, restarts it with backoff when it dies, stops it on quit.
final class BrainSupervisor: @unchecked Sendable {
  enum State: Equatable, Sendable {
    case idle
    case starting
    case running(URL)
    /// It died (or never said where it listens); the next try is in this many seconds.
    case waiting(retryIn: TimeInterval)
    /// Cannot start at all (no bun, no repo). Says why.
    case failed(String)
    case stopped

    var label: String {
      switch self {
      case .idle, .stopped: return "Brain stopped"
      case .starting: return "Brain is starting"
      case .running: return "Brain running"
      case .waiting(let s): return "Brain is not running. Trying again in \(Int(s.rounded())) s"
      case .failed(let why): return why
      }
    }
  }

  let endpoint: BrainEndpointBox
  let startupTimeout: TimeInterval
  private let lock = NSLock()
  private var spec: BrainLaunchSpec
  private var token: String
  private var backoff: Backoff
  private var process: Process?
  private var generation = 0
  private var startedAt = Date()
  private var stopping = false
  private var current: State = .idle
  private let stderrLog: URL?
  private let onState: @Sendable (State) -> Void

  init(spec: BrainLaunchSpec, token: String, endpoint: BrainEndpointBox, backoff: Backoff = Backoff(),
       startupTimeout: TimeInterval = 25, stderrLog: URL? = nil, onState: @escaping @Sendable (State) -> Void = { _ in }) {
    self.spec = spec
    self.token = token
    self.endpoint = endpoint
    self.backoff = backoff
    self.startupTimeout = startupTimeout
    self.stderrLog = stderrLog
    self.onState = onState
  }

  var state: State { lock.withLock { current } }
  var home: URL { lock.withLock { spec.home } }
  var pid: Int32? { lock.withLock { process?.processIdentifier } }

  private func set(_ s: State) {
    lock.withLock { current = s }
    onState(s)
  }

  func start() {
    lock.withLock { stopping = false }
    launch()
  }

  /// Points the brain at another home (the demo week): stops the running one and starts fresh.
  func restart(home: URL, spec newSpec: BrainLaunchSpec) {
    stopProcess()
    lock.withLock {
      spec = newSpec
      stopping = false
      backoff.reset()
    }
    launch()
  }

  /// Stops the brain and does not restart it. Waits up to `grace` seconds, then kills it.
  func stop(grace: TimeInterval = 2) {
    lock.withLock { stopping = true }
    stopProcess(grace: grace)
    set(.stopped)
  }

  private func stopProcess(grace: TimeInterval = 2) {
    let p: Process? = lock.withLock {
      generation += 1
      let p = process
      process = nil
      return p
    }
    endpoint.endpoint = nil
    endpoint.starting = false
    guard let p, p.isRunning else { return }
    p.terminate()
    let deadline = Date().addingTimeInterval(grace)
    while p.isRunning && Date() < deadline { usleep(20_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
  }

  private func launch() {
    let (s, gen, tok): (BrainLaunchSpec, Int, String) = lock.withLock {
      generation += 1
      startedAt = Date()
      return (spec, generation, token)
    }
    endpoint.endpoint = nil
    endpoint.starting = true
    set(.starting)

    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", BrainLaunch.guardScript, "sh", String(getpid()), s.executable.path] + s.arguments
    p.environment = s.environment
    p.currentDirectoryURL = s.workingDirectory
    p.standardInput = FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    p.standardOutput = out
    p.standardError = err

    var lines = LineBuffer()
    var found: URL?
    var adoptedToken = tok
    out.fileHandleForReading.readabilityHandler = { [weak self] h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      for line in lines.append(d) {
        if found == nil, let r = BrainLaunch.parseReady(line) {
          found = r.url
          adoptedToken = r.token
          self?.becameReady(url: r.url, token: r.token, generation: gen)
          continue
        }
        if let t = BrainLaunch.parseToken(line) {
          adoptedToken = t
          if let u = found { self?.becameReady(url: u, token: t, generation: gen) }
        }
        if found == nil, let u = BrainLaunch.parseListening(line) {
          found = u
          self?.becameReady(url: u, token: adoptedToken, generation: gen)
        }
      }
    }
    let log = stderrLog
    err.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      if d.isEmpty { h.readabilityHandler = nil; return }
      if let log { Self.append(d, to: log) }
    }
    p.terminationHandler = { [weak self] proc in
      out.fileHandleForReading.readabilityHandler = nil
      err.fileHandleForReading.readabilityHandler = nil
      self?.exited(status: proc.terminationStatus, generation: gen)
    }
    do {
      try p.run()
    } catch {
      endpoint.starting = false
      set(.failed("Brain could not start: \(error.localizedDescription)"))
      return
    }
    lock.withLock { process = p }

    // No first line in time: treat it as a failed start.
    DispatchQueue.global().asyncAfter(deadline: .now() + startupTimeout) { [weak self] in
      guard let self else { return }
      let stale: Process? = self.lock.withLock {
        guard self.generation == gen, case .starting = self.current else { return nil }
        return self.process
      }
      stale?.terminate()
    }
  }

  private func becameReady(url: URL, token: String, generation gen: Int) {
    let ok: Bool = lock.withLock { generation == gen && !stopping }
    guard ok else { return }
    endpoint.endpoint = BrainEndpoint(baseURL: url, token: token)
    endpoint.starting = false
    set(.running(url))
  }

  private func exited(status: Int32, generation gen: Int) {
    let delay: TimeInterval? = lock.withLock {
      guard generation == gen else { return nil }
      process = nil
      if stopping { return nil }
      return backoff.delay(afterRunning: Date().timeIntervalSince(startedAt))
    }
    guard let delay else { return }
    endpoint.endpoint = nil
    endpoint.starting = false
    set(.waiting(retryIn: delay))
    DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      let go: Bool = self.lock.withLock { self.generation == gen && !self.stopping }
      if go { self.launch() }
    }
  }

  private static func append(_ d: Data, to url: URL) {
    let fm = FileManager.default
    try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
    guard let h = try? FileHandle(forWritingTo: url) else { return }
    defer { try? h.close() }
    _ = try? h.seekToEnd()
    try? h.write(contentsOf: d)
  }
}
