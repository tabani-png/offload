import Foundation
@testable import OffloadCore

final class FakeWorkspace: WorkspaceSource {
    var current: FocusSnapshot?
    var calls = 0
    init(_ s: FocusSnapshot? = nil) { current = s }
    func frontmost() -> FocusSnapshot? {
        calls += 1
        return current
    }
}

final class FakeIdle: IdleSource {
    var seconds: TimeInterval = 0
    func secondsSinceLastInput() -> TimeInterval { seconds }
}

final class FakeInput: InputCountSource {
    var isAvailable: Bool
    var pending = InputCounts()
    var drains = 0
    init(available: Bool = true) { isAvailable = available }
    func drainCounts() -> InputCounts {
        drains += 1
        defer { pending = InputCounts() }
        return pending
    }
}

final class FakeScreenText: ScreenTextSource {
    var text: String? = "hello world"
    var error: Error?
    var calls: [String] = []
    func visibleText(of snapshot: FocusSnapshot) throws -> String? {
        calls.append(snapshot.bundleID)
        if let error { throw error }
        return text
    }
}

final class FakePause: PauseState {
    var isPaused = false
}

final class MemorySink: EventSink {
    var events: [Event] = []
    var failNext = false
    func append(_ event: Event) throws {
        if failNext {
            failNext = false
            throw StoreError.io("injected")
        }
        events.append(event)
    }
    func kinds() -> [EventKind] { events.map(\.kind) }
    func of(_ kind: EventKind) -> [Event] { events.filter { $0.kind == kind } }
}

/// A fresh observer with scripted sources. Start time 2026-10-20 10:00:00 UTC.
struct Rig {
    let clock = ManualClock(Date(timeIntervalSince1970: 1_792_490_400))
    let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.google.Chrome", appName: "Google Chrome",
                                                windowTitle: "Inbox", url: "https://mail.google.com/mail/u/0/?tab=rm#inbox"))
    let idle = FakeIdle()
    let input: FakeInput
    let screen = FakeScreenText()
    let pause = FakePause()
    let sink = MemorySink()
    let observer: Observer

    init(inputAvailable: Bool = true, ocr: Bool = true) {
        input = FakeInput(available: inputAvailable)
        observer = Observer(clock: clock, workspace: workspace, idle: idle, input: input,
                            screenText: ocr ? screen : nil, pauseState: pause, sink: sink, retention: nil)
    }

    /// Advances the clock one second at a time, ticking after each step.
    func run(seconds: Int) {
        for _ in 0..<seconds {
            clock.advance(by: 1)
            observer.tick()
        }
    }

    func startAndTick() {
        observer.start()
        observer.tick()
    }
}

func tempHome(_ name: String = #function) -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("offload-tests-\(UUID().uuidString.prefix(8))", isDirectory: true)
    try? FileManager.default.removeItem(at: dir)
    return dir
}

/// engine/ directory: OFFLOAD_ENGINE_DIR (set by build.sh) or derived from this file's path.
func engineDir() -> URL {
    if let env = ProcessInfo.processInfo.environment["OFFLOAD_ENGINE_DIR"], !env.isEmpty {
        return URL(fileURLWithPath: env)
    }
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
}
