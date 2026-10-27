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
   encrypted in the day store, deleted with the retention purge (7 days then; 30 days since ADR 0016). Exclusions and masking apply before anything is kept.
2. A local vision model describes each keyframe (Ollama on the Mac; model chosen by s11 research, swappable).
   Output is a structured Frame note: activity, app surface, object, counterpart, step, inputs seen, outputs made,
   confidence. Images are masked by the engine before anything reads them. With the local captioner they stay on
   the Mac; with the Claude captioner (opt-in, or `auto` when the user's own Anthropic key is configured, ADR 0009)
   the masked frame goes only to the user's own Anthropic account at api.anthropic.com, never to another host.
3. The brain turns frame notes + focus/input events into span descriptions, embeds them locally
   (qwen3-embedding / bge-m3 via Ollama), and groups them into task profiles across any domain (Task Model
   Induction style: profiles with identifiers, embedding + shared identifiers, daily merge). The app/host rules
   stay as features, not as the only signal.
4. Claude names, scores and designs from masked text profiles through the model router (ADR 0009); the only images it
   may see are masked keyframes sent to the user's own account by the Claude captioner (point 2). To name,
   score and design workflows. Numbers stay deterministic (ADR 0005).
5. Onboarding adds one optional step: role + industry (free text + suggestions). It is stored as user context and
   passed to labeling, scoring and workflow prompts. Nothing else is asked.
6. Connectors resolve by a chain per app: official/known MCP -> Composio toolkit -> direct API -> computer use
   (cua-style, with the Clicky pointer) as last resort. Every path goes through the approval gate (ADR 0006).

## Consequences
- Stub Captioner and stub embeddings keep tests deterministic and offline.
- New fixtures: several domains (e.g. recruiting, bookkeeping, sales ops, support), not just outreach.
- Cost: local inference on Apple Silicon; frames are throttled and deduped.

## Revision 2026-10-25 (s14, operator)
Screens may be read by Claude on the user's own Anthropic account (Haiku 5.5 by default, router route `caption`),
after the engine's masking, only to api.anthropic.com, with token use and cost shown in GET /status. Ollama stays the
offline and no-key fallback, and the router moves captions back to it when the monthly budget is nearly spent.
