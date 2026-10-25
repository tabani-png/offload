# 12 · REA teardown: trycua/cua

Target: https://github.com/trycua/cua · commit `59cf287` (2026-10-24).
Clone: `~/builds/cua`, depth 1, blobless, **sparse** (the disk had about 170 MB free; the full repo is about 650 MB). Checked-out paths: `libs/python/agent/cua_agent`, `libs/python/cua-sandbox/cua_sandbox`, `libs/spaces-notch-swift`, `apps/cua-spaces-macos/Sources`, `libs/typescript/cursor-motion`, `libs/cua-driver/docs`, root files. Anything outside these paths counts as UNKNOWN.
Method: REA phases 0-4. Static read only. Nothing built, run or installed.
Brief asked about two things: the desktop and agent UI design language, and how cua drives the computer (the agent loop and sandboxes).
Headline: **cua is two products in one repo, under two licenses.** The agent loop is a plain MIT Python generator. The Mac UI (Spaces app and notch) is FSL-1.1-MIT source-available code and looks deliberately stock-Apple. Its most useful asset for us is a document: the Computer History privacy contract.

---

## PHASE 0 · VERIFY

| Item | Value | Evidence |
|---|---|---|
| Root license | MIT | [`LICENSE.md` line 1] |
| Spaces app + notch license | **FSL-1.1-MIT** (source-available, converts to MIT later) | [`libs/spaces-notch-swift/LICENSE` lines 1-5]; 105 files carry `SPDX-License-Identifier: FSL-1.1-MIT` across `apps/` + `libs/spaces-notch-swift` [grep]; README "source-available under FSL-1.1-MIT" [`README.md` line 85] |
| cursor-motion license | MIT | [`libs/typescript/cursor-motion/LICENSE` line 1] |
| Driver perception extension | AGPL-3.0 (OmniParser), opt-in | [`libs/cua-driver/README.md` lines 19-26] |
| Agent stack | Python, async, LiteLLM routing, about 20 model-specific loops | [`cua_agent/agent.py` lines 350-381], [`cua_agent/loops/` listing] |
| Mac app stack | SwiftUI, macOS 26+, Rust core over FFI (`CuaSpacesFFI`, `CuaSDK`), plus a web UI hosted in a window | [`Views/RunTimelineView.swift` lines 4-5], [`README.md` line 77], [`WebHost/WebUIBridge*.swift`] |
| Sandboxes | runtimes: docker, lume, tart, qemu, hyperv, android emulator, native; transports: ssh, vnc, vncssh, qmp, adb, grpc, osworld | [`cua-sandbox/cua_sandbox/runtime/`, `transport/` listings] |
| Driver | MCP-over-stdio background driver, "drives native macOS apps without stealing focus" | [`libs/cua-driver/README.md` line 3] |
| Pricing | Spaces free for individuals, Pro $18/mo, Teams $30/seat/mo | [`README.md` line 85] |

---

## CONFIRMED

**Agent loop (how it drives the computer)**
- C1. `ComputerAgent.run()` is an async generator. It loops while the last new item is not an assistant message. [`agent.py` `run()` line 936]
- C2. Each turn: `on_run_continue` gate → merge old + new items → rewrite failed computer calls → `on_llm_start` preprocessors → `predict_step` with retry → `on_llm_end` → yield → execute every output item → yield partial outputs. [`agent.py` lines 936-1043]
- C3. Computer calls are dispatched by reflection: `getattr(computer, action.type)(**args)`. An unknown action raises `ToolError`. [`agent.py` `_handle_item` lines 746-764]
- C4. After every non-terminate action it sleeps `screenshot_delay` (default 0.5 s), then screenshots and feeds the image back as `computer_call_output`. [`agent.py` lines 787-792, 421]
- C5. Pending model safety checks are **auto-acknowledged**; the confirm callback is a TODO. [`agent.py` lines 794-804]
- C6. The action surface is 14 primitives: screenshot, click, double_click, scroll, type, wait, move, keypress, drag, get_current_url, left_mouse_down/up, get_environment, get_dimensions. [`computers/base.py` lines 23-81]
- C7. The model picks the loop by regex; for example `claude-opus/sonnet-5*` maps to tool `computer_20251124` with beta `computer-use-2025-11-24`. [`loops/anthropic.py` lines 53-68]
- C8. The loop protocol has two capabilities, `predict_step` (full agent) and `predict_click` (grounding only). Composed loops pair a planner with a grounder. [`loops/base.py` lines 15-70], [`loops/composed_grounded.py` exists]
- C9. Cross-cutting behavior is done with callbacks, not branches: ImageRetention (keep the last N screenshots), TrajectorySaver, BudgetManager (stops on `response_cost` sum), PII anonymization, OperatorValidator, Logging, PostHog telemetry, OTel. [`agent.py` lines 330-396], [`callbacks/` listing], [`callbacks/budget_manager.py` lines 15-41]
- C10. Telemetry is on by default (PostHog + OTel) and records action types and model name, never args. [`agent.py` lines 386-444, 767-780]
- C11. Local model providers are registered into LiteLLM: huggingface-local, mlx, human (a person acts as the model), cua, azure_ml. [`agent.py` lines 353-366]

