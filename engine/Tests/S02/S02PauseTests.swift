import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02PauseTests {
    @Test func pauseWritesAPauseEventAndNothingElseWhilePaused() {
        let rig = Rig()
        rig.startAndTick()
        let before = rig.sink.events.count
        rig.pause.isPaused = true
        rig.run(seconds: 1)
        #expect(rig.sink.events.count == before + 1)
        #expect(rig.sink.events.last?.kind == .pause)
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Secret")
        rig.screen.text = "private"
        rig.idle.seconds = 999
        rig.input.pending = InputCounts(keys: 50, clicks: 5)
        rig.run(seconds: 300)
        #expect(rig.sink.events.count == before + 1)
    }

    @Test func resumeWritesAResumeEventAndRecordsFocusAgain() {
        let rig = Rig()
        rig.startAndTick()
        rig.pause.isPaused = true
        rig.run(seconds: 5)
        rig.input.pending = InputCounts(keys: 50, clicks: 5)  // typed while paused: thrown away
        rig.run(seconds: 1)
        rig.pause.isPaused = false
        rig.run(seconds: 1)
        #expect(Array(rig.sink.kinds().suffix(3)) == [.resume, .focus, .ocr])
        rig.run(seconds: 60)
        #expect(rig.sink.of(.input).isEmpty)
    }

    @Test func pauseAndResumeCommandsFlipTheControlFileTheObserverReads() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let control = FilePauseControl(layout: layout)
        var out: [String] = []
        let pause = try ObserverCLI.parse(["pause", "--home", home.path])
        #expect(ObserverCLI.runOffline(pause, environment: [:], now: Date(), out: { out.append($0) }, err: { _ in }) == 0)
        #expect(control.isPaused)
        let resume = try ObserverCLI.parse(["resume", "--home", home.path])
        #expect(ObserverCLI.runOffline(resume, environment: [:], now: Date(), out: { out.append($0) }, err: { _ in }) == 0)
        #expect(!control.isPaused)
        #expect(out == ["paused", "resumed"])
    }

    @Test func aFailingWriteIsCountedAndTheObserverKeepsGoing() {
        let rig = Rig(ocr: false)
        rig.sink.failNext = true
        rig.startAndTick()
        #expect(rig.observer.counters.writeErrors == 1)
        rig.workspace.current?.windowTitle = "Next"
        rig.run(seconds: 2)
        #expect(rig.sink.of(.focus).count == 1)
    }
}
