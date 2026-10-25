import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-2 N7: `wrap-key` never overwrites a stored key and only accepts a caller-chosen key (stdin) with an
/// explicit `--import`; without it a planted key cannot become a day's brain key.
@Suite struct S10CWrapKeyImportTests {
    let key = Data((0..<32).map { UInt8(($0 * 13 + 5) & 0xff) })
    var keyB64: String { key.base64EncodedString() }

    @Test func parsesImportOnWrapKeyOnly() throws {
        #expect(try ObserverCLI.parse(["wrap-key", "--name", "a", "--import"]).command == .importKey("a"))
        #expect(try ObserverCLI.parse(["wrap-key", "--import", "--name=a"]).command == .importKey("a"))
        #expect(try ObserverCLI.parse(["wrap-key", "--name", "a"]).command == .wrapKey("a"))
        #expect(throws: ArgumentError.unexpected("--import")) {
            try ObserverCLI.parse(["unwrap-key", "--name", "a", "--import"])
        }
        #expect(throws: ArgumentError.missingValue("--name")) { try ObserverCLI.parse(["wrap-key", "--import"]) }
    }

    @Test func aStdinKeyWithoutImportIsRefusedAndNothingIsStored() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        let r = try s10cCLI(["wrap-key", "--name", "2026-10-24"], home: home, secrets: secrets, stdin: keyB64 + "\n")
        #expect(r.code == 2)
        #expect(r.out.isEmpty)
        #expect(r.err.first?.contains("--import") == true)
        #expect(!r.err.joined().contains(keyB64))
        #expect(!s10cExists(StoreLayout(home: home).brainKeyFile("2026-10-24")))
        #expect(secrets.calls == 0)
    }

    @Test func aStdinKeyWithoutImportIsRefusedEvenWhenItMatchesTheStoredKey() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        #expect(try s10cCLI(["wrap-key", "--name", "a", "--import"], home: home, secrets: secrets, stdin: keyB64).code == 0)
        let r = try s10cCLI(["wrap-key", "--name", "a"], home: home, secrets: secrets, stdin: keyB64)
        #expect(r.code == 2)
        #expect(r.out.isEmpty)
    }

    @Test func importStoresTheGivenKeyAndPrintsIt() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        let r = try s10cCLI(["wrap-key", "--name", "a", "--import"], home: home, secrets: secrets, stdin: keyB64 + "\n")
        #expect(r.code == 0, "\(r.err)")
        #expect(r.out == [keyB64])
        #expect(try s10cCLI(["unwrap-key", "--name", "a"], home: home, secrets: secrets).out == [keyB64])
    }

    @Test func importWithoutAKeyOnStdinIsAUsageError() throws {
        let home = tempHome()
        let r = try s10cCLI(["wrap-key", "--name", "a", "--import"], home: home, secrets: MemorySecretStore())
        #expect(r.code == 2)
        #expect(r.out.isEmpty)
        #expect(!s10cExists(StoreLayout(home: home).brainKeyFile("a")))
    }

    @Test func importNeverOverwritesADifferentStoredKey() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        let made = try s10cCLI(["wrap-key", "--name", "a"], home: home, secrets: secrets)
        #expect(made.code == 0)
        let before = try Data(contentsOf: layout.brainKeyFile("a"))
        let r = try s10cCLI(["wrap-key", "--name", "a", "--import"], home: home, secrets: secrets, stdin: keyB64)
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
        #expect(try Data(contentsOf: layout.brainKeyFile("a")) == before)
        // Importing the bytes already stored is idempotent (a retried migration).
        let same = try #require(made.out.first)
        #expect(try s10cCLI(["wrap-key", "--name", "a", "--import"], home: home, secrets: secrets, stdin: same).out == [same])
    }

    @Test func wrapWithoutStdinReturnsTheStoredKeyAndLeavesTheFileUntouched() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        let first = try s10cCLI(["wrap-key", "--name", "a"], home: home, secrets: secrets)
        let before = try Data(contentsOf: layout.brainKeyFile("a"))
        let again = try s10cCLI(["wrap-key", "--name", "a"], home: home, secrets: secrets)
        #expect(again.code == 0)
        #expect(again.out == first.out)
        #expect(try Data(contentsOf: layout.brainKeyFile("a")) == before)
    }

    @Test func readmeDocumentsTheSameUserTrustBoundaryAndImport() throws {
        let readme = try String(contentsOf: engineDir().appendingPathComponent("README.md"), encoding: .utf8)
        #expect(readme.contains("--import"))
        #expect(readme.localizedCaseInsensitiveContains("same-user trust boundary"))
        #expect(readme.contains("otherBrainKeys"))
    }
}
