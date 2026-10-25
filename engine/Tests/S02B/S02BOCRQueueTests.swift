import Foundation
import Testing
@testable import OffloadCore

/// A recognizer that blocks until released, like the first Vision load.
final class SlowScreenText: ScreenTextSource, @unchecked Sendable {
    private let lock = NSLock()
    private let gate = DispatchSemaphore(value: 0)
    private var _calls: [String] = []
    var text = "slow text"
    var calls: [String] { lock.withLock { _calls } }

    func visibleText(of snapshot: FocusSnapshot) throws -> String? {
        lock.withLock { _calls.append(snapshot.bundleID) }
        _ = gate.wait(timeout: .now() + 10)
        return text + " " + snapshot.bundleID
    }

    func release(_ n: Int = 1) { for _ in 0..<n { gate.signal() } }
}

@Suite struct S02BOCRQueueTests {
    let start = Date(timeIntervalSince1970: 1_792_490_400)

    @Test func aSlowRecognizerDoesNotDelayFocusOrPause() throws {
        let clock = ManualClock(start)
        let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Inbox"))
        let pause = FakePause()
        let sink = MemorySink()
        let slow = SlowScreenText()
        let worker = QueuedOCRExecutor(source: slow)
        let observer = Observer(clock: clock, workspace: workspace, idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: pause, sink: sink, retention: nil, ocr: worker)
        observer.start()
        let began = Date()
        observer.tick()  // submits OCR; the recognizer now blocks
        workspace.current = FocusSnapshot(bundleID: "com.apple.Notes", appName: "Notes", windowTitle: "Ideas")
        clock.advance(by: 2)
        observer.tick()
        pause.isPaused = true
        clock.advance(by: 1)
        observer.tick()
        #expect(Date().timeIntervalSince(began) < 0.5)
        #expect(sink.kinds() == [.focus, .focus, .pause])
        #expect(sink.of(.ocr).isEmpty)

        pause.isPaused = false
        slow.release(5)
        #expect(worker.waitUntilIdle(timeout: 5))
        clock.advance(by: 1)
        observer.tick()  // resume: results from before the pause are discarded
        #expect(sink.kinds().prefix(4) == [.focus, .focus, .pause, .resume])
        #expect(observer.counters.ocrDiscarded >= 1)
        #expect(worker.waitUntilIdle(timeout: 5))
        clock.advance(by: 1)
        observer.tick()
        let ocr = try #require(sink.of(.ocr).last)
        #expect(ocr.app == "com.apple.Notes")
        #expect(ocr.text == "slow text com.apple.Notes")
    }

    @Test func theQueueIsBoundedAndDropsTheOldestJob() {
        let slow = SlowScreenText()
        let worker = QueuedOCRExecutor(source: slow, capacity: 2)
        func job(_ id: String) -> OCRJob {
            OCRJob(snapshot: FocusSnapshot(bundleID: id, appName: id, windowTitle: id), generation: 0)
        }
        worker.submit(job("a"))  // starts running, blocks
        #expect(waitFor { slow.calls == ["a"] })
        worker.submit(job("b"))
        worker.submit(job("c"))
        worker.submit(job("d"))  // pending was [b, c]: b is dropped
        #expect(worker.dropped == 1)
        slow.release(10)
        #expect(worker.waitUntilIdle(timeout: 5))
        #expect(slow.calls == ["a", "c", "d"])
        #expect(worker.drain().map(\.job.snapshot.bundleID) == ["a", "c", "d"])
        #expect(worker.drain().isEmpty)
    }

    @Test func droppedJobsAreCountedOnTheObserver() {
        let clock = ManualClock(start)
        let workspace = FakeWorkspace(FocusSnapshot(bundleID: "a", appName: "A", windowTitle: "1"))
        let slow = SlowScreenText()
        let worker = QueuedOCRExecutor(source: slow, capacity: 1)
        let observer = Observer(clock: clock, workspace: workspace, idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: FakePause(), sink: MemorySink(), retention: nil,
                                ocr: worker)
        observer.start()
        observer.tick()
        for n in 2...5 {
            workspace.current = FocusSnapshot(bundleID: "a", appName: "A", windowTitle: "\(n)")
            clock.advance(by: 2)
            observer.tick()
        }
        #expect(observer.counters.ocrDropped >= 2)
        slow.release(10)
        #expect(worker.waitUntilIdle(timeout: 5))
    }

    @Test func resultsForAWindowExcludedMeanwhileAreDiscarded() throws {
        let layout = StoreLayout(home: tempHome())
        let clock = ManualClock(start)
        let workspace = FakeWorkspace(FocusSnapshot(bundleID: "com.slack.Slack", appName: "Slack", windowTitle: "g"))
        let slow = SlowScreenText()
        let worker = QueuedOCRExecutor(source: slow)
        let sink = MemorySink()
        let observer = Observer(clock: clock, workspace: workspace, idle: FakeIdle(), input: FakeInput(),
                                screenText: nil, pauseState: FakePause(), sink: sink, retention: nil,
                                exclusions: ExclusionReloader(file: ExclusionFile(layout: layout)), ocr: worker)
        observer.start()
        observer.tick()
        try ExclusionFile(layout: layout).add(.app, "com.slack.Slack")
        clock.advance(by: 2)
        observer.tick()  // the reload sees the edit while the OCR job is still running
        #expect(sink.of(.focus).last?.title == "Slack")
        slow.release(5)
        #expect(worker.waitUntilIdle(timeout: 5))
        for _ in 0..<5 {
            clock.advance(by: 1)
            observer.tick()
        }
        #expect(sink.of(.ocr).isEmpty)
        #expect(observer.counters.ocrDiscarded == 1)
    }
}

func waitFor(_ timeout: TimeInterval = 5, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.01)
    }
    return condition()
}