**Driver and history**
- C12. Permission modes are fixed at launch: `standard` (no prompts), `bounded` (reviewed manifest only), `unrestricted` (needs `--dangerously-bypass-approvals`). [`cua-driver/README.md` lines 73-84]
- C13. Computer History is opt-in, local and encrypted (Keychain-held key, COSE_Encrypt0 records of CloudEvents JSON). It is a strict metadata allowlist: no screenshots, keystrokes, clipboard, raw args, AX trees, file paths, window titles or URLs. [`docs/computer-history-architecture.md` lines 14-26, 54]
- C14. History rules: "fail closed on privacy, fail open on action", and it never blocks an action. [`computer-history-architecture.md` lines 56, 70]
- C15. Preview 0 records **only Cua-mediated actions**, with no ambient desktop observation; ambient app/window events are a later, separately gated stage. [`computer-history-architecture.md` line 26, 74]

**Design language (Mac app + notch)**
- C16. Stock semantic styling dominates: `foregroundStyle(.secondary)` x190, `.tertiary` x9; fonts `.callout` x77, `.caption` x46, `.headline` x18, `.title` x8; custom `.system(size:)` only 12 times. [grep over `Views/` + `Notch/`]
- C17. Native containers: `Form { }.formStyle(.grouped)` x22, `ContentUnavailableView` x5, `NavigationSplitView`, `MenuBarExtra`, `.searchable`, `SettingsLink`, `.symbolEffect`. [grep, same scope]
- C18. Materials and system colors, not a hex palette: `.sidebar` x21, `.popover`, `.menu`, `.regularMaterial`, `Color(nsColor: .separatorColor / .textBackgroundColor)`. Hardcoded hex appears only via `Color(webHex:)` bridged from the web UI. [grep, Swift sources]
- C19. Corner radii cluster at 8 (x7), 7 (x5), 6, 5, 4, 10, 12, 16. [grep `cornerRadius:`]
- C20. Run timeline pattern: prompt as a right-aligned bubble (radii 16/16/6/16, `.quaternary` fill); agent prose as inline Markdown; each stretch of tool activity is a muted collapsible group showing its summary + last step; expanded steps are 11.5 pt monospaced with a 1 pt separator rail. It auto-follows the end, and a capsule "Follow the run / Jump to latest" pill appears when you scroll up. [`Views/RunTimelineView.swift` lines 8-148]
- C21. Notch state machine: phases `closed | tiles | prompt`, plus a hover `cue`. Open = shape springs out of the hardware notch, then content fades and scales in after `contentDelayMs`. Close = content fades first, then a critically damped spring so it never rises above the notch. Reduce Motion swaps everything for an opacity fade. [`NotchStage.swift` lines 7-22, 66-110]
- C22. Motion is data, not code: `hoverDwellMs, closeDelayMs, open/close/hover response+damping, hoverScale, contentDelayMs, contentIn/Out, contentScale, reducedDuration` come from the Rust core. [`NotchData.swift` `Motion` lines 246-283]
- C23. Notch tile status vocabulary: `local | running | approval | suspended | provisioning | deleting`. Activity indicator = SF Symbol or a progress ring (real per-mille, else estimate from `startedAt`). [`NotchData.swift` lines 33-79]
- C24. Agent cursor motion: six styles (signature_arc default, spring_settle, magnetic, comet_swoop, adaptive, classic); Fitts timing `150 + 120·log2(D/W+1)` ms clamped 300-1000; the cursor is drawn in its own layer and never moves the real pointer. [`cursor-motion/README.md` lines 51-87]

---

## INFERENCE

