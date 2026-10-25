import Foundation
import Testing
@testable import OffloadCore

/// REVIEW-1 H4 support: `wrap-key` / `unwrap-key --name NAME` keep a 32-byte brain key in
/// `$OFFLOAD_HOME/keys/brain-NAME.key`, wrapped (OKW1) with the Keychain master key and the name bound in.
@Suite struct S02CBrainKeyTests {
    let key = Data((0..<32).map { UInt8($0 * 7 & 0xff) })
    var keyB64: String { key.base64EncodedString() }

    struct Result {
        var code: Int32
        var out: [String]
        var err: [String]
    }

    func cli(_ args: [String], home: URL, secrets: SecretStore, stdin: String = "",
             env: [String: String] = [:]) throws -> Result {
        var out: [String] = []
        var err: [String] = []
        let code = ObserverCLI.runOffline(try ObserverCLI.parse(args + ["--home", home.path]), environment: env,
                                          now: Date(), secrets: secrets, input: { Data(stdin.utf8) },
                                          out: { out.append($0) }, err: { err.append($0) })
        return Result(code: code, out: out, err: err)
    }

    @Test func parsesWrapAndUnwrapWithTheNameFlag() throws {
        #expect(try ObserverCLI.parse(["wrap-key", "--name", "vault"]).command == .wrapKey("vault"))
        #expect(try ObserverCLI.parse(["unwrap-key", "--name=vault-2"]).command == .unwrapKey("vault-2"))
        #expect(throws: ArgumentError.missingValue("--name")) { try ObserverCLI.parse(["wrap-key"]) }
        #expect(throws: ArgumentError.missingValue("--name")) { try ObserverCLI.parse(["unwrap-key", "--name"]) }
        #expect(throws: ArgumentError.unexpected("x")) { try ObserverCLI.parse(["wrap-key", "--name", "a", "x"]) }
    }

    @Test func rejectsNamesThatCouldEscapeTheKeysFolder() {
        for bad in ["../x", "a/b", "", "A", ".hidden", "-lead", "x.key", String(repeating: "a", count: 33), "a b"] {
            #expect(throws: ArgumentError.invalidValue("--name")) { try ObserverCLI.parse(["wrap-key", "--name", bad]) }
        }
    }

