import Foundation

// s25: `Offload --brain-check --home DIR`. Starts the brain the way the app does (BrainLaunch.locate, the launch spec,
// BrainSupervisor with its orphan guard), waits for the ready line, calls GET /status with the token, then stops it.
// Model stub: no key is needed and nothing is sent. Prints the source and the HTTP status; exit 0 only on 200.
// slices/s25-standalone-install/verify.sh runs it from a copy of the app outside the repo with no bun on PATH.
enum BrainCheck {
  static func sourceLine(_ l: BrainLocation?) -> String {
    guard let l else { return "brain source: none" }
    return "brain source: \(l.bundled ? "bundled" : "repo") \(l.bun.path) \(l.root.path)"
  }

  static func run(bundleURL: URL, environment env: [String: String], home: URL, timeout: TimeInterval = 30) -> Int32 {
    let loc = BrainLaunch.locate(bundleURL: bundleURL, environment: env)
    print(sourceLine(loc))
    guard let loc else { print("brain status: no brain (no bundled brain, no repo with bun)"); return 1 }
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    let token = BrainLaunch.newToken()
    let spec = BrainLaunch.spec(location: loc, home: home, token: token, baseEnvironment: env, model: "stub")
    let box = BrainEndpointBox()
    let errLog = home.appendingPathComponent("brain-check.err.log")
    let sup = BrainSupervisor(spec: spec, token: token, endpoint: box, startupTimeout: timeout, stderrLog: errLog)
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
    return code == 200 ? 0 : 1
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
