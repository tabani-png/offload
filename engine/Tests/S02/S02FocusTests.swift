import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02FocusTests {
    @Test func firstPollWritesAFocusEventWithAppTitleUrlAndHost() throws {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        let focus = try #require(rig.sink.of(.focus).first)
        #expect(focus.app == "com.google.Chrome")
        #expect(focus.appName == "Google Chrome")
        #expect(focus.title == "Inbox")
        #expect(focus.url == "https://mail.google.com/mail/u/0/")
        #expect(focus.host == "mail.google.com")
    }

    @Test func appChangeWritesANewFocusEvent() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.mail", appName: "Mail", windowTitle: "Inbox")
        rig.run(seconds: 2)
        #expect(rig.sink.of(.focus).map(\.app) == ["com.google.Chrome", "com.apple.mail"])
        #expect(rig.sink.of(.focus).last?.url == nil)
    }

    @Test func titleChangeInTheSameAppWritesAFocusEvent() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.workspace.current?.windowTitle = "Draft to Jane"
        rig.run(seconds: 2)
        #expect(rig.sink.of(.focus).map(\.title) == ["Inbox", "Draft to Jane"])
    }

    @Test func urlChangeWritesAFocusEventButAQueryOnlyChangeDoesNot() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.workspace.current?.url = "https://mail.google.com/mail/u/0/?tab=other"
        rig.run(seconds: 2)
        #expect(rig.sink.of(.focus).count == 1)
        rig.workspace.current?.url = "https://docs.google.com/document/d/abc/edit?usp=sharing"
        rig.run(seconds: 2)
        #expect(rig.sink.of(.focus).count == 2)
        #expect(rig.sink.of(.focus).last?.url == "https://docs.google.com/document/d/abc/edit")
        #expect(rig.sink.of(.focus).last?.host == "docs.google.com")
    }

    @Test func noChangeWritesNothing() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.run(seconds: 30)
        #expect(rig.sink.of(.focus).count == 1)
    }

    @Test func focusIsPolledEveryTwoSeconds() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        let calls = rig.workspace.calls
        rig.run(seconds: 10)
        #expect(rig.workspace.calls - calls == 5)
    }

    @Test func titleIsMaskedBeforeWrite() {
        let rig = Rig(ocr: false)
        rig.workspace.current = FocusSnapshot(bundleID: "com.apple.TextEdit", appName: "TextEdit",
                                              windowTitle: "card 4111 1111 1111 1111 notes")
        rig.startAndTick()
        let title = rig.sink.of(.focus).first?.title ?? ""
        #expect(!title.contains("4111"))
        #expect(title.contains("[CARD NO.]"))
    }
}

@Suite struct S02URLTests {
    @Test func scrubRemovesQueryFragmentAndUserInfo() {
        #expect(URLScrubber.scrub("https://bob:pw@Example.COM/a/b?token=secret#frag") == "https://example.com/a/b")
    }

    @Test func hostIsLowercasedWithoutTrailingDot() {
        #expect(URLScrubber.host(of: "https://News.Ycombinator.com./item") == "news.ycombinator.com")
    }

    @Test func unparseableUrlIsDroppedNotGuessed() throws {
        let rig = Rig(ocr: false)
        rig.workspace.current?.url = "not a url"
        rig.startAndTick()
        let focus = try #require(rig.sink.of(.focus).first)
        #expect(focus.url == nil)
        #expect(focus.host == nil)
    }
}
