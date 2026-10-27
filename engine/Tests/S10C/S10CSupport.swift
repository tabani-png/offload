import Foundation
@testable import OffloadCore

/// Shared by the S10C suites (REVIEW-2 N4, N7, observer logs).
struct S10CResult {
    var code: Int32
    var out: [String]
    var err: [String]
}

let s10cUTC = DayCalendar(timeZone: TimeZone(identifier: "UTC")!)
/// 2026-11-16 09:00 UTC: "2026-10-17" is 30 days old (kept), "2026-10-16" is 31 (expired).
let s10cNow = ISO8601DateFormatter().date(from: "2026-11-16T09:00:00Z")!

func s10cCLI(_ args: [String], home: URL, secrets: SecretStore, stdin: String = "", now: Date = s10cNow,
             env: [String: String] = [:]) throws -> S10CResult {
    var out: [String] = []
    var err: [String] = []
    let code = ObserverCLI.runOffline(try ObserverCLI.parse(args + ["--home", home.path]), environment: env,
                                      now: now, days: s10cUTC, secrets: secrets, input: { Data(stdin.utf8) },
                                      out: { out.append($0) }, err: { err.append($0) })
    return S10CResult(code: code, out: out, err: err)
}

/// Stores a generated brain key `name` directly (no CLI, no age check).
func s10cBrainKey(_ layout: StoreLayout, _ name: String, secrets: SecretStore) throws {
    _ = try BrainKeys(layout: layout, secrets: secrets).wrap(name: name, key: nil)
}

func s10cExists(_ url: URL) -> Bool { FileManager.default.fileExists(atPath: url.path) }
