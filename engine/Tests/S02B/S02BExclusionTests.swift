import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02BExclusionTests {
    func snap(_ bundle: String = "com.google.Chrome", title: String = "Inbox", url: String? = nil) -> FocusSnapshot {
        FocusSnapshot(bundleID: bundle, appName: "App", windowTitle: title, url: url)
    }

    @Test func userEntriesAreMergedWithTheBuiltIns() {
        let user = UserExclusions(bundleIds: ["com.slack.Slack"], hosts: ["Payroll.Example.com"],
                                  titleContains: ["Salary Review"])
        let policy = ExclusionPolicy.standard.merging(user)
        #expect(policy.evaluate(snap("com.slack.Slack"))?.reason == .denyApp)
        #expect(policy.evaluate(snap("com.1password.1password"))?.reason == .denyApp)  // built-in kept
        #expect(policy.evaluate(snap(url: "https://hr.payroll.example.com/x"))?.reason == .denyURL)
        #expect(policy.evaluate(snap(url: "https://secure.chase.com/"))?.reason == .denyURL)
        #expect(policy.evaluate(snap(title: "Q3 salary review.xlsx"))?.reason == .denyTitle)
        #expect(policy.evaluate(snap(title: "Weekly notes")) == nil)
    }

    @Test func missingFileMeansNoUserEntries() throws {
        let file = ExclusionFile(layout: StoreLayout(home: tempHome()))
        #expect(try file.load() == UserExclusions())
    }

    @Test func fileFormatIsTheDocumentedJson() throws {
        let layout = StoreLayout(home: tempHome())
        try layout.ensureDirectories()
        try Data(#"{"bundleIds":["a.b"],"hosts":["x.com"],"titleContains":["secret"]}"#.utf8)
            .write(to: layout.exclusionsFile)
        #expect(try ExclusionFile(layout: layout).load()
            == UserExclusions(bundleIds: ["a.b"], hosts: ["x.com"], titleContains: ["secret"]))
        try Data(#"{"hosts":["only.com"]}"#.utf8).write(to: layout.exclusionsFile)  // missing keys = empty
        #expect(try ExclusionFile(layout: layout).load() == UserExclusions(hosts: ["only.com"]))
    }

    @Test func addIsDeduplicatedRemoveIsCaseInsensitiveAndHostsAreNormalized() throws {
        let layout = StoreLayout(home: tempHome())
        let file = ExclusionFile(layout: layout)
        #expect(try file.add(.app, "com.Slack.Slack"))
        #expect(try !file.add(.app, "com.slack.slack"))
        #expect(try file.add(.host, "https://Payroll.Example.com/login?x=1"))
        #expect(try file.add(.title, "Salary"))
        #expect(try file.load() == UserExclusions(bundleIds: ["com.Slack.Slack"], hosts: ["payroll.example.com"],
                                                  titleContains: ["Salary"]))
        #expect(try file.remove(.app, "COM.SLACK.SLACK"))
        #expect(try !file.remove(.app, "com.slack.Slack"))
        #expect(try file.load().bundleIds.isEmpty)
        let mode = try FileManager.default.attributesOfItem(atPath: layout.exclusionsFile.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }

    @Test func blankValuesAreRejected() throws {
        let file = ExclusionFile(layout: StoreLayout(home: tempHome()))
        #expect(throws: ExclusionFileError.self) { try file.add(.title, "   ") }
        #expect(throws: ExclusionFileError.self) { try file.add(.host, "https://") }
    }

    @Test func parsesTheExcludeCommands() throws {
        #expect(try ObserverCLI.parse(["exclude", "list"]).command == .exclude(.list))
        #expect(try ObserverCLI.parse(["exclude", "add", "--app", "com.x"]).command == .exclude(.add(.app, "com.x")))
        #expect(try ObserverCLI.parse(["exclude", "remove", "--host", "x.com", "--home", "/tmp/h"])
            == ParsedArguments(command: .exclude(.remove(.host, "x.com")), home: "/tmp/h"))
        #expect(try ObserverCLI.parse(["exclude", "add", "--title=Salary"]).command == .exclude(.add(.title, "Salary")))
        #expect(throws: ArgumentError.self) { try ObserverCLI.parse(["exclude", "add"]) }
        #expect(throws: ArgumentError.self) { try ObserverCLI.parse(["exclude", "add", "--app"]) }
        #expect(throws: ArgumentError.self) { try ObserverCLI.parse(["exclude", "drop", "--app", "x"]) }
        #expect(throws: ArgumentError.self) { try ObserverCLI.parse(["exclude", "list", "--app", "x"]) }
    }

    @Test func excludeCommandsEditTheFileAndListPrintsIt() throws {
        let home = tempHome()
        func run(_ args: [String]) throws -> (Int32, [String]) {
            var out: [String] = []
            let code = ObserverCLI.runOffline(try ObserverCLI.parse(args + ["--home", home.path]), environment: [:],
                                              now: Date(), out: { out.append($0) }, err: { _ in })
            return (code, out)
        }
        #expect(try run(["exclude", "add", "--app", "com.slack.Slack"]).0 == 0)
        #expect(try run(["exclude", "add", "--title", "Salary"]).0 == 0)
        let (code, out) = try run(["exclude", "list"])
        #expect(code == 0)
        let listed = try JSONDecoder().decode(UserExclusions.self, from: Data(out.joined(separator: "\n").utf8))
        #expect(listed == UserExclusions(bundleIds: ["com.slack.Slack"], titleContains: ["Salary"]))
        #expect(try run(["exclude", "remove", "--app", "com.slack.Slack"]).0 == 0)
        #expect(try ExclusionFile(layout: StoreLayout(home: home)).load().bundleIds.isEmpty)
    }

    @Test func runningObserverPicksUpAnEditWithinFiveSeconds() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let clock = ManualClock(Date(timeIntervalSince1970: 1_792_490_400))
        let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.slack.Slack", appName: "Slack",
                                                    windowTitle: "general - Acme"))
        let screen = FakeScreenText()
        let sink = MemorySink()
        let observer = Observer(clock: clock, workspace: workspace, idle: FakeIdle(), input: FakeInput(),
                                screenText: screen, pauseState: FakePause(), sink: sink, retention: nil,
                                exclusions: ExclusionReloader(file: ExclusionFile(layout: layout)))
        observer.start()
        observer.tick()
        #expect(sink.of(.focus).last?.title == "general - Acme")
        #expect(screen.calls.count == 1)

        try ExclusionFile(layout: layout).add(.app, "com.slack.Slack")
        for _ in 0..<5 {
            clock.advance(by: 1)
            observer.tick()
        }
        #expect(sink.of(.focus).last?.title == "Slack")  // now excluded: title is the app name
        clock.advance(by: 60)
        observer.tick()
        #expect(screen.calls.count == 1)  // and no more OCR

        try ExclusionFile(layout: layout).remove(.app, "com.slack.Slack")
        for _ in 0..<5 {
            clock.advance(by: 1)
            observer.tick()
        }
        #expect(sink.of(.focus).last?.title == "general - Acme")
    }

    @Test func aBrokenFileKeepsTheLastGoodPolicy() throws {
        let layout = StoreLayout(home: tempHome())
        let file = ExclusionFile(layout: layout)
        try file.add(.app, "com.slack.Slack")
        let reloader = ExclusionReloader(file: file)
        let t0 = Date(timeIntervalSince1970: 1_792_490_400)
        #expect(reloader.policy(now: t0).evaluate(snap("com.slack.Slack")) != nil)
        try Data("{not json".utf8).write(to: layout.exclusionsFile)
        #expect(reloader.policy(now: t0.addingTimeInterval(5)).evaluate(snap("com.slack.Slack")) != nil)
        #expect(reloader.policy(now: t0.addingTimeInterval(10)).evaluate(snap("com.1password.1password")) != nil)
    }
}
