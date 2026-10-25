---
id: s12-understanding
title: Understanding v2 - span descriptions, local embeddings, any-domain task induction, multi-domain fixtures
depends_on: [s03-brain-core, s04-insights, s11-perception (frame notes; a stub-captioner fixture stands in)]
parallel_safe: true
human_gated: false
verify: bash slices/s12-understanding/verify.sh
paths_in_scope: [brain/src/understanding/**, brain/src/analyze.ts, brain/src/types.ts, brain/src/grouping/group.ts (Labeler signature, additive), brain/src/insights/judge.ts (JudgeInput, additive), brain/src/api/dto.ts, brain/src/api/types.ts (additive), brain/src/cli.ts, brain/fixtures/gen-domains.ts, brain/fixtures/domains-report.ts, brain/tests/s12-understanding/**, brain/API.md, slices/s12-understanding/**]
paths_out_of_scope: [app/**, engine/**, packet/**, brain/src/connectors/** (read-only use), brain/src/workflows/**, brain/src/vision/** (s11), brain/fixtures/gen.ts, schemas/**]
---

# s12-understanding

## Summary
ADR 0007: Offload must find repeated, time-heavy work in any field. v1 grouping (`grouping/group.ts`) keys tasks on
app/host rules with fixed categories, so most non-email work lands in `browse`/`other` and a task that spans two apps
(PDF -> Xero, sheet -> LinkedIn) is cut in half. v2 writes its own internal description of every span, embeds it
locally, and induces task profiles Task-Model-Induction style (arXiv 2608.20319): step clusters, links between steps by
shared item identifiers and by strong step-to-step transitions, a daily global merge, and a loop model per task
(which steps repeat per instance). v2 is behind `--understanding v2`; v1 stays the default until s15 flips it.
ADR 0005 holds: every number is deterministic arithmetic over events and carries evidence ids. Models (a description
refiner, a Labeler, a Judge) only ever see masked text profiles and never produce a time or saving figure.

## Acceptance criteria (each is a test in brain/tests/s12-understanding)
- AC-1 FRAMES: `FrameNote` follows `schemas/frame-note.schema.json` (validator driven by the schema file: required,
  additionalProperties false, maxLength, maxItems, confidence 0..1). Frame notes are read from store events of kind
  `frame` (s11) and, until s11 lands, from a fixture sidecar `frames/<day>.jsonl` or `frames/<day>.jsonl.enc`
  (encrypted with that day's key, so it is unreadable once the key is purged; days older than 7 local days are
  refused). Invalid notes are counted, never used. Notes attach to the span whose time range holds them (same app).
- AC-2 DESCRIBE: each span gets a `SpanDescription` {activity, verb, object, counterpart, surface, step, identifiers,
  surfaceKey, category (rule feature), source frames|rules, frameIds, eventIds, text}. Frame fields win by
  confidence-weighted vote; without frames the description is composed from focus/title/url/input counts/OCR. Same
  input, same output. The user's own addresses are never identifiers. `text` (the internal prompt that is embedded)
  is masked and carries no identifiers. A `DescriptionRefiner` may rewrite activity/verb/object/step only; it cannot
  change identifiers, ids or times, and malformed output is ignored.
- AC-3 EMBED: `Embedder` interface; `StubEmbedder` is deterministic and unit-norm (identical text -> cosine 1);
  `OllamaEmbedder` calls `POST /api/embed` on 127.0.0.1:11434 (default `qwen3-embedding:0.6b`, `bge-m3` allowed),
  refuses any non-loopback base URL before a request is made, batches, caches by text and rejects malformed replies.
  A live Ollama test runs only with `OFFLOAD_TEST_OLLAMA=1`.
- AC-4 INDUCE: descriptions are assigned to step clusters by embedding similarity + surface + verb/object (new
  cluster when nothing fits), with a global merge after each day. Steps link into one task when they share item-level
  identifiers (an identifier on few spans) or when one reliably follows the other. Instances split on conflicting
  identifiers, on a new day or a long gap, and when the task's start step recurs (loop model). Each profile keeps a
  goal summary, its steps (share of instances containing the step, repeats per instance, mean position), the loop
  (core steps in order), the start step, instance boundaries, identifiers (item count + container ids) and evidence
  span ids. Rule categories are features only. Deterministic ids.
- AC-5 INSIGHTS: v2 tasks go through the existing stats, ranking and saving code unchanged. `reach` is
  domain-neutral: per surface, a catalog connector (`connectors/catalog.ts`, read-only) or a local file read (0.8) or
  the computer-use last resort (0.35); task reach = active-time-weighted mean. Custom `Labeler` and `Judge`
  implementations keep working in v1 and v2; the defaults in v2 are the understanding labeler/judge.
- AC-6 CONTEXT: optional user context `{role, industry}` (onboarding, s14) is sanitised (one line, <= 80 chars each)
  and passed to the Labeler (second argument) and Judge (`input.user`) and into the prompt builders inside a marked
  context block only. With the default labeler/judge it changes no number.
- AC-7 FIXTURES: `brain/fixtures/gen-domains.ts` (gen.ts untouched) writes 7 local days for personas recruiter (CVs ->
  Greenhouse), bookkeeper (invoice PDFs -> Xero), support (Zendesk tickets with macros, Shopify order lookups),
  salesops (lead rows in a sheet enriched from LinkedIn) and mixed (Xero invoices + Zendesk tickets), with meetings,
  Slack, mail and browsing as noise, frame notes for every span, and `truth.json` (top task, planned share,
  instances, focus labels). Deterministic by seed; plain and encrypted stores give identical analyses.
- AC-8 KNOWN-ANSWER: for each persona under v2 the top insight is the ground-truth top task, its share is within
  +-3 points of ground truth, its instance count within +-10%, every evidence id resolves, and its label is not email.
  The founder week (gen.ts) under v2 still ranks `email.outreach` first. In the mixed persona the top two insights are
  the two real tasks, in different apps. Grouping agreement (time-weighted purity, inverse purity, F) >= 0.9 per
  persona under v2; `brain/fixtures/domains-report.ts` prints v1 vs v2.
- AC-9 WIRING: `analyze` and `serve` take `--understanding v1|v2` (default v1) and `--embedder stub|ollama` (v2 only,
  default stub). v1 output for the founder fixture is identical to before this slice (golden hash). Documented in
  `brain/API.md`. InsightDTO gains an optional `understanding` block (additive).

## Out of scope
The vision Captioner and frame storage in the engine (s11), connector chain (s13), workflow builder for any profile
and the onboarding step that collects role/industry (s14), flipping the default to v2 (s15).

## Verify
`bash slices/s12-understanding/verify.sh`: runs `bun test tests/s12-understanding` (>= 40 tests, 0 failures),
`bunx tsc --noEmit`, generates every persona with the real script (encrypted), runs the real CLI with
`--understanding v2` and checks each persona's #1 from its output, checks v1 still ranks outreach #1 on the founder
fixture, prints the agreement report, and checks that no out-of-scope path changed since the base commit.
