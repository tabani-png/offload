import Foundation
import Testing

// S31 contract extension (operator decision, after the first contract): the observer starts at login only after the
// person's Yes. Asked once on the installed app's first run; Settings installs or removes it.

private final class Calls: @unchecked Sendable {
  var list: [[String]] = []
}

private func agent(_ env: [String: String], calls: Calls, status: Int32 = 0) -> ObserverAgent {
  var a = ObserverAgent(binary: URL(fileURLWithPath: "/Applications/Offload.app/Contents/MacOS/offload-observer"),
                        home: URL(fileURLWithPath: "/h"), environment: env, uid: 501)
  a.run = { exe, args, _ in calls.list.append([exe.path] + args); return (status, "") }
  return a
}

struct S31ConsentTests {
  @Test("CONSENT: asked only once, only for the installed app with its observer, never under mock or the demo week")
  func shouldAsk() {
    let obs = URL(fileURLWithPath: "/Applications/Offload.app/Contents/MacOS/offload-observer")
    #expect(ObserverAgentSetting.shouldAsk(answer: nil, bundled: true, observer: obs, mock: false, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: .yes, bundled: true, observer: obs, mock: false, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: .notNow, bundled: true, observer: obs, mock: false, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: nil, bundled: false, observer: obs, mock: false, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: nil, bundled: true, observer: nil, mock: false, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: nil, bundled: true, observer: obs, mock: true, demo: false))
    #expect(!ObserverAgentSetting.shouldAsk(answer: nil, bundled: true, observer: obs, mock: false, demo: true))
  }

  @Test("CONSENT: the answer is remembered (Not now is an answer too)")
  func remembered() throws {
    let suite = "s31-consent-\(UUID().uuidString)"
    let d = try #require(UserDefaults(suiteName: suite))
    defer { d.removePersistentDomain(forName: suite) }
    #expect(ObserverAgentSetting.answer(d) == nil)
    ObserverAgentSetting.save(.notNow, d)
    #expect(ObserverAgentSetting.answer(d) == .notNow)
    ObserverAgentSetting.save(.yes, d)
    #expect(ObserverAgentSetting.answer(d) == .yes)
  }
}

struct S31AgentTests {
  @Test("AGENTCMD: Yes writes the plist with the bundled observer, then loads it in the GUI session")
  func installLoads() throws {
    let c = Calls()
    try agent(["HOME": "/Users/p"], calls: c).install()
    #expect(c.list == [
      ["/Applications/Offload.app/Contents/MacOS/offload-observer", "install-agent", "--home", "/h"],
      ["/bin/launchctl", "bootout", "gui/501/ai.offload.observer"],
      ["/bin/launchctl", "bootstrap", "gui/501", FileManager.default.homeDirectoryForCurrentUser.path + "/Library/LaunchAgents/ai.offload.observer.plist"],
    ])
  }

  @Test("AGENTCMD: off unloads and deletes; a test agents dir never touches launchd")
  func removeAndTestDir() throws {
    let c = Calls()
    try agent([:], calls: c).remove()
    #expect(c.list == [["/bin/launchctl", "bootout", "gui/501/ai.offload.observer"],
                       ["/Applications/Offload.app/Contents/MacOS/offload-observer", "uninstall-agent", "--home", "/h"]])
    let t = Calls()
    let a = agent(["OFFLOAD_LAUNCH_AGENTS_DIR": "/tmp/agents"], calls: t)
    try a.install()
    try a.remove()
    #expect(t.list.allSatisfy { $0[0] != "/bin/launchctl" })
    #expect(a.plistURL.path == "/tmp/agents/ai.offload.observer.plist")
  }

  @Test("AGENTCMD: a failed write is an error and nothing is loaded")
  func failedWrite() {
    let c = Calls()
    #expect(throws: ObserverAgentError.self) { try agent([:], calls: c, status: 1).install() }
    #expect(c.list.count == 1)
  }
}
