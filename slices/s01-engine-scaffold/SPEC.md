---
id: s01-engine-scaffold
title: Engine scaffold (OffloadCore dylib, offload-observer executable, Swift Testing runner, plain swiftc build)
depends_on: []
parallel_safe: true
human_gated: false
verify: bash slices/s01-engine-scaffold/verify.sh
---

# Engine scaffold

## Summary
`engine/` builds with plain `swiftc` (SwiftPM's PackageDescription link is broken on this machine, plan ADR 0002).
`engine/build.sh` builds `libOffloadCore.dylib` + `OffloadCore.swiftmodule` and the `offload-observer` executable
into `engine/.build` (or `$OFFLOAD_BUILD_DIR`). `engine/build.sh test [--filter X]` also builds `offload-tests`
(Swift Testing from the Command Line Tools) and runs it. Pattern copied from `~/builds/workpaper/engine/build.sh`.

## paths_in_scope
- `engine/build.sh`, `engine/Sources/**`, `engine/Tests/**`, `engine/README.md`, `slices/s01-engine-scaffold/**`

## paths_out_of_scope
- `brain/`, `app/`, `plan/`, `packet/`, `schemas/`, `docs/`, `agent-control/`

## Acceptance criteria
- AC-1 `engine/build.sh` exits 0 on Swift 6.3 / macOS 26 / arm64 with Command Line Tools only (no Xcode).
- AC-2 Build outputs exist: `libOffloadCore.dylib`, `OffloadCore.swiftmodule`, `offload-observer`, `offload-tests`.
- AC-3 Home resolution: `--home DIR` beats `$OFFLOAD_HOME` beats `~/Library/Application Support/Offload`.
- AC-4 Store paths match docs/store-contract.md (`days/DAY.jsonl.enc`, `days/DAY.jsonl`, `keys/DAY.key`,
  `purge-log.jsonl`).
- AC-5 No network code in `engine/Sources` (URLSession, URLRequest, NSURLConnection, Network, NWConnection,
  CFStream, CFSocket).
- AC-6 The full engine suite runs at least 25 tests and passes.

## Tests
`engine/Tests/S01/S01ScaffoldTests.swift` (AC-2..AC-4); AC-5 also in `S02NoNetworkTests`.
