---
id: s29-byok-key
title: Bring your own Claude key - onboarding and Settings store it in the login Keychain; the brain reads it from there
depends_on: [s24-brief-runner (Keychain key rule), s25-standalone-install (BrainLaunch, --brain-check), s17 (KeychainStore pattern)]
parallel_safe: true
human_gated: false
verify: bash slices/s29-byok-key/verify.sh
paths_in_scope: [app/Sources/Core/ClaudeKey.swift, app/Sources/Core/BrainCheck.swift, app/Sources/Surfaces/ClaudeKeychain.swift, app/Sources/Surfaces/ClaudeKeyViews.swift, app/Sources/Surfaces/OnboardingWindow.swift, app/Sources/Surfaces/DashboardModel.swift, app/Sources/Surfaces/DashboardView.swift, app/Sources/App/OffloadApp.swift, app/build.sh (test list), slices/s25-standalone-install/verify.sh (key line), slices/s29-byok-key/**]
paths_out_of_scope: [brain/**, engine/**, control/**, web/**, schemas/**, packages/**]
---

# s29-byok-key

## Summary
Operator decision: the individual app is BYOK. Each person uses their own Claude API key, kept in their Mac's login
Keychain, and everything runs on their Mac. Until now a tester who opens Offload.app from Finder had no way to give a
key: the brain only read `ANTHROPIC_API_KEY` or `OFFLOAD_ANTHROPIC_KEYCHAIN` from its environment.

## The Keychain item
One fixed generic password: service `offload.anthropic`, account `api-key` (the item LAUNCH.md's rotation note
already names). The brain's existing reference format is `service/account`, so the app launches the brain with
`OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key`: the item's NAME only. The brain reads the value itself
(`/usr/bin/security find-generic-password -s offload.anthropic -a api-key -w`, vision/claude.ts
resolveAnthropicKey). No brain source change is needed; the brain test lives in this slice.

The key is never written to a file, a log, UserDefaults, argv or the environment of any process. The app writes the
item with the Security framework (never the `security` CLI, whose `-w KEY` would put it in argv). The item's access
list trusts Offload and `/usr/bin/security`, so the brain's read does not raise a Keychain prompt. The last four
characters are kept in the item's comment attribute so Settings can show "Key set (…ABCD)" without reading the
secret.

## Design
1. **Format (FORMAT)** - `ClaudeKeyFormat.problem`: empty, whitespace, not `sk-ant-`, wrong length or characters -> a
   plain sentence; nil for a key-shaped string. Nothing is sent for a malformed key.
2. **Validation (VALIDATE)** - `AnthropicKeyValidator`: one `GET https://api.anthropic.com/v1/models?limit=1` with the
   key in the `x-api-key` header (never the URL), ephemeral session, the HTTP layer injected (tests never reach the
   network). 200 = valid; 401/403 = rejected; anything else = could not check.
3. **Flow (FLOW)** - `ClaudeKeyFlow` (Core, pure): entering -> checking -> saved | failed | unverified. Valid keys are
   saved; rejected keys are not; when Anthropic cannot be reached the person may "Save without checking". The text
   field is cleared once handed over. Replace and Remove from Settings. A store error is a sentence, not a crash.
4. **Settings (SETTINGS)** - dashboard Settings row: "Key set (…ABCD)" with Replace key and Remove key, or "No key
   yet" with Add key. With no key, one notice: Claude features are off until a key is added in Settings; local
   features keep working.
5. **Launch (LAUNCH)** - `BrainLaunch.claudeKeyEnvironment`: with a key in the Keychain the brain env gets
   `OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key` and loses any inherited `ANTHROPIC_API_KEY` (s24: a brain
   started with a key in env refuses to build). With no key nothing is added. Saving or removing a key restarts a
   supervised brain so it picks the change up. Neither argv nor env ever holds the key.
6. **Onboarding (ONBOARD)** - the first-run window opens on "Your Claude API key" when no key is set (before the four
   existing steps, which are unchanged). Save checks and stores; "Skip for now" goes on without Claude.
7. **Check (CHECK)** - `Offload --brain-check` prints `key: set` or `key: missing`, never the key.

## Acceptance (tags = Swift test name prefixes in tests/S29Tests.swift, brain test name prefixes in tests/brain)
- FORMAT, VALIDATE, FLOW, SETTINGS, LAUNCH, ONBOARD, CHECK: Swift tests with a fake Keychain and a fake validator.
- BRAIN: with only `OFFLOAD_ANTHROPIC_KEYCHAIN` set, the brain reads the key through the Keychain runner (argv holds
  service and account, never the key), the API backend sends it in a request header to api.anthropic.com only, the
  serve path picks the API backend from the reference alone, and process.env never gains it. These pass on main
  already (the brain needed no change); they pin the contract the app now relies on.
- s25 PROOF prints a `key: set|missing` line and no `sk-ant-` text.
- Full `app/build.sh test`, the brain suite and s25 verify pass. No real key anywhere in the repo.
