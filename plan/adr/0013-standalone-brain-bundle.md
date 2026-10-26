# 0013 Standalone install: the brain ships inside Offload.app (pinned bun + brain JS)

Date: 2026-10-26. Status: accepted (slices/s25-standalone-install). Closes LAUNCH.md §6 "Install without the repo";
adds the signing and notarization step that §6 "Code signing" and "Notarization" need once a Developer ID exists.

## Context
Before s25 the app found the brain through the repo (`OFFLOAD_REPO`, or up to six folders above the bundle) and ran
it with an installed bun. An installed app has neither. Two ways to carry the brain were open:
(a) `bun build --compile` into one binary, or (b) a pinned bun runtime plus the brain's JS in the bundle.

## Decision
**(b) a pinned bun runtime plus the brain's JS.** `app/build.sh` bundles by default:

```
Offload.app/Contents/Helpers/bun        bun PINNED_BUN (1.3.12), the version the brain suite runs on
Offload.app/Contents/Helpers/claude     the Agent SDK's native claude binary, kept with Anthropic's signature
Offload.app/Contents/Resources/offload/ brain/{src,fixtures,package.json,node_modules (bun install --production)}, schemas/
```
The SDK's package path `node_modules/@anthropic-ai/claude-agent-sdk-darwin-<arch>/claude` is a relative link to
`Helpers/claude`, so the SDK resolves it unchanged and code stays out of Resources. `BrainLaunch.locate` uses the
bundled brain first; the repo with an installed bun is a dev-only fallback (`OFFLOAD_BRAIN_SOURCE=repo` forces it).
No brain code changed.

Why not `bun build --compile` (tried on this Mac, bun 1.3.12, macOS 26):
1. **The compiled binary does not run here.** The output keeps bun's own size and a signature `codesign` reports as
   "invalid or unsupported format"; it cannot be re-signed, and the kernel kills it at launch (exit 137). A signed,
   notarized app cannot ship that.
2. **The brain reads its own files at run time**, which `$bunfs` does not serve: `tone/draft.ts` reads
   `workflows/prompts/draft-email.md` via `import.meta.url`; `workflows/drafter.ts` copies `workflows/scripts/*.ts`
   into each workflow folder; `time/breakdown.ts` probes `import.meta.dir/../solutions/service.ts` (it would silently
   lose the s22 fix source); `builder/runner.ts` reads the SDK's package.json for its version.
3. **The s24 builder runs bun as a subprocess**: `bun test` / `bun run` in the workspace and `process.execPath run`
   for checks. A compiled binary is not a `bun` on PATH (only with `BUN_BE_BUN=1` tricks).
4. **The Agent SDK cannot resolve its native binary from `$bunfs`**; its documented workaround extracts a 261 MB file to
   /tmp at run time. The size win of (a) is small anyway: bun's runtime is in both.

## Signing and entitlements
- Default stays ad hoc (`codesign --sign -`), as ADR 0002 builds it. `Helpers/bun` (Oven, Developer ID) and
  `Helpers/claude` (Anthropic, Developer ID, team Q6L2SF6YDW) keep their vendor signatures then.
- `OFFLOAD_SIGN_IDENTITY="Developer ID Application: NAME (TEAM)"`: inside-out, no `--deep`, every step with
  `--options runtime --timestamp`: `Helpers/bun` with `app/brain.entitlements`, then `libOffloadCore.dylib`, the
  observer, then the app. `Helpers/claude` is verified, not re-signed (a third-party Developer ID signature with the
  hardened runtime and a timestamp is accepted by notarization; re-signing would have to carry its own entitlements:
  apple-events, audio-input, allow-jit, allow-unsigned-executable-memory, disable-library-validation).
- `app/brain.entitlements` (bun under the hardened runtime, the set bun's release binary carries):
  `com.apple.security.cs.allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`,
  `allow-dyld-environment-variables`, `disable-library-validation`. JavaScriptCore needs the first two. The app and
  the observer need no entitlements (screen and accessibility access are TCC grants, not entitlements).
- `OFFLOAD_NOTARY_PROFILE=NAME`: `ditto` zip, `xcrun notarytool submit --keychain-profile NAME --wait`, require
  `status: Accepted`, then `xcrun stapler staple` and `validate`. The credentials live in the keychain profile
  (`xcrun notarytool store-credentials NAME`); the repo holds none and the script prints none. Refused for ad hoc.
- `OFFLOAD_SIGN_IDENTITY=-` signs ad hoc with the hardened runtime and the entitlements: slices/s25 uses it to prove
  the bundled brain still starts under the hardened runtime.

## Consequences
- The bundle is about 395 MB: claude 261 MB, bun 59 MB, brain JS + node_modules 61 MB. Builds use APFS clones, so a
  build costs little extra disk on the build Mac.
- Bumping bun is a deliberate edit of `PINNED_BUN`; the build refuses any other bun version.
- A brain edit needs an app rebuild to reach the bundled copy (`scripts/run.sh` rebuilds), or `OFFLOAD_BRAIN_SOURCE=repo`.
- The bundle must stay read-only: s25's proof runs the brain from a read-only copy.
- Under the hardened runtime with an ad hoc identity the observer may fail to load `libOffloadCore.dylib` (library
  validation needs a team ID); with a real Developer ID both share the team and it loads. Retest onboarding
  permissions on the signed app (LAUNCH.md §6).
- Open for the operator: a Developer ID Application certificate and a notarytool keychain profile. Out of scope here:
  an updater (Sparkle), a DMG.
