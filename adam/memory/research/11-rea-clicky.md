# 11 · REA teardown: farzaa/clicky

Target: https://github.com/farzaa/clicky · shallow clone `~/builds/clicky` · commit `a80fa80` (2026-04-27).
Method: REA phases 0-4 (verify, map, trace one feature, recover the rule, SPEC seed). Static read only. Nothing built, run or installed.
Brief asked: how it watches the user and proactively suggests help, plus UI feel.
Headline: **Clicky does not watch and does not suggest on its own.** It is pull-only (push-to-talk). The one proactive moment is a scripted onboarding demo. The UI feel is the asset worth studying.

---

## PHASE 0 · VERIFY

| Item | Value | Evidence |
|---|---|---|
| License | MIT | [`LICENSE` line 1] |
| Platform | macOS menu bar app, no dock icon (`LSUIElement=true`) | [`AGENTS.md` / Architecture] |
| Stack | Swift, SwiftUI + AppKit bridging, ScreenCaptureKit (macOS 14.2+), AVAudioEngine, CGEvent tap | [`AGENTS.md` / Architecture] |
| AI | Claude via SSE (Sonnet 4.6 default, Opus 4.6 option) | [`AGENTS.md`], [`ClaudeAPI.swift`] |
| STT | AssemblyAI streaming `u3-rt-pro`, fallbacks OpenAI upload and Apple Speech | [`AGENTS.md`], [`BuddyTranscriptionProvider.swift`] |
| TTS | ElevenLabs `eleven_flash_v2_5` | [`AGENTS.md`], [`ElevenLabsTTSClient.swift`] |
| Proxy | Cloudflare Worker, routes `/chat`, `/tts`, `/transcribe-token` | [`worker/src/index.ts` `fetch()` lines 28-38] |
| Analytics | PostHog, key hardcoded in source | [`ClickyAnalytics.swift` `configure()` line 18] |
| Size | ~6.5k lines Swift, largest `CompanionManager.swift` 1026 lines | [`wc -l`] |

---

## CONFIRMED

**Trigger model (the core finding)**
- C1. The only user-driven trigger is a global push-to-talk hotkey (ctrl+option), read by a listen-only CGEvent tap on `.flagsChanged/.keyDown/.keyUp`. [`GlobalPushToTalkShortcutMonitor.swift` `start()` lines 37-83, `options: .listenOnly`]
- C2. A screenshot is taken only inside `sendTranscriptToClaudeWithScreenshot`, which runs only after a finalized transcript. There is no timer, poller or event stream that captures the screen on its own. [`CompanionManager.swift` `handleShortcutTransition` → `submitDraftText` → `sendTranscriptToClaudeWithScreenshot` lines 473-586]
- C3. The only `Timer`s in `CompanionManager` are onboarding music fade (90 s), permission polling (1.5 s), and text-stream ticks (0.03 s). None captures the screen. [`CompanionManager.swift` lines 254, 271, 415, 907, 937]
- C4. The only unprompted AI call is `performOnboardingDemoInteraction`, fired once by an AVPlayer boundary observer 40 s into the onboarding video. [`CompanionManager.swift` `setupOnboardingVideo()` lines 852-860, `performOnboardingDemoInteraction()` line 967]
- C5. The onboarding demo prompt forces a pick in the middle 60% of the screen (x and y in 20-80%) and a 3-6 word quirky remark. [`CompanionManager.swift` `onboardingDemoSystemPrompt` line 950]

**Capture and context**
- C6. Captures every display as JPEG, long edge 1280 px, quality 0.8, excluding its own windows. The cursor's display is labelled "primary focus". [`CompanionScreenCaptureUtility.swift` lines 81-108]
- C7. Each image label carries its pixel size so the model's coordinates match the image. [`CompanionManager.swift` lines 600-607]
- C8. Conversation memory is the last 10 exchanges, in RAM, with the point tag stripped. [`CompanionManager.swift` lines 684-696]

