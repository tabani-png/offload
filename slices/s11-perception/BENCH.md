# s11 captioner bench (2026-10-25)

Machine: Apple M4 Pro, 48 GB, macOS 26, Ollama 0.30.8. Harness: `bench/bench.ts` (the real `OllamaCaptioner`,
the real prompt, `maskFields` applied, loopback only). Images: 11 screenshots, 1440x900 PNG converted to JPEG q60
with a 1280 px long edge (what the observer keeps): 7 rendered web UIs from `bench/pages/` (an accounting app bill
entry, a CRM deal list, a helpdesk ticket, a spreadsheet, a code editor with a failing test, a recruiting scorecard,
an email compose) and 4 Offload app snapshots (`app/snapshots/dashboard-light`, `card-light`, `review-1280-dark`,
`onboarding-permissions-light`). Raw per-image output: `bench/results-qwen3-vl-2b-instruct.json`.

Tags: CONFIRMED = measured here; INFERENCE = reasoned from cited sources, not measured here; UNKNOWN = not known.

## Decision
- Default: `--vision-model auto` = the best pulled of `qwen3-vl:8b-instruct` > `qwen3-vl:4b-instruct` >
  `qwen3-vl:2b-instruct` (then the non-instruct tags). On this Mac today that resolves to `qwen3-vl:2b-instruct`,
  the only one pulled. Recommended once disk allows: `ollama pull qwen3-vl:8b-instruct` (6.1 GB).
- Why Qwen3-VL instruct: the strongest Ollama-native family on GUI screenshots at small sizes (ScreenSpot 0.944 for
  8B and 0.940 for 4B Instruct; Qwen2.5-VL 7B 0.847) [INFERENCE: llm-stats.com/benchmarks/screenspot and
  llmboard.ai ScreenSpot leaderboards, Oct 2026]; official Ollama library tags with vision + JSON schema `format`
  [CONFIRMED: `ollama show qwen3-vl:2b-instruct` lists vision; 11/11 replies parsed against the schema]. The
  `-instruct` tags avoid thinking-token burn reported for Qwen3-VL thinking mode [INFERENCE: danielrosehill
  Gemma-4-Benchmarks-0426, "Qwen's thinking mode is a liability"]; we also send `think: false`.
- Considered: Gemma 4 E4B (9.6 GB, faster TTFT, good structured JSON) [INFERENCE: same source] - larger download, no
  GUI grounding numbers found [UNKNOWN]; InternVL 2.5/3.5 8B (said to be strong on UI) - community GGUF only
  [INFERENCE: promptquorum.com 2026 guide]; Moondream 2 - too weak on dense text [INFERENCE: same guide].
- Why not benchmarked bigger: the disk had 0.9 to 3 GB free during this slice (`df`, CONFIRMED), so only the 1.9 GB
  2B model could be pulled. The 4B (3.3 GB) and 8B (6.1 GB) numbers below are not measured [UNKNOWN on this Mac].

## Results, qwen3-vl:2b-instruct (Q4_K_M, 1.7B + 0.4B projector)
| measure | value | tag |
|---|---|---|
| schema-valid notes | 11 / 11 (after `coerceFields`; no retry needed) | CONFIRMED |
| latency, first image (includes model load) | 9.4 s | CONFIRMED |
| latency, warm, median / max of the other 10 | 3.9 s / 4.5 s | CONFIRMED |
| latency, warm, pipeline smoke (worker, 3 frames) | 5.7 s total, last caption 1.4 s | CONFIRMED |
| resident memory while loaded | 2.1 GB, 100 % GPU (`ollama ps`) | CONFIRMED |
| activity names the right work (keyword check per image) | 9 / 11 | CONFIRMED |
| identifiers include the visible record id / file / domain | 5 / 6 images that have one | CONFIRMED |
| person names in `counterpart` (before the `<name>` mask) | 2 / 11 (now masked) | CONFIRMED |
| person names in `inputs` (not masked) | 1 / 11 in the final run, 1 / 3 in the smoke | CONFIRMED |
| GPU time at the default throttle cap (60 frames/h) | about 4 min per hour (7 %) | INFERENCE (60 x 4 s) |

Quality notes (CONFIRMED from the raw output):
- Good: code editor ("writing test code ... testing a reconcile function", ids `reconcile.test.ts`), spreadsheet
  ("calculating a total budget using a formula", `SUM(C<n>:N<n>)`), helpdesk ("reading and responding to a support
  request", `#<n>`, `Order #A-<n>`), recruiting (`jordan-mehta-cv.pdf`), the Offload app screens.
- Weak: verb defaults to "reviewing" when the user is entering data (bill entry, CRM edit), even with the explicit
  rule in the prompt; `surface` sometimes repeats the app name only; `identifiers` sometimes carries headings with
  digits ("Saves <n> h a week").
- The first prompt draft let the model copy example text (`"<app> <view>"`, a list of id kinds); the shipped prompt
  avoids copyable examples, and `coerceFields` drops identifiers without a digit or id punctuation.

Expected with 8B (INFERENCE from the leaderboards and the June 2026 r/LocalLLaMA M2 Max run: 6.1 GB, about 43 tok/s,
1.4x the 4B time per image): better verbs and fewer copied labels, roughly 2 to 3 times the 2B latency on this Mac
(about 8 to 12 s warm per frame), still inside the 60 frames/hour budget. Not measured [UNKNOWN until pulled].

## How to re-run
```bash
ollama pull qwen3-vl:8b-instruct          # when disk allows
# screenshots of bench/pages/*.html at 1440x900 + app snapshots into /tmp/s11-bench/*.png, then:
bun run slices/s11-perception/bench/bench.ts qwen3-vl:8b-instruct /tmp/s11-bench /tmp/s11-bench/8b.json
```
