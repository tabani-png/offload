import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02BLaunchAgentTests {
    let exe = "/opt/offload/bin/offload-observer"

    func plist(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    @Test func plistRunsTheObserverAtLoadAndRestartsOnlyAfterACrash() throws {
        let home = tempHome()
        let agents = tempHome()
        let url = try LaunchAgent.install(executable: exe, layout: StoreLayout(home: home), agentsDir: agents,
                                          environment: [:])
        #expect(url == agents.appendingPathComponent("ai.offload.observer.plist"))
        let p = try plist(at: url)
        #expect(p["Label"] as? String == "ai.offload.observer")
        #expect(p["ProgramArguments"] as? [String] == [exe, "run", "--home", home.path])
        #expect(p["RunAtLoad"] as? Bool == true)
        let keepAlive = try #require(p["KeepAlive"] as? [String: Any])
        #expect(keepAlive["SuccessfulExit"] as? Bool == false)
        #expect(p["StandardOutPath"] as? String == home.appendingPathComponent("logs/observer.out.log").path)
        #expect(p["StandardErrorPath"] as? String == home.appendingPathComponent("logs/observer.err.log").path)
        #expect(p["LimitLoadToSessionType"] as? String == "Aqua")
        #expect((p["ThrottleInterval"] as? Int ?? 0) >= 10)
        var isDir: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: home.appendingPathComponent("logs").path, isDirectory: &isDir))
        #expect(isDir.boolValue)
    }

    @Test func keyAndPlainModesArePassedThroughWhenSet() throws {
        let url = try LaunchAgent.install(executable: exe, layout: StoreLayout(home: tempHome()), agentsDir: tempHome(),
                                          environment: ["OFFLOAD_KEYS": "file", "PATH": "/usr/bin"])
        let env = try #require(try plist(at: url)["EnvironmentVariables"] as? [String: String])
        #expect(env == ["OFFLOAD_KEYS": "file"])
        let none = try LaunchAgent.install(executable: exe, layout: StoreLayout(home: tempHome()), agentsDir: tempHome(),
                                           environment: [:])
        #expect(try plist(at: none)["EnvironmentVariables"] == nil)
    }

    @Test func relativeExecutablePathsAreRefused() {
        #expect(throws: LaunchAgentError.self) {
            try LaunchAgent.install(executable: "offload-observer", layout: StoreLayout(home: tempHome()),
                                    agentsDir: tempHome(), environment: [:])
        }
    }

    @Test func uninstallRemovesThePlistAndIsIdempotent() throws {
        let agents = tempHome()
        let url = try LaunchAgent.install(executable: exe, layout: StoreLayout(home: tempHome()), agentsDir: agents,
                                          environment: [:])
        #expect(try LaunchAgent.uninstall(agentsDir: agents))
        #expect(!FileManager.default.fileExists(atPath: url.path))
        #expect(try !LaunchAgent.uninstall(agentsDir: agents))
    }

    @Test func cliInstallWritesIntoTheOverriddenAgentsDirOnly() throws {
        let home = tempHome()
        let agents = tempHome()
        var out: [String] = []
        let env = ["OFFLOAD_LAUNCH_AGENTS_DIR": agents.path]
        #expect(try ObserverCLI.parse(["install-agent", "--home", home.path]).command == .installAgent)
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(["install-agent", "--home", home.path]),
                                          environment: env, now: Date(), executable: exe,
                                          out: { out.append($0) }, err: { _ in })
        #expect(code == 0)
        let p = try plist(at: agents.appendingPathComponent("ai.offload.observer.plist"))
        #expect(p["ProgramArguments"] as? [String] == [exe, "run", "--home", home.path])
        #expect(out.joined().contains("launchctl bootstrap"))  // printed, never run
        #expect(ObserverCLI.runOffline(try ObserverCLI.parse(["uninstall-agent"]), environment: env, now: Date(),
                                       out: { _ in }, err: { _ in }) == 0)
        #expect(!FileManager.default.fileExists(atPath: agents.appendingPathComponent("ai.offload.observer.plist").path))
    }

    @Test func defaultAgentsDirIsTheUsersLaunchAgents() {
        #expect(LaunchAgent.agentsDir(environment: [:]).path
            == FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents").path)
    }
}
