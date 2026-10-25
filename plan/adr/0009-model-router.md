# 0009 Model router: Claude by default, the right tier per route

Date: 2026-10-25. Status: accepted (operator decision, s14). Note: s13 planned an ADR 0008 for the
`@anthropic-ai/sdk` dependency; this ADR also records that dependency (1.3.0, already in the lockfile as the Agent
SDK's peer). If s13 lands its own 0008, renumber one of them on merge.

## Context
Offload makes three kinds of model calls: understanding (what a repeated task really is, how a workflow should be
built), execution (drafting outputs, running steps, tool and computer-use steps) and high-volume repeatable work
(screen captions, description refinement, classification, per-item steps that are already proven). One model for all
of them is either too slow and costly or not careful enough. Ollama alone cannot design workflows well.

## Decision
1. Every model call goes through `brain/src/models/router.ts` (`RoutedModel` implements the existing `Model`).
   Routes and tiers: Opus 5.5 (`claude-opus-5-5`, adaptive thinking, effort high) for understand, design, choose
   (wording only; the choice itself is deterministic, ADR 0005) and explain; Sonnet 5.5 (`claude-sonnet-5-5`) for
   execute, draft and first runs of item steps; Haiku 5.5 (`claude-haiku-5-5`) for caption, refine, classify and
   proven item steps.
2. Ladder: Haiku -> Sonnet -> Opus on refusal, a cut-off reply or a failed check (`validate`); each step up keeps a
   short reason. A per-item step moves Sonnet -> Haiku after 5 clean runs and back on any user edit, failed check or
   refusal (`model-router.json`).
3. API backend (`models/api-backend.ts`, official SDK): system prompt cached (ephemeral), effort per route,
   server-side `fallbacks: "default"` on Opus 5.5 and Sonnet 5.5, stop_reason handled before content, typed errors in
   plain words, only https://api.anthropic.com (host-guarded fetch). Key from ANTHROPIC_API_KEY or a Keychain
   reference (OFFLOAD_ANTHROPIC_KEYCHAIN=service/account), never logged or stored by Offload.
4. Cost: tokens and $ per route and model in `model-usage.json` (no content), GET /status `models` and GET
   /models/usage. Monthly budget (`models.json monthlyBudgetUsd` or OFFLOAD_MONTHLY_BUDGET_USD): at 80% captions move
   to local Ollama; at 100% other paid routes stop with a needs-you line.
5. No key: the Claude Code login (Agent SDK, unmetered) still drafts, with a needs-you line "Add a Claude key";
   captions and embeddings use local Ollama. `--model stub` routes through the deterministic stub.
6. Numbers stay code (ADR 0005); commits stay gated (ADR 0006); the router never opens a gate.

## Consequences
- The advisor tool (Sonnet executor with an Opus advisor) is a later option for execution steps that hit judgement;
  not used yet.
- Tests use stubbed HTTP or fake backends only; verify.sh makes no real API call.
