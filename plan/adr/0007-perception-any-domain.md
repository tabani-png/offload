# 0007 Perception: understand the screen, any domain

Date: 2026-10-25. Status: accepted (operator direction).

## Context
Operator: email outreach is one example of a million. Offload must understand what is on screen all the time,
write its own internal descriptions ("internal prompts") of what the user is doing, and find repeated work in
any field. Onboarding may ask the user's field/industry for context, and nothing more.
v1 recognised tasks mostly by app/host rules (`brain/src/grouping/group.ts` categories), so non-email work
landed in "browse"/"other" and could not be named or automated.

## Decision
1. Engine keeps a masked, downscaled keyframe on screen change (perceptual hash, existing OCR-on-change trigger),
   encrypted in the day store, deleted with the 7-day purge. Exclusions and masking apply before anything is kept.
2. A local vision model describes each keyframe (Ollama on the Mac; model chosen by s11 research, swappable).
   Output is a structured Frame note: activity, app surface, object, counterpart, step, inputs seen, outputs made,
   confidence. Raw images never leave the Mac.
3. The brain turns frame notes + focus/input events into span descriptions, embeds them locally
   (qwen3-embedding / bge-m3 via Ollama), and groups them into task profiles across any domain (Task Model
   Induction style: profiles with identifiers, embedding + shared identifiers, daily merge). The app/host rules
   stay as features, not as the only signal.
4. Claude (Sonnet for cheap steps, Opus for workflow design) sees only masked text profiles, never images, to name,
   score and design workflows. Numbers stay deterministic (ADR 0005).
5. Onboarding adds one optional step: role + industry (free text + suggestions). It is stored as user context and
   passed to labeling, scoring and workflow prompts. Nothing else is asked.
6. Connectors resolve by a chain per app: official/known MCP -> Composio toolkit -> direct API -> computer use
   (cua-style, with the Clicky pointer) as last resort. Every path goes through the approval gate (ADR 0006).

## Consequences
- Stub Captioner and stub embeddings keep tests deterministic and offline.
- New fixtures: several domains (e.g. recruiting, bookkeeping, sales ops, support), not just outreach.
- Cost: local inference on Apple Silicon; frames are throttled and deduped.
