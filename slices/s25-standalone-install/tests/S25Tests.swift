import Foundation
import Testing

// S25: Offload.app carries its brain (a pinned bun in Contents/Helpers, the brain's JS in Contents/Resources/offload).
// The bundled brain is used first; the repo (OFFLOAD_REPO or walking up from the bundle) is a dev-only fallback.
// Written before the code (slices/s25-standalone-install/SPEC.md).

struct S25LocateTests {
  let app = URL(fileURLWithPath: "/Applications/Offload.app")
  var bunInApp: String { "/Applications/Offload.app/Contents/Helpers/bun" }
  var cliInApp: String { "/Applications/Offload.app/Contents/Resources/offload/brain/src/cli.ts" }

  @Test("BUNDLED: Helpers/bun plus Resources/offload/brain/src/cli.ts is the bundled brain")
  func bundled() {
    let exists: (String) -> Bool = { $0 == cliInApp }
    let exec: (String) -> Bool = { $0 == bunInApp }
    let b = BrainLaunch.bundledBrain(bundleURL: app, exists: exists, isExecutable: exec)
    #expect(b == BrainLocation(bun: URL(fileURLWithPath: bunInApp),
                               root: URL(fileURLWithPath: "/Applications/Offload.app/Contents/Resources/offload"),
                               bundled: true))
    // Half a bundle is no bundle.
    #expect(BrainLaunch.bundledBrain(bundleURL: app, exists: { _ in false }, isExecutable: exec) == nil)
    #expect(BrainLaunch.bundledBrain(bundleURL: app, exists: exists, isExecutable: { _ in false }) == nil)
  }

  @Test("BUNDLED: the bundled brain wins over OFFLOAD_REPO and over a repo above the bundle")
  func bundledFirst() {
    let repoApp = URL(fileURLWithPath: "/r/app/.build/Offload.app")
    let exists: (String) -> Bool = {
      ["/r/brain/src/cli.ts", "/other/brain/src/cli.ts", "/r/app/.build/Offload.app/Contents/Resources/offload/brain/src/cli.ts"].contains($0)
    }
    let exec: (String) -> Bool = { ["/r/app/.build/Offload.app/Contents/Helpers/bun", "/u/.bun/bin/bun"].contains($0) }
    let l = BrainLaunch.locate(bundleURL: repoApp, environment: ["OFFLOAD_REPO": "/other"], userHome: "/u",
                               exists: exists, isExecutable: exec)
    #expect(l?.bundled == true)
    #expect(l?.bun.path == "/r/app/.build/Offload.app/Contents/Helpers/bun")
    #expect(l?.root.path == "/r/app/.build/Offload.app/Contents/Resources/offload")
  }

  @Test("FALLBACK: no bundled brain -> the repo and an installed bun (dev only)")
  func fallback() {
    let repoApp = URL(fileURLWithPath: "/r/app/.build/Offload.app")
    let exists: (String) -> Bool = { $0 == "/r/brain/src/cli.ts" || $0 == "/other/brain/src/cli.ts" }
    let exec: (String) -> Bool = { $0 == "/u/.bun/bin/bun" }
    let up = BrainLaunch.locate(bundleURL: repoApp, environment: [:], userHome: "/u", exists: exists, isExecutable: exec)
    #expect(up?.bun.path == "/u/.bun/bin/bun")
    #expect(up?.root.path == "/r")
    #expect(up?.bundled == false)
    let env = BrainLaunch.locate(bundleURL: repoApp, environment: ["OFFLOAD_REPO": "/other"], userHome: "/u",
                                 exists: exists, isExecutable: exec)
    #expect(env?.root.path == "/other")
    #expect(env?.bundled == false)
    // A repo without bun is not a brain.
    #expect(BrainLaunch.locate(bundleURL: repoApp, environment: [:], userHome: "/u", exists: exists, isExecutable: { _ in false }) == nil)
  }

  @Test("FALLBACK: OFFLOAD_BRAIN_SOURCE=repo forces the repo brain (dev), bundled is ignored then")
  func forceRepo() {
    let repoApp = URL(fileURLWithPath: "/r/app/.build/Offload.app")
    let exists: (String) -> Bool = { $0 == "/r/brain/src/cli.ts" || $0 == "/r/app/.build/Offload.app/Contents/Resources/offload/brain/src/cli.ts" }
    let exec: (String) -> Bool = { $0 == "/r/app/.build/Offload.app/Contents/Helpers/bun" || $0 == "/u/.bun/bin/bun" }
    let l = BrainLaunch.locate(bundleURL: repoApp, environment: ["OFFLOAD_BRAIN_SOURCE": "repo"], userHome: "/u",
                               exists: exists, isExecutable: exec)
    #expect(l?.bun.path == "/u/.bun/bin/bun")
    #expect(l?.root.path == "/r")
    #expect(l?.bundled == false)
  }

  @Test("STANDALONE: an installed app with no repo and no bun anywhere still finds its brain")
  func standalone() {
    let exists: (String) -> Bool = { $0 == cliInApp }
    let exec: (String) -> Bool = { $0 == bunInApp }
    let l = BrainLaunch.locate(bundleURL: app, environment: ["PATH": "/usr/bin:/bin"], userHome: "/tmp/h",
                               exists: exists, isExecutable: exec)
    #expect(l?.bundled == true)
    #expect(BrainLaunch.locate(bundleURL: app, environment: [:], userHome: "/tmp/h", exists: { _ in false }, isExecutable: { _ in false }) == nil)
  }

  @Test("SPEC: the launch spec runs the bundled bun on the bundled cli.ts, cwd and PATH inside the bundle")
  func specFromBundle() {
    let loc = BrainLocation(bun: URL(fileURLWithPath: bunInApp),
                            root: URL(fileURLWithPath: "/Applications/Offload.app/Contents/Resources/offload"), bundled: true)
    let s = BrainLaunch.spec(location: loc, home: URL(fileURLWithPath: "/h"), token: "T",
                             baseEnvironment: ["PATH": "/usr/bin:/bin"], userHome: "/u", model: "stub")
    #expect(s.executable.path == bunInApp)
    #expect(s.arguments == ["run", cliInApp, "serve", "--home", "/h", "--port", "0", "--model", "stub"])
    #expect(s.workingDirectory.path == "/Applications/Offload.app/Contents/Resources/offload")
    #expect(s.environment["PATH"]?.hasPrefix("/Applications/Offload.app/Contents/Helpers:") == true)
    #expect(s.environment["OFFLOAD_TOKEN"] == "T")
  }

  @Test("CHECK: --brain-check output names the source, so verify.sh can prove the bundled brain answered")
  func checkLine() {
    let loc = BrainLocation(bun: URL(fileURLWithPath: bunInApp),
                            root: URL(fileURLWithPath: "/Applications/Offload.app/Contents/Resources/offload"), bundled: true)
    #expect(BrainCheck.sourceLine(loc) == "brain source: bundled \(bunInApp) /Applications/Offload.app/Contents/Resources/offload")
    let dev = BrainLocation(bun: URL(fileURLWithPath: "/u/.bun/bin/bun"), root: URL(fileURLWithPath: "/r"), bundled: false)
    #expect(BrainCheck.sourceLine(dev) == "brain source: repo /u/.bun/bin/bun /r")
    #expect(BrainCheck.sourceLine(nil) == "brain source: none")
  }

  @Test("BUNDLED: the demo week never writes into the app bundle; a repo brain keeps scratch/demo (dev)")
  func demoHome() {
    let support = URL(fileURLWithPath: "/u/Library/Application Support")
    let bundled = BrainLocation(bun: URL(fileURLWithPath: bunInApp),
                                root: URL(fileURLWithPath: "/Applications/Offload.app/Contents/Resources/offload"), bundled: true)
    #expect(DemoWeek.home(location: bundled, appSupport: support).path == "/u/Library/Application Support/Offload Demo")
    let dev = BrainLocation(bun: URL(fileURLWithPath: "/u/.bun/bin/bun"), root: URL(fileURLWithPath: "/r"), bundled: false)
    #expect(DemoWeek.home(location: dev, appSupport: support).path == "/r/scratch/demo")
    #expect(DemoWeek.home(location: nil, appSupport: support).path == "/u/Library/Application Support/Offload Demo")
  }
}
