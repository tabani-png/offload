import CoreGraphics
import Foundation
import Testing
@testable import OffloadCore

@Suite struct S11PrivacyTests {
    @Test(arguments: ["com.1password.1password", "com.apple.keychainaccess", "com.moneymoney-app.retail"])
    func excludedAppsNeverHaveTheirPixelsReadOrKept(bundle: String) {
        let rig = FrameRig()
        rig.workspace.current = FocusSnapshot(bundleID: bundle, appName: "Vault", windowTitle: "Login")
        rig.startAndTick()
        rig.run(seconds: 120)
        #expect(rig.source.frameCalls == 0)
        #expect(rig.source.textCalls == 0)
        #expect(rig.frames.stored.isEmpty)
    }

    @Test func deniedBankingDomainsAndPrivateWindowsAreNotKept() {
        for snap in [FocusSnapshot(bundleID: "com.google.Chrome", appName: "Chrome", windowTitle: "Accounts", url: "https://secure.chase.com/x"),
                     FocusSnapshot(bundleID: "com.google.Chrome", appName: "Chrome", windowTitle: "New Incognito Tab")] {
            let rig = FrameRig()
            rig.workspace.current = snap
            rig.startAndTick()
            rig.run(seconds: 60)
            #expect(rig.source.frameCalls == 0)
            #expect(rig.frames.stored.isEmpty)
        }
    }

    @Test func secureInputStopsKeyframes() {
        let rig = FrameRig()
        rig.workspace.current = FocusSnapshot(bundleID: "com.google.Chrome", appName: "Chrome", windowTitle: "Sign in",
                                              secureInputActive: true)
        rig.startAndTick()
        rig.run(seconds: 90)
        #expect(rig.source.frameCalls == 0)
        #expect(rig.frames.stored.isEmpty)
    }

    @Test func userExclusionsApplyBeforeAnythingIsKept() {
        let rig = FrameRig()
        rig.observer.start()
        // A title the user excluded: same path as exclusions.json titleContains.
        var policy = ExclusionPolicy.standard
        policy.deniedTitleSubstrings = ["payroll"]
        let rig2 = Observer(clock: rig.clock, workspace: FakeWorkspace(FocusSnapshot(bundleID: "com.google.Chrome",
                            appName: "Chrome", windowTitle: "October Payroll run")), idle: FakeIdle(), input: FakeInput(),
                            screenText: rig.source, pauseState: FakePause(), sink: MemorySink(), retention: nil,
                            policy: policy, frames: rig.frames)
        rig2.start()
        rig2.tick()
        rig.clock.advance(by: 60)
        rig2.tick()
        #expect(rig.source.frameCalls == 0)
        #expect(rig.frames.stored.isEmpty)
    }

    @Test func idleAndPausedTimeKeepNoFrames() {
        let rig = FrameRig()
        rig.idle.seconds = 500
        rig.startAndTick()
        rig.run(seconds: 60)
        #expect(rig.frames.stored.isEmpty)
        let rig2 = FrameRig()
        rig2.pause.isPaused = true
        rig2.startAndTick()
        rig2.run(seconds: 60)
        #expect(rig2.frames.stored.isEmpty)
    }

    @Test func framesOffMeansNoPixelsAreAskedFor() {
        let rig = FrameRig(framesOn: false)
        rig.startAndTick()
        rig.run(seconds: 90)
        #expect(rig.source.frameCalls == 0)
        #expect(rig.source.textCalls >= 3)
        #expect(rig.sink.of(.ocr).count == 1)
    }

    @Test func theKeptFrameIsMaskedAndItsMetadataIsScrubbed() throws {
        let frame = ScreenFrame(image: s11Image(), lines: [s11Line("Card 4111 1111 1111 1111", x: 10, y: 100, width: 400)])
        let rig = FrameRig(frame: frame)
        rig.startAndTick()
        let kept = try #require(rig.frames.stored.first)
        let img = DecodedImage(jpeg: kept.jpeg)
        #expect(img.brightness(200, 110) < 40)
        #expect(kept.meta.maskedRegions == 1)
        #expect(kept.meta.host == "app.ledgerly.test")
        #expect(kept.meta.app == "com.google.Chrome")
        #expect(FrameStore.isFrameID(kept.meta.frameId))
        let json = String(decoding: try kept.meta.jsonLine(), as: UTF8.self)
        #expect(!json.contains("x=1"))
        #expect(!json.contains("Bills"))   // no title in frame metadata
        // OCR text is still written once, masked.
        #expect(rig.sink.of(.ocr).first?.text?.contains("4111") == false)
    }

    @Test func aResultFromBeforeAPauseIsNotKept() {
        let rig = FrameRig()
        let queued = QueuedOCRExecutor(source: rig.source)
        let observer = Observer(clock: rig.clock, workspace: rig.workspace, idle: rig.idle, input: rig.input,
                                screenText: nil, pauseState: rig.pause, sink: rig.sink, retention: nil, ocr: queued,
                                frames: rig.frames)
        observer.start()
        observer.tick()
        _ = queued.waitUntilIdle(timeout: 5)
        rig.pause.isPaused = true
        rig.clock.advance(by: 1)
        observer.tick()
        #expect(rig.frames.stored.isEmpty)
    }
}
