import Foundation
import Testing
@testable import OffloadCore

@Suite struct S01ScaffoldTests {
    @Test func homeFlagWinsOverEnvironment() {
        let home = StoreLayout.resolveHome(flag: "/tmp/a", environment: ["OFFLOAD_HOME": "/tmp/b"])
        #expect(home.path == "/tmp/a")
    }

    @Test func environmentHomeWinsOverDefault() {
        #expect(StoreLayout.resolveHome(flag: nil, environment: ["OFFLOAD_HOME": "/tmp/b"]).path == "/tmp/b")
    }

    @Test func defaultHomeIsApplicationSupportOffload() {
        let home = StoreLayout.resolveHome(flag: nil, environment: [:])
        #expect(home.path.hasSuffix("Library/Application Support/Offload"))
    }

    @Test func storeLayoutMatchesTheContractPaths() {
        let layout = StoreLayout(home: URL(fileURLWithPath: "/h"))
        #expect(layout.encryptedDayFile("2026-10-20").path == "/h/days/2026-10-20.jsonl.enc")
        #expect(layout.plainDayFile("2026-10-20").path == "/h/days/2026-10-20.jsonl")
        #expect(layout.keyFile("2026-10-20").path == "/h/keys/2026-10-20.key")
        #expect(layout.purgeLog.path == "/h/purge-log.jsonl")
    }

    @Test func buildProducesTheObserverExecutable() {
        let build = ProcessInfo.processInfo.environment["OFFLOAD_BUILD_DIR"] ?? engineDir().appendingPathComponent(".build").path
        #expect(FileManager.default.isExecutableFile(atPath: build + "/offload-observer"))
        #expect(FileManager.default.fileExists(atPath: build + "/libOffloadCore.dylib"))
    }
}