- I1. guess: the notch motion values live in Rust so the web UI, SwiftUI app and helper animate identically — reason: `NotchData` is described as "the app core's notch records field for field" [`NotchData.swift` lines 6-10] and the cursor-motion crate makes the same golden-trajectory claim [`cursor-motion/README.md` lines 8-11].
- I2. guess: the Spaces app is a hybrid; part of the UI is a hosted web app in a WKWebView — reason: `WebHost/WebUIBridge+Pages.swift`, `WebUISchemeHandler.swift`, `Color(webHex:)`; the web bundle itself is not checked out.
- I3. guess: the auto-acknowledge on safety checks (C5) means that any run without a human or `OperatorValidator` acts unchecked — reason: no other acknowledge path in `agent.py`; callbacks not read in full.
- I4. guess: `standard` mode being promptless (C12) is the reason the app shows explicit `approval` tile states and a Keyvault approval sheet — reason: approval UX moved up to the app [`NotchData.TileStatus.approval`, `AppEnvironment.swift` line 490 "device-approval"].
- I5. guess: our 7-day observer is the "ambient" stage that cua itself has deferred for privacy reasons — reason: C15 + "Ambient app/window events ... are later stages with independent gates".

## UNKNOWN

- U1. Actual notch motion numbers (dwell ms, spring response/damping). They live in the Rust core, which is not checked out.
- U2. The web UI's tokens (colors, type) under `apps/cua-spaces-web` are not checked out.
- U3. How `cua-spacesd` exposes input inside a Space (protocol, latency).
- U4. Driver background-input mechanism on macOS (AX actions vs synthetic events per app). Lives in `cua-driver/rust`, not checked out.
- U5. Whether the ImageRetention default is set anywhere in the app paths.

---

## THE ONE FEATURE · the agent step loop (perceive → predict → act → re-perceive)

Traced path [`agent.py`]:
1. `run(messages)` → `_initialize_computers()` resolves tools for the model's required tool type (browser/mobile wraps Computer) [lines 446-480, 914].
2. Loop guard: continue until an assistant message ends the turn [936].
3. `_on_run_continue` → BudgetManager can stop on cost [938-940; `budget_manager.py` 41].
4. `_on_llm_start` → ImageRetention trims old screenshots, PII callback can scrub [942-948].
5. `_predict_step_with_retry(agent_loop.predict_step, …)` is the only retry layer (inner LiteLLM retries are 0) [956-1004].
6. Yield the model output, then for each item `_handle_item`: message → `on_text`; computer_call → reflective dispatch → wait 0.5 s → screenshot → `computer_call_output` [717-819].
7. Partial outputs are yielded; the loop repeats; `_on_run_end` fires at the end [1032-1045].

**Recovered rule.** Keep the loop dumb and uniform (a Responses-format item list), put model quirks in per-model loop adapters, and push every policy (budget, privacy, logging, retention, validation) into ordered callbacks with fixed hook names. The screen is the only state the model sees after each action.

---

## DATA MODEL (as built)

```
Item (Responses format)  message | computer_call{call_id, action{type,...}, pending_safety_checks}
                         | computer_call_output{call_id, output{image_url}, acknowledged_safety_checks}
                         | function_call | function_call_output                  [agent.py 717-819]
AgentCapability          "step" | "click"                                       [loops/base.py 72-80]
Callback hooks           on_run_start/continue/end, on_llm_start/end, on_api_start/end,
                         on_computer_call_start/end, on_function_call_start/end,
                         on_text, on_usage, on_screenshot, on_responses           [agent.py 602-711]
NotchData.View           {phase, tiles[Tile], prompt?, header?, activity?, permission?, access?, hidden, hoverCue}
Tile                     {id, name, status, location, progress?, signedIn, dropTarget}   [NotchData.swift 137-207]
History event (spec)     CloudEvents JSON, allowlisted metadata only, encrypted per record   [computer-history-architecture.md 54]
```

---

## SPEC SEED · clean-room agent runner + Apple-native run UI (behavior only)

**Behavior**
- B1. Runner takes a goal + a target computer handle and loops observe → plan → act → observe until the model ends the turn or a gate stops it.
- B2. One action vocabulary for every target (click, type, keypress, scroll, drag, move, wait, screenshot).
- B3. Hooks run in a fixed order at fixed points; any hook can veto continuing (budget, step cap, user stop).
- B4. Every proposed side-effecting action passes an approval gate before dispatch. Unlike cua C5, nothing is auto-acknowledged.
- B5. The history writer records metadata only, is local and encrypted, and never blocks an action.
- B6. Run UI: goal bubble, agent prose, collapsible activity groups (summary + last step), monospaced step detail, auto-follow with a "Jump to latest" pill.
- B7. Status vocabulary shown everywhere: draft, awaiting approval, running, paused, done, failed.