**Pointing protocol**
- C9. The model appends `[POINT:x,y:label]`, `[POINT:x,y:label:screenN]` or `[POINT:none]` at the end of its reply. Parsed by one regex anchored at end of string. [`CompanionManager.swift` `parsePointingCoordinates` line 786, system prompt lines 560-577]
- C10. Coordinates are clamped to the screenshot, scaled to display points, Y-flipped to AppKit, offset by display origin. [`CompanionManager.swift` lines 643-670]
- C11. `ElementLocationDetector` exists but nothing calls it; pointing is pure model output. [grep `ElementLocationDetector` hits only its own file]

**Voice rules**
- C12. System prompt: lowercase, one or two sentences by default, written for the ear, no lists or markdown, no "simply/just", end by "planting a seed" rather than a yes/no question. [`CompanionManager.swift` `companionVoiceResponseSystemPrompt` lines 545-560]
- C13. Spinner stays up until TTS audio actually starts; then state goes `.responding`. A new key press cancels the in-flight task and TTS. [`CompanionManager.swift` lines 493-497, 702-706]
- C14. If TTS or the API fails, a fixed message is spoken with system `NSSpeechSynthesizer`. [`CompanionManager.swift` `speakCreditsErrorFallback` line 761]

**Overlay and motion**
- C15. Overlay is one borderless full-screen window per display: level `.screenSaver`, `ignoresMouseEvents = true`, joins all Spaces, full-screen auxiliary. [`OverlayWindow.swift` lines 27-29]
- C16. Buddy is a 16 pt blue triangle that follows the mouse at +35, +25 pt, sampled every 16 ms, with spring(response 0.2, damping 0.6). [`OverlayWindow.swift` `startTrackingCursor` lines 411-443, line 210]
- C17. Flight to target: quadratic bezier, control point lifted by min(distance x 0.2, 80) pt, smoothstep easing, 60 fps timer, duration = clamp(distance/800, 0.6 s, 1.4 s), heading follows the tangent, scale pulses to 1.3x at midpoint. [`OverlayWindow.swift` `animateBezierFlightArc` lines 495-566]
- C18. Lands 8 pt right and 12 pt below the target, clamped 20 pt from edges; bubble scales 0.5 → 1.0 spring(0.4, 0.6), text streams per character at 30-60 ms, holds 3 s, fades 0.5 s, flies back. [`OverlayWindow.swift` lines 465-473, 572-600, 604]
- C19. Return flight cancels if the mouse moves > 100 pt; forward flight cannot be interrupted. [`OverlayWindow.swift` lines 420-429]
- C20. Transient mode: when "Show Clicky" is off, overlay fades in on hotkey and fades out (0.4 s) 1 s after TTS and pointing finish. [`CompanionManager.swift` `scheduleTransientHideIfNeeded` lines 732-757; `OverlayWindow.swift` `fadeOutAndHideOverlay` line 819]
- C21. Menu bar panel is a borderless `.nonactivatingPanel` NSPanel at `.floating`, height fitted to SwiftUI content, closed by a global click-outside monitor. [`MenuBarPanelManager.swift` lines 156-163, 185-202]

**Design tokens**
- C22. Dark-only palette (Radix-like greys): background `#101211`, surfaces `#171918` → `#2E3130`, text `#ECEEED / #ADB5B2 / #6B736F`, accent Tailwind blue-600 `#2563eb`, cursor blue `#3380FF`. [`DesignSystem.swift` lines 28-144]
- C23. Spacing 4/8/12/16/20/24/32; radii 6/8/10/12/pill; durations 0.15/0.25/0.4 s; state-layer opacities 0.08/0.12/0.16. [`DesignSystem.swift` lines 188-236]
- C24. Type is SF system, mostly 11-13 pt medium. [grep `.font(.system(size:` counts: 12 medium x14, 11 medium x13, 13 medium x8]

**Privacy posture**
- C25. Full transcript and full AI reply text are sent to PostHog as event properties. [`ClickyAnalytics.swift` `trackUserMessageSent` line 83, `trackAIResponseReceived` line 91]
- C26. Worker `/chat` forwards the request body to Anthropic with the server key; no caller auth check appears before the upstream fetch. [`worker/src/index.ts` `handleChat` lines 51-60]

