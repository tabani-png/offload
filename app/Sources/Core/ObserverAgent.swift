import Foundation

// s31 (operator decision): the observer runs in the background from login ONLY after the person says Yes.
// First run of the installed app asks once ("Yes" / "Not now"); the answer is remembered and never asked again.
// Yes: the bundled observer writes its LaunchAgent (`offload-observer install-agent`, program inside the bundle) and
// the app loads it (`launchctl bootstrap gui/UID PLIST`). Not now: nothing is written. Settings has the same switch:
// on installs and loads, off unloads (`launchctl bootout`) and deletes the plist.
// With OFFLOAD_LAUNCH_AGENTS_DIR set (tests) the plist goes there and launchd is never touched.

enum ObserverAgentConsent: String, Equatable, Sendable {
  case yes
  case notNow
}

enum ObserverAgentSetting {
  static let defaultsKey = "ai.offload.observerAtLogin.v1"
  static let question = "Let Offload watch your work in the background, starting when you log in?"
  static let detail = "You can turn this off in Settings."
  static let label = "Watch my work in the background, starting when I log in"

  static func answer(_ defaults: UserDefaults) -> ObserverAgentConsent? {
    defaults.string(forKey: defaultsKey).flatMap(ObserverAgentConsent.init(rawValue:))
  }

  static func save(_ answer: ObserverAgentConsent, _ defaults: UserDefaults) {
    defaults.set(answer.rawValue, forKey: defaultsKey)
  }

  /// Ask once: no answer yet, the installed app (bundled brain) with its observer, not the mock or the demo week.
  /// `demo` is the --demo launch flag, `demoActive` the demo week chosen in onboarding: either one is demo.
  static func shouldAsk(answer: ObserverAgentConsent?, bundled: Bool, observer: URL?, mock: Bool, demo: Bool,
                        demoActive: Bool = false) -> Bool {
    answer == nil && bundled && observer != nil && !mock && !demo && !demoActive
  }
}

struct ObserverAgentError: Error, Equatable, CustomStringConvertible {
  var description: String
}

struct ObserverAgent {
  static let label = "ai.offload.observer"
  static let launchctl = URL(fileURLWithPath: "/bin/launchctl")

  typealias Runner = (URL, [String], [String: String]) -> (status: Int32, output: String)

  let binary: URL
  let home: URL
  var environment: [String: String] = ProcessInfo.processInfo.environment
  var uid: uid_t = getuid()
  var run: Runner = ObserverAgent.runProcess

  /// Tests write the plist into OFFLOAD_LAUNCH_AGENTS_DIR and never load it.
  var loadsLaunchd: Bool { (environment["OFFLOAD_LAUNCH_AGENTS_DIR"] ?? "").isEmpty }

  /// The same place the observer writes it (engine LaunchAgent.agentsDir).
  var plistURL: URL {
    let dir = environment["OFFLOAD_LAUNCH_AGENTS_DIR"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents")
    return dir.appendingPathComponent("\(Self.label).plist")
  }

  var installed: Bool { FileManager.default.fileExists(atPath: plistURL.path) }

  /// Writes the plist with the bundled observer, then loads it (replacing a loaded copy).
  func install() throws {
    let w = run(binary, ["install-agent", "--home", home.path], environment)
    guard w.status == 0 else { throw ObserverAgentError(description: "The observer could not set itself up (\(w.status)).") }
    guard loadsLaunchd else { return }
    _ = run(Self.launchctl, ["bootout", "gui/\(uid)/\(Self.label)"], environment)
    let b = run(Self.launchctl, ["bootstrap", "gui/\(uid)", plistURL.path], environment)
    guard b.status == 0 else { throw ObserverAgentError(description: "macOS did not start the observer (\(b.status)).") }
  }

  /// Unloads it (if loaded) and deletes the plist. A failed bootout is fine only when the agent is not loaded
  /// (`launchctl print` fails); if it is still loaded the plist stays and this throws, so the switch stays on.
  func remove() throws {
    if loadsLaunchd {
      let target = "gui/\(uid)/\(Self.label)"
      let b = run(Self.launchctl, ["bootout", target], environment)
      if b.status != 0 && run(Self.launchctl, ["print", target], environment).status == 0 {
        throw ObserverAgentError(description: "macOS did not stop the observer (\(b.status)). It is still running.")
      }
    }
    let r = run(binary, ["uninstall-agent", "--home", home.path], environment)
    guard r.status == 0 else { throw ObserverAgentError(description: "The observer could not remove its login item (\(r.status)).") }
  }

  static func runProcess(_ exe: URL, _ args: [String], _ env: [String: String]) -> (status: Int32, output: String) {
    let p = Process()
    p.executableURL = exe
    p.arguments = args
    p.environment = env
    p.standardInput = FileHandle.nullDevice
    let out = Pipe()
    p.standardOutput = out
    p.standardError = out
    do { try p.run() } catch { return (-1, error.localizedDescription) }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(decoding: data, as: UTF8.self))
  }
}
