import Foundation
import Testing

// S31: the installed app's background jobs. The launch purge and the check mode build their launches like the app's
// serve launch (bundled bun, bundle root, the observer the app found). Written before the code
// (slices/s31-local-jobs/SPEC.md).

private let app = URL(fileURLWithPath: "/Applications/Offload.app")
private let bundled = BrainLocation(bun: app.appendingPathComponent("Contents/Helpers/bun"),
                                    root: app.appendingPathComponent("Contents/Resources/offload"), bundled: true)
private let observerInApp = app.appendingPathComponent("Contents/MacOS/offload-observer")
private let home = URL(fileURLWithPath: "/Users/p/Library/Application Support/Offload")

struct S31PurgeTests {
  @Test("PURGESPEC: the launch purge runs the bundled bun on the bundled cli.ts with the app's observer and home")
  func purgeSpec() throws {
    let s = try #require(BrainLaunch.purgeSpec(location: bundled, home: home,
                                               baseEnvironment: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"],
                                               observer: observerInApp, userHome: "/Users/p", hasPurge: { _ in true }))
    #expect(s.executable == bundled.bun)
    #expect(s.arguments == ["run", "/Applications/Offload.app/Contents/Resources/offload/brain/src/cli.ts", "purge",
                            "--home", home.path])
    #expect(s.workingDirectory == bundled.root)
    #expect(s.home == home)
    #expect(s.environment["OFFLOAD_OBSERVER_BIN"] == observerInApp.path)
    #expect(s.environment["OFFLOAD_HOME"] == home.path)
    #expect(s.environment["LANG"] == "en_US.UTF-8")
    #expect(s.environment["PATH"]?.hasPrefix("/Applications/Offload.app/Contents/Helpers:") == true)
    // Never the per-launch token: the purge is not the server.
    #expect(s.environment["OFFLOAD_TOKEN"] == nil)
  }

  @Test("PURGESPEC: no purge command in this brain -> nil; no observer found -> no OFFLOAD_OBSERVER_BIN")
  func purgeSpecEdges() throws {
    #expect(BrainLaunch.purgeSpec(location: bundled, home: home, baseEnvironment: [:], observer: observerInApp,
                                  hasPurge: { _ in false }) == nil)
    let s = try #require(BrainLaunch.purgeSpec(location: bundled, home: home, baseEnvironment: ["OFFLOAD_OBSERVER_BIN": ""],
                                               observer: nil, hasPurge: { _ in true }))
    #expect(s.environment["OFFLOAD_OBSERVER_BIN"] == nil)
  }

  @Test("PURGESPEC: the purge check reads the brain's own cli.ts (the bundled one when bundled)")
  func hasPurgeReadsCli() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("s31-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir.appendingPathComponent("brain/src"), withIntermediateDirectories: true)
    let cli = dir.appendingPathComponent("brain/src/cli.ts")
    try Data("if (first === \"purge\") {}".utf8).write(to: cli)
    #expect(BrainLaunch.cliHasPurge(cli))
    try Data("serve only".utf8).write(to: cli)
    #expect(!BrainLaunch.cliHasPurge(cli))
  }
}

struct S31ObserverTests {
  @Test("OBSLOC: with no env the app finds the observer in its own Contents/MacOS, never a repo path in the bundle")
  func locatesBundledObserver() {
    let exec: (String) -> Bool = { $0 == observerInApp.path }
    let found = ObserverLocator.locate(environment: [:], executableDir: app.appendingPathComponent("Contents/MacOS"),
                                       repo: bundled.root, isExecutable: exec)
    #expect(found == observerInApp)
    // The repo fallback inside a bundle does not exist: nothing else is picked.
    #expect(ObserverLocator.locate(environment: [:], executableDir: nil, repo: bundled.root, isExecutable: exec) == nil)
  }
}

struct S31CheckTests {
  @Test("CHECKOPTS: --hold N and --captioner stub|off parse; defaults are the s25 check")
  func parse() throws {
    #expect(try BrainCheck.Options.parse(["Offload", "--brain-check", "--home", "/h"]) == BrainCheck.Options())
    let o = try BrainCheck.Options.parse(["Offload", "--brain-check", "--home", "/h", "--hold", "90", "--captioner", "stub"])
    #expect(o.hold == 90)
    #expect(o.captioner == "stub")
    #expect(try BrainCheck.Options.parse(["--captioner", "off"]).captioner == "off")
  }

  @Test("CHECKOPTS: real captioners, a missing or bad hold are refused (check mode only takes the stub)")
  func refuses() {
    for bad in [["--captioner", "claude"], ["--captioner", "ollama"], ["--captioner", "auto"], ["--captioner"],
                ["--hold"], ["--hold", "-1"], ["--hold", "x"], ["--hold", "100000"]] {
      #expect(throws: BrainCheck.OptionError.self) { try BrainCheck.Options.parse(["Offload", "--brain-check"] + bad) }
    }
  }

  @Test("CHECKOPTS: the check spec carries the app's observer and the captioner flag; without them it is the s25 spec")
  func spec() {
    let env = ["PATH": "/usr/bin:/bin", "OFFLOAD_KEYS": "file"]
    let plain = BrainCheck.launchSpec(location: bundled, home: home, token: "t", environment: env, keyStatus: .missing,
                                      observer: nil, options: BrainCheck.Options())
    #expect(plain == BrainLaunch.spec(location: bundled, home: home, token: "t",
                                      baseEnvironment: BrainLaunch.claudeKeyEnvironment(env, status: .missing), model: "stub"))
    var o = BrainCheck.Options()
    o.captioner = "stub"
    let s = BrainCheck.launchSpec(location: bundled, home: home, token: "t", environment: env, keyStatus: .missing,
                                  observer: observerInApp, options: o)
    #expect(s.environment["OFFLOAD_OBSERVER_BIN"] == observerInApp.path)
    #expect(Array(s.arguments.suffix(2)) == ["--captioner", "stub"])
    #expect(s.arguments.contains("--model") && s.arguments.contains("stub"))
  }
}
