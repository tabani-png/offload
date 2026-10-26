---
id: s25-standalone-install
title: Standalone install - Offload.app carries its brain (pinned bun + brain JS), no repo and no bun needed on the Mac
depends_on: [s09a (BrainSupervisor), s24-brief-runner (builder runs bun subprocesses; Keychain key rule), ADR 0002 (plain swiftc)]
parallel_safe: true
human_gated: false (Developer ID signing and notarization run only when the operator sets the env vars)
verify: bash slices/s25-standalone-install/verify.sh
paths_in_scope: [app/build.sh, app/brain.entitlements, app/Sources/Core/BrainSupervisor.swift, app/Sources/Core/BrainCheck.swift, app/Sources/Core/Onboarding.swift (DemoWeek.home), app/Sources/App/OffloadApp.swift, app/README.md, slices/s25-standalone-install/**, plan/adr/0013-*.md, LAUNCH.md]
paths_out_of_scope: [brain/**, engine/**, control/**, web/**, schemas/**, packages/**]
---

# s25-standalone-install

## Summary
LAUNCH.md §6: the app finds the brain through the repo folder (`OFFLOAD_REPO` or up to six folders above the
bundle) and needs bun installed. A real install has neither. This slice puts the brain inside the bundle and makes
the app use it first. ADR 0013 records the choice: a pinned bun runtime plus the brain's JS, not `bun build
--compile` (the brain reads its own files at run time and the s24 builder runs `bun` subprocesses).

## Bundle layout
```
Offload.app/Contents/
  MacOS/Offload, offload-observer, libOffloadCore.dylib   (as before)
  Helpers/bun        pinned bun (build.sh PINNED_BUN), the brain's runtime
  Helpers/claude     the Agent SDK's native claude binary (vendor signed), symlinked from node_modules
  Resources/offload/ the repo layout the brain imports from:
    brain/{src,fixtures,package.json,node_modules (production only)}
    schemas/
```

## Design
1. **build.sh** bundles the brain by default (`OFFLOAD_BUNDLE_BRAIN=0` skips it for a quick UI build). The bun used
   must be the pinned version, else the build fails. Production deps come from `bun install --production
   --frozen-lockfile` into the bundle; copies use APFS clones (`cp -c`) where possible to keep disk use small.
2. **Locate (BUNDLED, FALLBACK, STANDALONE)** - `BrainLaunch.locate`: the bundled brain first; then, dev only, the
   repo (`OFFLOAD_REPO` or walking up) with an installed bun. `OFFLOAD_BRAIN_SOURCE=repo` forces the repo brain.
3. **Spec (SPEC)** - `BrainLaunch.spec(location:...)`: bundled bun on the bundled `cli.ts`, cwd the bundle's
   `Resources/offload`, `Contents/Helpers` first on PATH (so `bun` and `claude` resolve inside the bundle).
4. **Check mode (CHECK)** - `Offload --brain-check --home DIR`: starts the brain through `BrainSupervisor` exactly
   as the app does (model stub), waits for its ready line, calls `GET /status` with the token, prints the source
   line and the status code, stops the brain, exits 0 only on HTTP 200.
5. **Signing** - ad hoc stays the default. With `OFFLOAD_SIGN_IDENTITY` set, `build.sh` (and `build.sh sign APP`)
   signs inside-out with the hardened runtime: `Helpers/bun` with `app/brain.entitlements`, the observer and its
   dylib, then the app. `Helpers/claude` keeps Anthropic's Developer ID signature. With `OFFLOAD_NOTARY_PROFILE`
   (a `notarytool store-credentials` keychain profile name) it zips, submits with `notarytool --wait`, and staples.
   No secrets in the repo; nothing prints keys.
6. Keychain key rules are unchanged (s24: the Anthropic key comes from the Keychain, not env).

## Acceptance (tags = Swift test name prefixes in tests/S25Tests.swift, plus verify.sh checks)
- BUNDLED, FALLBACK, STANDALONE, SPEC, CHECK: Swift tests (run by `app/build.sh test`).
- LAYOUT: the built bundle has Helpers/bun (pinned version), Resources/offload/brain/src/cli.ts, production
  node_modules with no devDependencies, no symlink pointing outside the bundle, `codesign --verify --strict` passes.
- GRAPH: the bundled bun resolves the whole import graph of the bundled cli.ts from inside the copy.
- PROOF: the app is copied to a temp folder outside the repo and made read-only; `Offload --brain-check` runs with
  `env -i`, HOME a temp dir, PATH `/usr/bin:/bin:/usr/sbin:/sbin` (no bun), no OFFLOAD_REPO; it must report the
  bundled source inside the copy and HTTP 200.
- HARDENED: the copy re-signed with `OFFLOAD_SIGN_IDENTITY=-` (hardened runtime + entitlements, ad hoc) passes
  `codesign --verify --strict` and the PROOF run again (JIT entitlements are enough for bun).
- NOTARY: build.sh has the notarytool + stapler step, gated on the env vars, and refuses notarizing an ad hoc build.
- Full `app/build.sh test` passes.
