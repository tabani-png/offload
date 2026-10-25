import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02IdleTests {
    @Test func idleStartIsWrittenAfter120SecondsWithoutInput() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.idle.seconds = 119
        rig.run(seconds: 1)
        #expect(rig.sink.of(.idleStart).isEmpty)
        rig.idle.seconds = 120
        rig.run(seconds: 1)
        #expect(rig.sink.of(.idleStart).count == 1)
    }

    @Test func idleStartIsWrittenOnceAndIdleEndOnReturn() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.idle.seconds = 300
        rig.run(seconds: 5)
        rig.idle.seconds = 1
        rig.run(seconds: 1)
        #expect(rig.sink.kinds().filter { $0 == .idleStart || $0 == .idleEnd } == [.idleStart, .idleEnd])
    }
}

@Suite struct S02InputTests {
    @Test func oneInputEventPerMinuteWithCounts() throws {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.input.pending = InputCounts(keys: 42, clicks: 7)
        rig.run(seconds: 59)
        #expect(rig.sink.of(.input).isEmpty)
        rig.run(seconds: 1)
        let input = try #require(rig.sink.of(.input).first)
        #expect(input.keys == 42)
        #expect(input.clicks == 7)
        rig.input.pending = InputCounts(keys: 3, clicks: 0)
        rig.run(seconds: 60)
        #expect(rig.sink.of(.input).map(\.keys) == [42, 3])
    }

    @Test func aMinuteWithoutInputWritesNoInputEvent() {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.run(seconds: 180)
        #expect(rig.sink.of(.input).isEmpty)
    }

    @Test func withoutInputMonitoringCountsAreOmittedNotFaked() {
        let rig = Rig(inputAvailable: false, ocr: false)
        rig.input.pending = InputCounts(keys: 99, clicks: 99)
        rig.startAndTick()
        rig.run(seconds: 300)
        #expect(rig.sink.of(.input).isEmpty)
        #expect(rig.input.drains == 0)
        #expect(rig.sink.events.allSatisfy { $0.keys == nil && $0.clicks == nil })
    }

    @Test func inputEventJsonHoldsOnlyCounts() throws {
        let rig = Rig(ocr: false)
        rig.startAndTick()
        rig.input.pending = InputCounts(keys: 5, clicks: 1)
        rig.run(seconds: 60)
        let event = try #require(rig.sink.of(.input).first)
        let object = try #require(try JSONSerialization.jsonObject(with: event.jsonLine()) as? [String: Any])
        #expect(Set(object.keys) == ["id", "ts", "kind", "keys", "clicks"])
    }
}