---

## INFERENCE

- I1. guess: "always-on companion" in the prompt is a persona, not a behavior — reason: C1-C4 show no ambient loop; the phrase sits only in prompt text [`companionVoiceResponseSystemPrompt` line 546].
- I2. guess: the 20-80% center rule exists because edge targets made the demo flight look broken or collide with menu bar and dock — reason: comment says "no menu bar items, no dock icons" [line 954]; no commit history in a shallow clone to confirm.
- I3. guess: the spinner-until-audio rule is there to hide streaming latency and keep voice and motion in sync — reason: comment "No streaming text display — spinner stays until TTS plays" [line 619].
- I4. guess: the worker is an open relay anyone with the URL can bill — reason: C26; the full file was not read past line 60, so an auth check later in `handleChat` is not ruled out.
- I5. guess: pointing accuracy depends entirely on the vision model reading a 1280 px JPEG — reason: C6 + C11; small targets on a 5K display get about 4x downscaled.

## UNKNOWN

- U1. Real pointing hit rate. No eval or test covers it [`leanring-buddyTests` is a 40-line template].
- U2. Token cost per turn (up to N screenshots per utterance).
- U3. Whether the hosted build ships with analytics opt-out. No setting found in the files read.
- U4. Behavior under macOS 15+ screen-recording re-consent prompts (monthly nag). Not handled in code read.

---

## THE ONE FEATURE · push-to-talk → screenshot → spoken answer → cursor flies to the element

Traced path:
1. `GlobalPushToTalkShortcutMonitor` publishes `.pressed` [`start()` listen-only tap].
2. `CompanionManager.handleShortcutTransition(.pressed)`: cancels prior task and TTS, clears pointer, shows overlay if transient, dismisses panel, starts dictation [lines 473-526].
3. `.released` → dictation finalizes → `submitDraftText(finalTranscript)` → `sendTranscriptToClaudeWithScreenshot` [lines 513-534].
4. Capture all displays (C6), label with sizes (C7), send images + last 10 turns + transcript to Claude, stream to end silently [lines 590-622].
5. Parse trailing `[POINT…]` (C9), map to global coords (C10), set `detectedElementScreenLocation` [lines 625-670].
6. Strip tag, store turn, speak via TTS, set `.responding` when audio starts [lines 684-706].
7. Overlay observes the location, runs flight (C17), bubble (C18), returns (C19); transient overlay fades (C20).

**Recovered rule.** The model is the locator. Output contract = spoken text + one machine tag at the very end. The app never trusts the model for anything but (x, y, label, screen); it clamps, scales and flips itself. Motion is driven by a hand timer during flight, by springs otherwise, so the two never fight.

---

## DATA MODEL (as built)

```
CompanionVoiceState      = idle | listening | processing | responding      [CompanionManager.swift line 18]
CompanionScreenCapture   { imageData(JPEG), label, isCursorScreen,
                           displayFrame, displayWidthInPoints, displayHeightInPoints,
                           screenshotWidthInPixels, screenshotHeightInPixels }   [CompanionScreenCaptureUtility.swift lines 15-120]
ConversationTurn         (userTranscript, assistantResponse)  ring buffer, max 10  [CompanionManager.swift line 692]
PointingParseResult      { spokenText, coordinate?, elementLabel?, screenNumber? } [CompanionManager.swift line 770]
BuddyNavigationMode      = followingCursor | navigatingToTarget | pointingAtTarget [OverlayWindow.swift line 91]
```
Nothing persists to disk except an onboarding-complete flag [`CompanionManager.swift` line 142].

---

## SPEC SEED · clean-room "point-at-it" companion (behavior only, no code reuse)

