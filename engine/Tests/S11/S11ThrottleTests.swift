import Foundation
import Testing
@testable import OffloadCore

@Suite struct S11ThrottleTests {
    let t0 = Date(timeIntervalSince1970: 1_792_490_400)

    @Test func minIntervalBetweenKeptFrames() {
        let t = KeyframeThrottle()
        let a = PerceptualHash(image: s11Pattern(1))
        let b = PerceptualHash(image: s11Pattern(2))
        #expect(t.decide(now: t0, hash: a) == .keep)
        t.record(now: t0, hash: a)
        #expect(t.decide(now: t0.addingTimeInterval(10), hash: b) == .throttled)
        #expect(!t.mightKeep(now: t0.addingTimeInterval(19)))
        #expect(t.decide(now: t0.addingTimeInterval(20), hash: b) == .keep)
    }

    @Test func maxFramesPerRollingHour() {
        var c = KeyframeConfig()
        c.minInterval = 0
        c.maxPerHour = 3
        c.dedupeDistance = 0
        let t = KeyframeThrottle(config: c)
        for i in 0..<3 {
            let h = PerceptualHash(image: s11Pattern(i))
            #expect(t.decide(now: t0.addingTimeInterval(Double(i)), hash: h) == .keep)
            t.record(now: t0.addingTimeInterval(Double(i)), hash: h)
        }
        #expect(t.decide(now: t0.addingTimeInterval(100), hash: PerceptualHash(image: s11Pattern(9))) == .throttled)
        #expect(t.decide(now: t0.addingTimeInterval(3601), hash: PerceptualHash(image: s11Pattern(9))) == .keep)
    }

    @Test func nearDuplicatesOfRecentFramesAreSkipped() {
        let t = KeyframeThrottle()
        let a = PerceptualHash(image: s11Pattern(1))
        t.record(now: t0, hash: a)
        #expect(t.decide(now: t0.addingTimeInterval(60), hash: a) == .duplicate)
        // A/B/A toggling: A is still in the recent memory after B.
        let b = PerceptualHash(image: s11Pattern(2))
        t.record(now: t0.addingTimeInterval(60), hash: b)
        #expect(t.decide(now: t0.addingTimeInterval(120), hash: a) == .duplicate)
        t.resetDuplicates()
        #expect(t.decide(now: t0.addingTimeInterval(180), hash: a) == .keep)
    }

    @Test func observerKeepsOneFrameForAnUnchangedScreen() {
        let rig = FrameRig()
        rig.startAndTick()
        rig.run(seconds: 150)
        #expect(rig.frames.stored.count == 1)
        #expect(rig.observer.counters.framesKept == 1)
        #expect(rig.observer.counters.framesSkippedDuplicate >= 3)
    }

    @Test func observerKeepsANewFrameWhenTheScreenChanges() {
        let rig = FrameRig()
        rig.startAndTick()
        rig.source.frame = ScreenFrame(image: s11Pattern(7), lines: [s11Line("Ticket 58213", x: 10, y: 10, width: 200)])
        rig.run(seconds: 30)
        #expect(rig.frames.stored.count == 2)
        #expect(rig.frames.stored[0].meta.phash != rig.frames.stored[1].meta.phash)
    }

    @Test func observerRespectsTheHourlyCap() {
        var c = KeyframeConfig()
        c.maxPerHour = 2
        let rig = FrameRig(keyframes: c)
        rig.startAndTick()
        for i in 2..<8 {
            rig.source.frame = ScreenFrame(image: s11Pattern(i * 31), lines: [])
            rig.run(seconds: 30)
        }
        #expect(rig.frames.stored.count == 2)
    }

    @Test func noPixelsAreRequestedWhileThrottled() {
        let rig = FrameRig()
        rig.startAndTick()
        #expect(rig.source.frameCalls == 1)
        // Focus changes 5 s later: OCR runs, but a frame cannot be kept for 20 s, so only text is asked for.
        rig.clock.advance(by: 5)
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Inbox")
        rig.observer.tick()
        #expect(rig.source.frameCalls == 1)
        #expect(rig.source.textCalls == 1)
    }
}