    @Test func wrapStoresAnOKW1FileAndPrintsOnlyTheBase64Key() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        let r = try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: keyB64 + "\n")
        #expect(r.code == 0, "\(r.err)")
        #expect(r.out == [keyB64])
        #expect(r.err.isEmpty)
        let file = layout.brainKeyFile("vault")
        #expect(file.lastPathComponent == "brain-vault.key")
        let data = try Data(contentsOf: file)
        #expect(data.count == DayKeyVault.wrappedSize)
        #expect(DayKeyVault.isWrapped(data))
        #expect(data.range(of: key) == nil)  // never stored in the clear
        let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
        #expect(secrets.items[DayKeyVault.masterAccount]?.count == 32)
    }

    @Test func unwrapReturnsTheSameKey() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        #expect(try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: keyB64).code == 0)
        let r = try cli(["unwrap-key", "--name", "vault"], home: home, secrets: secrets)
        #expect(r.code == 0)
        #expect(r.out == [keyB64])
    }

    @Test func wrapWithEmptyStdinGeneratesARandomKey() throws {
        let home = tempHome()
        let secrets = MemorySecretStore()
        let a = try cli(["wrap-key", "--name", "a"], home: home, secrets: secrets)
        let b = try cli(["wrap-key", "--name", "b"], home: home, secrets: secrets)
        #expect(a.code == 0 && b.code == 0)
        let first = try #require(a.out.first)
        let ka = try #require(Data(base64Encoded: first))
        #expect(ka.count == 32)
        #expect(a.out != b.out)
        #expect(try cli(["unwrap-key", "--name", "a"], home: home, secrets: secrets).out == a.out)
    }

    @Test func wrapAgainReturnsTheStoredKeyAndNeverReplacesIt() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        #expect(try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: keyB64).code == 0)
        let before = try Data(contentsOf: layout.brainKeyFile("vault"))
        // Same key: idempotent.
        #expect(try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: keyB64).out == [keyB64])
        // No stdin: returns the stored key, does not make a new one.
        #expect(try cli(["wrap-key", "--name", "vault"], home: home, secrets: secrets).out == [keyB64])
        // A different key: refused, file untouched, nothing on stdout.
        let other = Data(repeating: 9, count: 32).base64EncodedString()
        let r = try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: other)
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
        #expect(r.err.first?.contains("different key") == true)
        #expect(try Data(contentsOf: layout.brainKeyFile("vault")) == before)
    }

    @Test func badStdinIsRefusedWithoutEchoingIt() throws {
        let home = tempHome()
        for input in ["not base64 !!", Data(repeating: 1, count: 16).base64EncodedString(), keyB64 + "\n" + keyB64] {
            let r = try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: MemorySecretStore(), stdin: input)
            #expect(r.code == 1)
            #expect(r.out.isEmpty)
            #expect(!r.err.joined().contains(input.prefix(12)))
        }
        #expect(!FileManager.default.fileExists(atPath: StoreLayout(home: home).brainKeyFile("vault").path))
    }

    @Test func theNameIsBoundIntoTheWrappedFile() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        #expect(try cli(["wrap-key", "--name", "a", "--import"], home: home, secrets: secrets, stdin: keyB64).code == 0)
        try FileManager.default.copyItem(at: layout.brainKeyFile("a"), to: layout.brainKeyFile("b"))
        let r = try cli(["unwrap-key", "--name", "b"], home: home, secrets: secrets)
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
    }

    @Test func anotherMasterKeyCannotUnwrapIt() throws {
        let home = tempHome()
        #expect(try cli(["wrap-key", "--name", "a", "--import"], home: home, secrets: MemorySecretStore(), stdin: keyB64).code == 0)
        let r = try cli(["unwrap-key", "--name", "a"], home: home, secrets: MemorySecretStore())
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
    }

    @Test func unwrapOfAMissingKeyFailsAndCreatesNoMasterKey() throws {
        let secrets = MemorySecretStore()
        let r = try cli(["unwrap-key", "--name", "none"], home: tempHome(), secrets: secrets)
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
        #expect(r.err.first?.contains("brain-none.key") == true)
        #expect(secrets.items.isEmpty)
    }

    @Test func fileKeyModeRefusesAndNeverTouchesTheKeychain() throws {
        let secrets = MemorySecretStore()
        let r = try cli(["wrap-key", "--name", "a", "--import"], home: tempHome(), secrets: secrets, stdin: keyB64,
                        env: ["OFFLOAD_KEYS": "file"])
        #expect(r.code == 1)
        #expect(r.err.first?.contains("OFFLOAD_KEYS=file") == true)
        #expect(secrets.calls == 0)
    }

    @Test func aFailingKeychainFailsWithoutLeakingTheKey() throws {
        let secrets = MemorySecretStore()
        secrets.failure = StoreError.keychain(-25308)
        let r = try cli(["wrap-key", "--name", "a", "--import"], home: tempHome(), secrets: secrets, stdin: keyB64)
        #expect(r.code == 1)
        #expect(r.out.isEmpty)
        #expect(!r.err.joined().contains(keyB64))
    }

    @Test func retentionAndStatusIgnoreBrainKeys() throws {
        let home = tempHome()
        let layout = StoreLayout(home: home)
        let secrets = MemorySecretStore()
        #expect(try cli(["wrap-key", "--name", "vault", "--import"], home: home, secrets: secrets, stdin: keyB64).code == 0)
        let far = ISO8601DateFormatter().date(from: "2030-01-01T00:00:00Z")!
        #expect(Retention(layout: layout).purge(now: far).isEmpty)
        #expect(Retention(layout: layout).storedDays().isEmpty)
        #expect(FileManager.default.fileExists(atPath: layout.brainKeyFile("vault").path))
        let counts = DayKeyVault.keyFileCounts(layout: layout)
        #expect(counts.raw == 0 && counts.wrapped == 0)
        #expect(try DayKeyVault(layout: layout, mode: .keychain, secrets: secrets).migrateRawKeys().isEmpty)
    }
}