**Behavior**
- B1. Hold a global chord to talk; release to send. Cancel any running answer on new press.
- B2. On send, capture each display downscaled to a fixed long edge; mark the pointer's display as primary.
- B3. Ask the model for short spoken prose plus one trailing locator tag `{x,y,label,screen?}` or none.
- B4. App maps image pixels → display points → global coords; clamps to bounds.
- B5. Glyph follows the pointer with a short spring. On a locator, it flies an arc, faces travel, lands beside the target, shows a one-line bubble, holds, returns.
- B6. Answer audio starts before the "thinking" glyph clears. Errors fall back to on-device speech.
- B7. Overlay never takes focus or clicks.

**Inputs / outputs**
- In: hotkey events, mic PCM, display images, last N turns.
- Out: audio, overlay animation, a locator event `{display, point, label, ts}`.

**Edge cases**
- E1. Quick tap (press-release before recording starts) must not leave the waveform stuck [comment at `CompanionManager.swift` lines 527-531].
- E2. Locator on a non-pointer display → must carry screen id, else wrong monitor.
- E3. Retina vs non-Retina and mixed-scale multi-monitor; Y-axis flip.
- E4. Target at screen edge → clamp padding so glyph stays visible.
- E5. User moves the mouse mid-return → snap back to follow.
- E6. Screen-recording permission revoked mid-session → capture throws; must speak a fix, not hang.
- E7. Model returns malformed or no tag → treat as none.
- E8. Own overlay must be excluded from the capture.

---

## REBUILD PLAN · what we take for our product

Our product: a local Mac tool that watches for 7 days, finds repeated work, suggests automations with time saved, builds the workflow on approval, shows a dashboard. Apple-native feel.

**Take (pattern, rewritten from scratch)**
- T1. Menu bar only, non-activating panel, click-outside dismiss. Fits a quiet 7-day observer that should never sit in the Dock.
- T2. Cursor-adjacent glyph + arc flight to point at the step being automated during "show me how you'd do it" and during approval ("this is the field I will fill"). This is the best single "feels magical" moment in Clicky.
- T3. Locator contract: model returns a structured tag, app owns all geometry. Use it for annotating our suggestion cards with "here is where you repeat this".
- T4. Spinner-until-ready and cancel-on-new-input. Both make an agent feel responsive.
- T5. Transient overlay that fades in for one interaction and fades out 1 s after. Good default for suggestion nudges.
- T6. Reduce to one locator per answer. Keeps the UI legible.

**Do not take**
- D1. Their trigger model. We need an ambient, local, metadata-first observer; Clicky has none (C1-C4). Source our observer design from cua's Computer History privacy boundary (see 12-rea-cua.md) plus macOS Accessibility and NSWorkspace notifications.
- D2. Cloud STT/TTS and a key-holding proxy. We are local-first; use Apple Speech and AVSpeechSynthesizer or on-device models.
- D3. Sending transcripts and replies to product analytics (C25). Our privacy promise forbids it.
- D4. Dark-only custom palette (C22). Apple-native means system semantic colors, materials, light and dark, Dynamic Type.
- D5. Full-screen screenshots per turn as the main signal. For 7-day watching we store events, not pixels.

**Build order (smallest proof first)**
1. Menu bar shell + non-activating panel + permissions checklist (Accessibility, Screen Recording only if needed).
2. Overlay window per display, click-through, all Spaces; follow-pointer glyph honoring Reduce Motion.
3. Arc-flight-to-point primitive with locator input from a fixture, unit-tested geometry (scale, flip, multi-display, clamp).
4. Wire locator to suggestion cards: "you did this 14 times, here".
5. Only then any model call.

---

## TO CONFIRM

- TC1. Read rest of `worker/src/index.ts` `handleChat` to settle I4 (auth check or not).
- TC2. `BuddyDictationManager.swift` key-up finalization timing (how long after release before send).
- TC3. `CompanionPanelView.swift` panel width and permission UI copy, for the onboarding pattern.
- TC4. Whether `CompanionResponseOverlay.swift` is still used, since streaming text display is off (C13).
- TC5. Commit history (needs full clone) to date when proactive behavior, if ever, was removed or never existed.