**Inputs / outputs**
- In: goal text, target handle, policy (budget, max steps, allowed apps), approval channel.
- Out: streamed items, final status, a run record `{id, workflow_id, started, ended, steps, outcome, seconds_saved_estimate}`.

**Edge cases**
- E1. A failed action must be fed back as an error the model can read (cua rewrites failed computer calls) [agent.py 947].
- E2. Screenshot right after an action can capture mid-animation → configurable settle delay.
- E3. Context blow-up from images → keep the last N screenshots only.
- E4. Retry layers stacking → one retry layer only.
- E5. Model asks for an action the target does not support → hard error, not a silent skip.
- E6. User touches the mouse during a run → pause and hand control back (cua "Multiplayer": user steps in, hands back) [README line 72].
- E7. Reduce Motion is on → fades only.

---

## REBUILD PLAN · what we take for our product

Our product: a local Mac tool that watches for 7 days, finds repeated work, suggests automations with time saved, builds the workflow on approval, shows a dashboard. Apple-native feel.

**Take (pattern, rewritten; no FSL code copied)**
- T1. **Privacy contract first.** Adopt cua's Computer History boundary as our observer's charter: an allowlist of metadata, local, Keychain-keyed encryption, fail closed on privacy, a visible pause/resume/delete. Our 7-day watch needs more than cua's Preview 0 (app activations, window switches, menu commands, AX focus changes, file-type events), so every extra field needs an explicit allowlist entry and an on-screen disclosure. Default to no screenshots, no typed text, no URLs or titles unless the user opts in per app.
- T2. **Callback-ordered loop** for "build the workflow on approval": a dumb executor plus hooks for budget, step cap, approval gate, PII scrub and trajectory save. Make approval blocking; do not copy C5.
- T3. **Apple-native design rule taken from cua's practice:** semantic colors, `.secondary`/`.tertiary` hierarchy, `.callout`/`.caption`/`.headline` text styles, grouped `Form` for settings, `ContentUnavailableView` for empty days 1-6 ("Still learning your week"), `NavigationSplitView` dashboard, `MenuBarExtra` for status, materials, and radii around 8. No custom palette. This is the opposite of Clicky's dark hex system.
- T4. **Run timeline** layout (C20) for showing a built automation's dry run and real runs.
- T5. **Status vocabulary + progress ring with estimate** (C23) for "observing day 3 of 7" and per-automation run state.
- T6. **Motion as data** (C22): one motion table (dwell, spring response/damping, content delay) shared by every surface, with a Reduce Motion fallback, so the app feels consistent.
- T7. **Fitts-timed agent cursor in its own layer** (C24) when replaying a workflow, so the user's real pointer is never hijacked. The cursor-motion lib is MIT, but we still write our own.

**Do not take**
- D1. FSL-licensed Swift (Spaces app, notch). We read it for patterns only.
- D2. Telemetry on by default (C10).
- D3. Promptless `standard` mode as our default for automations that touch user apps.
- D4. VM sandboxes for v1. Our automations run on the user's own Mac; sandboxes are a later "test this workflow safely" option.

**Build order**
1. Observer v0: NSWorkspace activation + AX focus events → allowlisted encrypted store; pause/delete in the menu bar.
2. Pattern miner over 7 days of events (repeated app sequences, with timing) → candidate list with minutes per week.
3. Dashboard: NavigationSplitView with candidates, evidence count, estimated time saved, Approve.
4. Executor loop with blocking approval and a dry run shown in the run timeline.
5. Notch or menu-bar nudge only after steps 1-4 hold.

---

## TO CONFIRM

- TC1. Widen the sparse checkout (once disk space allows) to `libs/cua-driver/rust/crates/cua-driver-core/src/{tool.rs,authorization.rs}` to settle U4 and the approval path.
- TC2. Read `callbacks/operator_validator.py` and `image_retention.py` in full to settle I3 and U5.
- TC3. Read the notch motion defaults in the Rust core (`appNotchMotion`) to get real spring numbers (U1).
- TC4. Read `apps/cua-spaces-web/src` theme for the web tokens (U2).
- TC5. Check the FSL-1.1-MIT conversion date in the notch LICENSE (the "MIT Future" clause) before any reuse decision.
- TC6. Read `docs/computer-history-preview.md` for the user-facing consent and delete UX copy pattern.
