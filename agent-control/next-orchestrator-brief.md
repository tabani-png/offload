# Next orchestrator brief: Offload

- Updated: 2026-10-25 21:58 America/Toronto
- Repo: /Users/tabani/builds/offload (GitHub tabani-png/offload, private)
- Role: MANAGER. You dispatch, review, merge, report. You do not build. Report to the operator in ELI5 / plain short English.

## Mission
Offload: local Mac app + company control plane. Watches screens (masked, encrypted, 7 days), finds repeated work in ANY field,
and proposes the best KIND of fix per task (s22): automate as MCP/Composio/API workflow, build a custom tool, change setup
(e.g. IDE / coding-agent system), remove the step (e.g. auto LinkedIn post images), or leave alone. Dry-runs; commits only on
exact single-use approval. Stage 2 = company version (RBAC, CEO hours-saved dashboard, role-owned workflows, cloud workers, overnight).
Memory: offload-product-direction (incl. 2026-10-25 "not just outreach" pushback), offload-cindy-era-plan.

## State at handoff
- main = 9f46fdb: Stage 1 s01–s17 + S2-01..S2-04 + **S2-06 (PR #8, merged this session, verify PASS on main)**.
- Wave B review: `slices/S2-review/REVIEW-wave-B.md` on origin/integration-wave-b (all 6 wave-B PRs merged there, head 8e9134a).
- Design review 4: branch `design-review-4` (doc only, 3.7/5). Not merged (needs a review verdict; trivial doc).

### Open PRs and what each waits on
| PR | branch | state | next |
|---|---|---|---|
| #7 s18 name masking | s18-name-masking | cloud fix routine running | re-review → merge |
| #9 S2-05 ingest | S2-05-ingest-metrics | cloud fix running | re-review → merge |
| #10 S2-08 compliance | S2-08-compliance | cloud fix running (incl. 3 cross-slice fails, DELETE grant) | re-review → merge |
| #11 s19 playbook | s19-messaging-playbook | cloud fix running (ADR renumber → 0011) | re-review → merge |
| #12 S2-07 broker | S2-07-policies-broker | cloud fix running | re-review → merge |
| #13 UI round 5 | s10f-ui-round5 | reviewer said FIX FIRST (live "In use" for Gmail); fix commit f9dbf59 pushed; local agent was finishing snapshots + verify-all | if no PR comment from builder: finish it (see below), then re-review |
| #14 importer v2 | s21-importer-v2 | Codex review running → /tmp/codex-pr14.md | read verdict, act |
| (coming) S2-09, S2-10, S2-11 | stacked on integration-wave-b | cloud builders, DRAFT PRs | rebase onto main after wave B merges |
| (coming) s20-blind-fixes | s20-blind-fixes | cloud builder (induction/step typer/surface names/saving cap/routing) | review |
| (coming) s22-solution-designer | s22-solution-designer | cloud builder (solution kinds + outreach-bias audit) | review |
| (local) S2-13 Mac surfaces | S2-13-mac-company-surfaces (worktree ~/builds/.worktrees/offload-s213, at a2b9e49) | local Swift agent, stacked on s10f; likely paused for disk | resume as local agent when disk ≥ 2 GB |

Cloud routine trigger IDs (all connectors cleared): fixes #10 trig_01EfeA4cbwvwUjw5DG5e46Er, #9 trig_01YXn3CbobvrspASGJ5DeVGE,
#12 trig_01AUEbaA7FfWZzZXucB4MiFJ, #7 trig_01GMVQ1URC4kDfRWizKrf1BM, #11 trig_011H3RWGqkmdkbqLNy6Uzjiq; S2-09 trig_0118thtk1vEchWTc7xX4keZQ,
S2-10 trig_012V9xrRMRNdDBGXbPFScuYb, S2-11 trig_01UvExVN4b5giGmD5ja6CoXc; s20 trig_01SBcXqwRU6PWzD6m2Ev2EWV; s22 trig_014BdbUMSTRsTsu8pwhrfyZh.
Check with RemoteTrigger list_runs / get_run_log and `gh pr list -R tabani-png/offload`.

### Local jobs that were running (they die with the old session; check, then resume)
1. **Blind test v2** (32 days, 6,963 frames imported into scratch/blind-v2/home + work). Captioning via Claude Haiku had just been
   restarted. Check progress: on branch s21-importer-v2 (worktree ~/builds/.worktrees/offload-imp) run
   `bun run brain/tools/import-screenwatch.ts stats --work $V/work --home $V/home` with V=/Users/tabani/builds/offload/scratch/blind-v2.
   Resume: `OFFLOAD_ANTHROPIC_KEYCHAIN=offload.anthropic/api-key bun run brain/tools/import-screenwatch.ts caption --home $V/home
   --work $V/work --model claude --concurrency 8 --max-usd 15`, then `regroup`, `stats`.
   Then weekly-window analysis (main's brain only reads 7 days; fake-clock preload at scratch/blind-v2/tools/fakeclock.ts, scratch only),
   draft 6 workflows + dry-runs on latest week, and rank the best FIX KIND per top-15 task (Opus, ≤ +$3). Output scratch/blind-v2/RESULTS.md.
   Disk stop line for captioning: 500 MB. BLIND RULES: never read ~/builds/screenwatch/observations.md(.bak), notes/, daemon.log; never
   open raw screenshots; key from Keychain only, never printed. v1 results (7 days, failed: 79% one "reviewing" task) in scratch/blind-screenwatch/.
2. **PR #13 finisher**: fresh worktree on s10f-ui-round5 → `bash app/build.sh snapshot app/snapshots` → `bash scripts/live-captures.sh` →
   check e2e-review-approved + confirm shots → verify-all + slices/s10f-ui-round5/verify.sh → push → PR comment. Stop if disk < 700 MB.
   (A stale worktree ~/builds/.worktrees/offload-ui5 may exist; reuse or remove.)
3. **Codex review of PR #14**: running detached (`nohup codex exec review --base origin/main` in ~/builds/.worktrees/offload-codex-rev)
   → /tmp/codex-pr14.md. Note: `--base` cannot be combined with a custom prompt. Remove that worktree after.
4. **Cindy eval** (github.com/makecindy/cindy; operator wants: internal test first → then Eon Era → then into product): STOPPED.
   It installed 4 GB node_modules and filled the disk. ~/builds/cindy exists (node_modules deleted); ~/builds/cindy-eval/ empty; no REGISTRY row yet.
   Re-run as a CLOUD routine (no local disk): security read first, 3 safe outcome tasks, verdict USE / BORROW / SKIP. Add REGISTRY row.

## Next steps (in order)
1. Re-check what is still running (cloud runs, PR comments, local caches). Restart dead local jobs above.
2. For each fixed wave-B PR (#7 #9 #10 #11 #12): independent re-review (use **Codex** `codex exec review --base origin/main` in a
   detached worktree as the third-party critic; add a Claude reviewer for subtle security items), then merge in order
   S2-07, S2-05, S2-08, s18, s19. Run `scripts/verify-all.sh` and `scripts/verify-all.sh S2-` on main after. Then rebase S2-09/10/11 onto main.
3. PR #13 → re-review (screens need a Claude reviewer who looks at PNGs) → merge → rebase S2-13 → resume S2-13 local agent.
4. Review s20, s22, #14 PRs; then re-run the blind test on merged code.
5. Show the operator blind-test v2 RESULTS (top tasks + best fix kind + hours saved) and ask them to judge accuracy.
6. Then S2-12 security review + e2e (needs human counsel sign-off), then Stage 1 s15 (any-domain e2e).

## Merge permission
Operator said "allow merges" (2026-10-25). Rule added to ~/.claude/settings.json `autoMode.allow`: merges to main of tabani-png/offload are
allowed after an independent reviewer verdict MERGE and passing verify. Unreviewed merges are still blocked (verified). May need a restart to load.
If still blocked after a MERGE verdict, tell the operator; do not work around it.

## How to dispatch cloud builders
RemoteTrigger `create` (run_once_at ~2 min ahead UTC, env env_01ABkfk1X7yBKLnPRnV3CaUB, model claude-opus-5-5, source
https://github.com/tabani-png/offload), then IMMEDIATELY `update` {"clear_mcp_connections": true}. Prompt self-contained: branch, SPEC/verify
paths, frozen files, Bun 1.3.12 exact, Postgres 17, open PR do not merge, Co-Authored-By trailer, "GitHub Actions has no minutes", never fake a pass.
Never use Agent isolation "remote".

## Gotchas
- **DISK** is the bottleneck (~2 GB free at handoff; it hit 130 MB once). Local agents must check `df -h /` and stop at a set line.
  Never install big repos locally. ~/.bun/install/cache was deleted by the operator (bun re-downloads). Unknown other processes also
  consume disk. Never delete Capital Canada files, images or uv caches.
- Duplicate agents: old sessions may still run agents. Check `git worktree list` and `ps` before re-dispatching.
- Subagents sometimes cannot write report files; have them return text. If a subagent says it was denied and asks you to do it, ask the operator.
- `verify-all.sh` skips S2-* unless named. Its "only my paths" check compares to main, so stacked branches flag base files; judge by diff vs base.
- Contract amendments → new ADR in plan/stage-2/adr/.

## Open for the operator
- Rotate the Anthropic key (pasted in a chat once).
- Free more disk (Docker images ~2 GB reclaimable, macOS update snapshots).
- Pick a product name. Restore GitHub Actions billing (optional).
- Eon Era: ask before signing up. Other Build North perks (Clerk, Expo, SurrealDB, Render) not in the plan.
