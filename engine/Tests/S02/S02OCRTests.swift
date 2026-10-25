import CoreGraphics
import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02OCRTests {
    @Test func ocrRunsOnFocusChange() {
        let rig = Rig()
        rig.startAndTick()
        #expect(rig.screen.calls.count == 1)
        rig.screen.text = "new window text"
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Inbox")
        rig.run(seconds: 2)
        #expect(rig.screen.calls == ["com.google.Chrome", "com.apple.mail"])
        #expect(rig.sink.of(.ocr).count == 2)
    }

    @Test func ocrRunsAtMostEvery30SecondsWhileFocusStays() {
        let rig = Rig()
        rig.startAndTick()
        rig.run(seconds: 29)
        #expect(rig.screen.calls.count == 1)
        rig.run(seconds: 1)
        #expect(rig.screen.calls.count == 2)
        rig.run(seconds: 60)
        #expect(rig.screen.calls.count == 4)
    }

    @Test func unchangedTextIsNotWrittenTwice() throws {
        let rig = Rig()
        rig.startAndTick()
        rig.run(seconds: 90)
        #expect(rig.sink.of(.ocr).count == 1)
        #expect(rig.observer.counters.ocrSkippedUnchanged == 3)
        rig.screen.text = "something else"
        rig.run(seconds: 30)
        let ocr = rig.sink.of(.ocr)
        #expect(ocr.count == 2)
        #expect(ocr[0].textHash != ocr[1].textHash)
        #expect(ocr[1].textHash == Observer.textHash("something else"))
    }

    @Test func ocrTextIsMaskedBeforeWrite() throws {
        let rig = Rig()
        rig.screen.text = "SSN 123-45-6789 and card 4111 1111 1111 1111 and key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"
        rig.startAndTick()
        let text = try #require(rig.sink.of(.ocr).first?.text)
        #expect(!text.contains("123-45-6789"))
        #expect(!text.contains("4111"))
        #expect(text.contains("[SSN]"))
        #expect(text.contains("[CARD NO.]"))
    }

    @Test(arguments: ["com.1password.1password", "com.apple.keychainaccess", "com.moneymoney-app.retail"])
    func excludedAppsAreNeverReadAndTheirTitleIsTheAppName(bundle: String) throws {
        let rig = Rig()
        rig.workspace.current = FocusSnapshot(bundleID: bundle, appName: "Vault", windowTitle: "Bank login jane@x.com")
        rig.startAndTick()
        rig.run(seconds: 120)
        #expect(rig.screen.calls.isEmpty)
        #expect(rig.sink.of(.ocr).isEmpty)
        let focus = try #require(rig.sink.of(.focus).first)
        #expect(focus.title == "Vault")
    }

    @Test func bankingDomainKeepsHostOnlyAndIsNeverRead() throws {
        let rig = Rig()
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.Safari", appName: "Safari",
                                              windowTitle: "Accounts - Balance $12,000",
                                              url: "https://secure.chase.com/web/auth/dashboard?x=1")
        rig.startAndTick()
        rig.run(seconds: 60)
        #expect(rig.screen.calls.isEmpty)
        let focus = try #require(rig.sink.of(.focus).first)
        #expect(focus.title == "Safari")
        #expect(focus.url == nil)
        #expect(focus.host == "secure.chase.com")
    }

    @Test func privateWindowsAreNotRead() throws {
        let rig = Rig()
        rig.workspace.current = FocusSnapshot(bundleID: "com.google.Chrome", appName: "Google Chrome",
                                              windowTitle: "New Tab - Incognito", url: "https://example.com/x")
        rig.startAndTick()
        #expect(rig.screen.calls.isEmpty)
        let focus = try #require(rig.sink.of(.focus).first)
        #expect(focus.title == "Google Chrome")
        #expect(focus.url == nil && focus.host == nil)
    }

    @Test func secureInputSkipsOcr() {
        let rig = Rig()
        rig.workspace.current?.secureInputActive = true
        rig.startAndTick()
        #expect(rig.screen.calls.isEmpty)
        #expect(rig.observer.counters.ocrSkippedExcluded == 1)
    }

    @Test func ocrErrorsAreCountedAndRecordingContinues() {
        let rig = Rig()
        rig.screen.error = CaptureError.permissionDenied("screen recording")
        rig.startAndTick()
        rig.run(seconds: 30)
        #expect(rig.observer.counters.ocrErrors == 2)
        #expect(rig.sink.of(.focus).count == 1)
        #expect(rig.sink.of(.ocr).isEmpty)
    }

    @Test func noOcrWhileIdle() {
        let rig = Rig()
        rig.startAndTick()
        rig.idle.seconds = 500
        rig.screen.text = "changed while away"
        rig.run(seconds: 90)
        #expect(rig.screen.calls.count == 1)
    }

    @Test func windowToReadIsTheFrontAppsTopNormalWindowOnly() {
        let policy = ExclusionPolicy.standard
        let windows = [
            CaptureWindow(windowID: 1, bundleID: "com.apple.dock", frame: CGRect(x: 0, y: 0, width: 10, height: 10), layer: 20),
            CaptureWindow(windowID: 2, bundleID: "com.1password.1password", frame: CGRect(x: 0, y: 0, width: 10, height: 10)),
            CaptureWindow(windowID: 3, bundleID: "com.apple.mail", frame: CGRect(x: 0, y: 0, width: 0, height: 10)),
            CaptureWindow(windowID: 4, bundleID: "com.apple.mail", frame: CGRect(x: 0, y: 0, width: 10, height: 10)),
        ]
        #expect(policy.windowToRead(windows, frontmostBundleID: "com.apple.mail")?.windowID == 4)
        #expect(policy.windowToRead(windows, frontmostBundleID: "com.1password.1password") == nil)
        #expect(policy.windowToRead(windows, frontmostBundleID: "") == nil)
    }
}
