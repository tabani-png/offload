import Foundation

// s09a: the app asks the observer for its state and permissions (`offload-observer status --json`, schemaVersion 1,
// engine/README.md) and pauses or resumes it (`offload-observer pause|resume`). The binary is the bundled copy in
// Offload.app/Contents/MacOS, else engine/.build in the repo, else OFFLOAD_OBSERVER_BIN.

/// The part of the observer's status JSON the app reads. Unknown keys are ignored.
struct ObserverReport: Decodable, Equatable, Sendable {
  struct Permissions: Decodable, Equatable, Sendable {
    var screenRecording: Bool
    var accessibility: Bool
    var inputMonitoring: Bool
  }
  var schemaVersion: Int?
  var home: String
  /// A heartbeat newer than 15 s from a live pid.
  var running: Bool
  var paused: Bool
  var daysStored: [String]
  var keepDays: Int
  var permissions: Permissions?
  /// "heartbeat" (the running observer's own view), "probe" (asked just now) or "unknown".
  var permissionsSource: String?
  var keysMode: String?
  var nextPurgeAt: Double?

  /// Screen Recording, Accessibility, Input Monitoring, in that order. Unknown when the observer did not say.
  func permissionRows() -> [PermissionState] {
    PermissionKind.allCases.map { k in
      let granted: Bool?
      switch k {
      case .screenRecording: granted = permissions?.screenRecording
      case .accessibility: granted = permissions?.accessibility
      case .inputMonitoring: granted = permissions?.inputMonitoring
      }
      return PermissionState(k, granted: granted)
    }
  }

  /// "Watching", "Paused", "Not running".
  var stateLabel: String { paused ? "Paused" : (running ? "Watching" : "Not running") }
}

extension PermissionState {
  /// All three rows unknown (no observer to ask).
  static var unknownRows: [PermissionState] { PermissionKind.allCases.map { PermissionState($0, granted: nil) } }
}

enum ObserverControlError: Error, Equatable {
  case notInstalled
  case failed(String)

  var userMessage: String {
    switch self {
    case .notInstalled: return "The observer is not installed. Run scripts/run.sh to build it."
    case .failed: return "The observer did not answer. Nothing was changed."
    }
  }
}

enum ObserverLocator {
  static let binaryName = "offload-observer"

  /// OFFLOAD_OBSERVER_BIN, then the copy beside the app's own executable, then engine/.build in the repo.
  static func locate(environment env: [String: String], executableDir: URL?, repo: URL?,
                     isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> URL? {
    var c: [String] = []
    if let b = env["OFFLOAD_OBSERVER_BIN"], !b.isEmpty { c.append(b) }
    if let d = executableDir { c.append(d.appendingPathComponent(binaryName).path) }
    if let r = repo { c.append(r.appendingPathComponent("engine/.build/\(binaryName)").path) }
    return c.first(where: isExecutable).map { URL(fileURLWithPath: $0) }
  }
}

/// Runs the observer CLI. No shell; arguments are passed as a list.
struct ObserverControl: Sendable {
  let binary: URL?
  let home: URL
  var environment: [String: String] = ProcessInfo.processInfo.environment
  var timeout: TimeInterval = 10

  struct Output: Sendable { var status: Int32; var stdout: Data; var stderr: Data }

  func run(_ args: [String]) async throws -> Output {
    guard let binary else { throw ObserverControlError.notInstalled }
    let p = Process()
    p.executableURL = binary
    p.arguments = args + ["--home", home.path]
    p.environment = environment
    p.standardInput = FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    p.standardOutput = out
    p.standardError = err
    return try await withCheckedThrowingContinuation { cont in
      let done = OnceFlag()
      p.terminationHandler = { proc in
        guard done.claim() else { return }
        let o = out.fileHandleForReading.readDataToEndOfFile()
        let e = err.fileHandleForReading.readDataToEndOfFile()
        cont.resume(returning: Output(status: proc.terminationStatus, stdout: o, stderr: e))
      }
      do {
        try p.run()
      } catch {
        if done.claim() { cont.resume(throwing: ObserverControlError.failed("\(error)")) }
        return
      }
      let t = timeout
      DispatchQueue.global().asyncAfter(deadline: .now() + t) {
        guard p.isRunning else { return }
        p.terminate()
        if done.claim() { cont.resume(throwing: ObserverControlError.failed("timed out after \(Int(t)) s")) }
      }
    }
  }

  func status() async throws -> ObserverReport {
    let o = try await run(["status", "--json"])
    guard o.status == 0 else { throw ObserverControlError.failed(String(decoding: o.stderr, as: UTF8.self)) }
    do {
      return try JSONDecoder().decode(ObserverReport.self, from: o.stdout)
    } catch {
      throw ObserverControlError.failed("status JSON: \(error)")
    }
  }

  func setPaused(_ paused: Bool) async throws {
    let o = try await run([paused ? "pause" : "resume"])
    guard o.status == 0 else { throw ObserverControlError.failed(String(decoding: o.stderr, as: UTF8.self)) }
  }

  /// The three permission rows, or all unknown when the observer cannot be asked.
  func permissionRows() async -> [PermissionState] {
    (try? await status())?.permissionRows() ?? PermissionState.unknownRows
  }
}

/// True exactly once, from any thread.
final class OnceFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var used = false
  func claim() -> Bool {
    lock.withLock {
      if used { return false }
      used = true
      return true
    }
  }
}
