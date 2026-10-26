---
id: s24-brief-runner
title: Brief runner - build a tool / setup / remove_step brief in a sandboxed workspace until frozen acceptance checks pass (dry run)
depends_on: [s22-solution-designer (BriefSpec, briefs, approval rules), s14 (model router), s05 (approval gate rules, ADR 0006), ADR 0004 (Agent SDK)]
parallel_safe: true (with s20-blind-fixes: disjoint files)
human_gated: false
verify: bash slices/s24-brief-runner/verify.sh
paths_in_scope: [brain/src/builder/**, brain/tests/s24-brief-runner/**, slices/s24-brief-runner/**, brain/API.md, brain/src/cli.ts (build command), brain/src/models/model.ts (role build_checks), brain/src/models/router.ts (ROLE_ROUTES entry), brain/src/solutions/types.ts (additive SolutionOption.build), brain/src/solutions/routes.ts (build routes seam + build cost on GET solutions)]
paths_out_of_scope: [engine/**, packet/**, schemas/**, app/**, brain/tools/import-screenwatch.ts, brain/src/understanding/{induce,embed}.ts, brain/src/plan/steps.ts, brain/src/insights/saving.ts, brain/src/store/vault.ts, brain/src/connectors/{chain,targets}.ts (s20-blind-fixes), brain/src/workflows/{gate,allowlist,executor,batch,runner,chain-executor}.ts]
---

# s24-brief-runner

## Summary
s22 turns a repeated task into a brief (`BriefSpec {inputs, outputs, runsWhere, builderPrompt, acceptance[]}`) for
kinds tool / setup / remove_step. Nothing builds it or checks it. The operator wants OUTCOME-based fixes: done means
the checks pass, not "the model says done". The Cindy eval (PR #20, `adam/memory/research/cindy-eval/EVAL.md`)
found the plain Agent SDK passes small briefs in one try at about $0.10, and recommended BORROW: our own outcome
loop around `query()`, with Cindy's container-only bypass rule, run digests, usage per run and telemetry-off env.

## Design (`brain/src/builder/`)
1. **Checks first, frozen (CHECKS)** - `checks.ts`. Before any build a separate model call (role `build_checks` ->
   router route `draft`, Sonnet) turns the `acceptance` strings into one executable check script, `accept.py`
   (python3) or `accept.test.ts` (bun test). The reply is JSON `{file, content}`; a bad file name, an empty or
   over-long script or anything that is not JSON is refused. Stored at `solutions/<id>/checks/<file>` (0600) with
   `checks.json {briefHash, file, sha256, model, createdAt}` and shown in `solutions/<id>/BUILD.md` (the brief plus
   the script) for approval. The text sent to the model goes through a `mask` hook (TODO s18: names masking is not on
   this base; the hook is identity and tested to be applied).
2. **Gate (GATE)** - `approval.ts`. Same rules as the s05 / s22 gate (ADR 0006): `approveBuild(briefHash,
   checkHash)` only for the exact current brief content hash (file intact) and the exact current check-script sha256
   (file intact); it mints a single-use token (only its sha256 is stored). `runBuild(token)` consumes it once; a
   reused, wrong or missing token, a stale brief hash, a check hash that is not the current one, or a check file
   changed after approval is refused before any workspace exists.
3. **Builder loop (LOOP, CAPS)** - `runner.ts`. Fresh workspace `builds/<run_id>/workspace` (0700) holding the
   frozen check under `accept/` (0444). Each try is one Agent SDK `query()` (ADR 0004, no new deps) with the
   builder prompt, inputs, outputs and the check's path; on a retry the exact (truncated) failure output of the
   previous check run is appended. Then the RUNNER (code) runs the check: exit 0 = PASS. Caps: `maxTries` (3),
   `maxUsd` ($1, also passed as the SDK's `maxBudgetUsd` for the remainder), `maxTurns` per try (30), `wallMs`
   (10 min, AbortController). Stops on PASS or a cap.
4. **Sandbox (SAFETY)** - `sandbox.ts`. Tools: Read, Write, Edit, Glob, Grep, Bash; network and agent tools
   (WebFetch, WebSearch, Task, ...) disallowed. Bash only for an allowlist of commands (python3, bun test/run, node,
   ls, mkdir, mv, cp, cat, head, tail, wc) with no shell operators; every path must stay inside the workspace; no
   write or edit under `accept/`. `assertSafeExecutionProfile` (from Cindy): `bypassPermissions` is refused unless
   the profile says container sandbox (`OFFLOAD_BUILDER_SANDBOX=container`); on a user Mac the mode is `default`
   with the allowlist as `canUseTool` and a PreToolUse hook. Settings sources off, no MCP servers, cwd = workspace.
   Subprocess env: an allowlist plus `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`.
5. **Tamper (TAMPER)** - after every try the check file's sha256 is compared with the approved one before it runs;
   a change = outcome TAMPER, the run stops.
6. **Run record (RECORD)** - `record.ts`. `builds/<run_id>.json`, written once (never overwritten) plus a line in
   `builds/runs.jsonl`: brief id + hash, check hash + file, models (check writer, builder, reported), SDK version,
   claude binary version, profile (mode, tools, bash allowlist, limits), tries [{n, turns, costUsd, tokens,
   checkExit, checkOutput (truncated 4k), ms}], totals (tokens, cost), wall ms, outcome PASS | FAIL | CAP | TAMPER,
   capReason, artifact path. DRY RUN: files stay in the workspace; installing is a separate approval (out of scope).
   `SolutionOption.build?` (additive) carries the latest run's `{runId, outcome, costUsd, tries}` on
   `GET /insights/:id/solutions` so hours saved vs cost can be shown.
7. **Surfaces (CLI, API)** - CLI `build --solution N|ins_ID --option n --home DIR` (writes the brief if needed and the
   checks, prints both hashes), `build approve --brief sol_ID --brief-hash H --check-hash C`, `build run --brief
   sol_ID --token T` (dry-run build), `build record --run run_ID`. API: `POST /solutions/:id/checks`,
   `POST /solutions/:id/build/approve {briefHash, checkHash}`, `POST /solutions/:id/build {token}`,
   `GET /builds/:runId`. Additive only.

## Acceptance criteria (tag = test name prefix in brain/tests/s24-brief-runner/)
- CHECKS: recorded check-writer reply through a fake backend at the router boundary (role build_checks, Sonnet) ->
  script + sha256 on disk + BUILD.md; bad replies refused; mask hook applied to the prompt.
- LOOP: pass on try 1; fail then pass on try 2 with the exact failure text fed back in the second prompt.
- CAPS: cap after N failing tries; cost cap stops before the next try.
- TAMPER: the builder editing the check file -> TAMPER, and the allowlist denies writes under accept/.
- GATE: no build without approval; approval for a different check hash rejected; token single use; check file
  changed after approval refused.
- SAFETY: no network tool allowed; bash allowlist; paths outside workspace denied; bypass refused off-container;
  env has the telemetry flags.
- RECORD: record written once with every field; option build cost field.
- CLI / API: real CLI prepare -> approve -> run with a fake SDK (env hook for tests only), and GET record.
- LIVE (optional): runs a tiny brief for real only when ANTHROPIC_API_KEY is set, otherwise skipped (never faked).

## Verify
`bash slices/s24-brief-runner/verify.sh`: typecheck; the s24 suite (>= 20 tests) with every tag present and
passing; the full brain suite; no commit since BASE touches an out-of-scope path.
