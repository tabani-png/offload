import CryptoKit
import Foundation
import Testing
@testable import OffloadCore

@Suite struct S02StoreTests {
    let utc = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
    let ts: Int64 = 1_792_490_400_000  // 2026-10-20 10:00 UTC

    func sample(_ n: Int = 0) -> Event {
        Event(id: "01JTEST\(n)", ts: ts + Int64(n), kind: .focus, app: "com.apple.mail", appName: "Mail",
              title: "Re: term sheet", url: "https://example.com/a", host: "example.com")
    }

    @Test func encryptedRoundTrip() throws {
        let layout = StoreLayout(home: tempHome())
        let store = DayStore(layout: layout, plain: false, days: utc)
        let events = (0..<5).map(sample)
        for e in events { try store.append(e) }
        #expect(FileManager.default.fileExists(atPath: layout.encryptedDayFile("2026-10-20").path))
        #expect(!FileManager.default.fileExists(atPath: layout.plainDayFile("2026-10-20").path))
        let fresh = DayStore(layout: layout, plain: false, days: utc)
        #expect(try fresh.read(day: "2026-10-20") == events)
    }

    @Test func eachLineIsBase64NonceCiphertextTagWithNoPlaintext() throws {
        let layout = StoreLayout(home: tempHome())
        let store = DayStore(layout: layout, plain: false, days: utc)
        try store.append(sample())
        let raw = try String(contentsOf: layout.encryptedDayFile("2026-10-20"), encoding: .utf8)
        #expect(!raw.contains("term sheet") && !raw.contains("com.apple.mail"))
        let line = try #require(raw.split(separator: "\n").first)
        let sealed = try #require(Data(base64Encoded: String(line)))
        let json = try sample().jsonLine()
        #expect(sealed.count == 12 + json.count + 16)
        let key = SymmetricKey(data: try Data(contentsOf: layout.keyFile("2026-10-20")))
        #expect(try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key) == json)
    }

    @Test func dayKeyIs32RandomBytesWithMode0600() throws {
        let layout = StoreLayout(home: tempHome())
        try DayStore(layout: layout, plain: false, days: utc).append(sample())
        let path = layout.keyFile("2026-10-20").path
        #expect(try Data(contentsOf: URL(fileURLWithPath: path)).count == 32)
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
        #expect(mode?.intValue == 0o600)
    }

    @Test func plainModeWritesReadableJsonl() throws {
        let layout = StoreLayout(home: tempHome())
        #expect(DayStore.plainFromEnvironment(["OFFLOAD_PLAIN": "1"]))
        #expect(!DayStore.plainFromEnvironment([:]))
        let store = DayStore(layout: layout, plain: true, days: utc)
        try store.append(sample())
        let raw = try String(contentsOf: layout.plainDayFile("2026-10-20"), encoding: .utf8)
        #expect(raw.contains("\"title\":\"Re: term sheet\""))
        #expect(!FileManager.default.fileExists(atPath: layout.keyFile("2026-10-20").path))
        #expect(try store.read(day: "2026-10-20") == [sample()])
    }

    @Test func tamperedLineFailsWithItsLineNumber() throws {
        let layout = StoreLayout(home: tempHome())
        let store = DayStore(layout: layout, plain: false, days: utc)
        try store.append(sample(0))
        try store.append(sample(1))
        let url = layout.encryptedDayFile("2026-10-20")
        var lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n").map(String.init)
        var bytes = try #require(Data(base64Encoded: lines[1]))
        bytes[bytes.count - 1] ^= 0x01
        lines[1] = bytes.base64EncodedString()
        try (lines.joined(separator: "\n") + "\n").write(to: url, atomically: true, encoding: .utf8)
        #expect(throws: StoreError.decryptFailed(2)) { try DayStore(layout: layout, plain: false, days: utc).read(day: "2026-10-20") }
    }

    @Test func eventsLandInTheirLocalDayFile() throws {
        let tokyo = DayCalendar(timeZone: TimeZone(identifier: "Asia/Tokyo")!)
        let layout = StoreLayout(home: tempHome())
        // 2026-10-20 20:00 UTC is 2026-10-21 05:00 in Tokyo.
        var late = sample()
        late.ts = ts + 10 * 3_600_000
        try DayStore(layout: layout, plain: true, days: tokyo).append(late)
        #expect(FileManager.default.fileExists(atPath: layout.plainDayFile("2026-10-21").path))
    }

    @Test func ulidsAre26CharactersAndSortInWriteOrder() {
        let gen = ULIDGenerator()
        let ids = (0..<50).map { gen.next(millis: 1_792_490_400_000 + Int64($0 / 10)) }
        #expect(ids.allSatisfy { $0.count == 26 })
        #expect(ids == ids.sorted())
        #expect(Set(ids).count == ids.count)
    }
}

@Suite struct S02SchemaTests {
    func schema() throws -> [String: Any] {
        let url = engineDir().deletingLastPathComponent().appendingPathComponent("schemas/event.schema.json")
        return try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    @Test func everyWrittenFieldIsASchemaPropertyWithTheRightType() throws {
        let schema = try schema()
        let props = try #require(schema["properties"] as? [String: [String: Any]])
        let required = try #require(schema["required"] as? [String])
        let full = Event(id: "x", ts: 1, kind: .ocr, app: "a", appName: "b", title: "c", url: "d", host: "e",
                         keys: 1, clicks: 2, text: "f", textHash: "g")
        let object = try #require(try JSONSerialization.jsonObject(with: full.jsonLine()) as? [String: Any])
        #expect(Set(object.keys) == Set(props.keys))
        for name in required { #expect(object[name] != nil) }
        for (name, value) in object {
            let type = props[name]?["type"] as? String
            if type == "integer" { #expect(value is NSNumber && !(value is String), "\(name)") }
            if type == "string" { #expect(value is String, "\(name)") }
        }
    }

    @Test func kindEnumMatchesTheSchema() throws {
        let props = try #require(try schema()["properties"] as? [String: [String: Any]])
        let kinds = try #require(props["kind"]?["enum"] as? [String])
        #expect(Set(kinds) == Set(EventKind.allCases.map(\.rawValue)))
    }

    @Test func observerOutputUsesOnlySchemaFields() throws {
        let props = try #require(try schema()["properties"] as? [String: Any])
        let rig = Rig()
        rig.startAndTick()
        rig.input.pending = InputCounts(keys: 1, clicks: 1)
        rig.idle.seconds = 200
        rig.run(seconds: 60)
        rig.pause.isPaused = true
        rig.run(seconds: 1)
        #expect(Set(rig.sink.kinds()) == [.focus, .ocr, .input, .idleStart, .pause])
        for event in rig.sink.events {
            let object = try #require(try JSONSerialization.jsonObject(with: event.jsonLine()) as? [String: Any])
            #expect(Set(object.keys).isSubset(of: Set(props.keys)))
        }
    }
}

@Suite struct S02NoNetworkTests {
    @Test func engineSourcesContainNoNetworkCode() throws {
        let sources = engineDir().appendingPathComponent("Sources")
        let banned = ["URLSession", "import Network", "NSURLConnection", "CFNetwork", "NWConnection", "CFStream",
                      "socket(", "URLRequest"]
        let files = try #require(FileManager.default.enumerator(atPath: sources.path)?.allObjects as? [String])
            .filter { $0.hasSuffix(".swift") }
        #expect(files.count > 10)
        for file in files {
            let text = try String(contentsOf: sources.appendingPathComponent(file), encoding: .utf8)
            for word in banned { #expect(!text.contains(word), "\(file) contains \(word)") }
        }
    }
}
