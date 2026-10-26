# Next orchestrator brief: Offload

- Updated: 2026-10-25 19:40 America/Toronto
- Repo: /Users/tabani/builds/offload (GitHub: tabani-png/offload, private)
- Role: you are the MANAGER. You do not build. You dispatch builders (cloud routines first, local agents only for
  Mac-only work), review with independent critics, merge to main, push, and report to the operator in ELI5 plain words.

## Mission
Offload is a local Mac app plus a company control plane. It watches screens (masked, encrypted, kept 7 days) and finds
repeated work in any field. It designs MCP/API-first workflows using the best tool for each job, connecting through
MCP → Composio → API → computer use, with Composio covering 1,651 toolkits. It dry-runs them and commits only on exact,
single-use approval.
- Stage 1: one person on one Mac.
- Stage 2: the company version. RBAC, a CEO hours-saved dashboard, role-owned workflows with continuity, cloud workers
  and an overnight mode.
- Product direction is in memory: offload-product-direction.

## State now
- **main**: Stage 1 s01–s17 merged and green; verify-all 25/25 at last run. Brain has 1,137 tests.
  - S2-01, S2-02, S2-03 and S2-04 are merged and their verifies pass.
  - Local main may be ahead of origin: efadf78, the screenwatch importer. Push it.
- **Open PRs**: #7 s18 name masking, #8 S2-06 registry, #9 S2-05 ingest+metrics, #10 S2-08 compliance,
  #11 s19 messaging playbook, #12 S2-07 policies+broker. The cloud builders finished all six.
- **Possibly still running when you start**, as local agents from the previous session. Check the files they write:
  1. Wave B review + integration → `slices/S2-review/REVIEW-wave-B.md` and branch `integration-wave-b` on origin.
     If absent, re-run: an independent reviewer that verifies each PR alone, merges all six on an integration branch,
     runs `scripts/verify-all.sh` plus `scripts/verify-all.sh S2-`, then writes the review.
  2. Design review 4 → `slices/s10-review/DESIGN-REVIEW-4.md`. Target is ≥4.5 per screen; then a fix round.
  3. Blind test on the operator's screenwatch data → `scratch/blind-screenwatch/REPORT.md`.
     Blind rules: never read screenwatch observations.md, notes or daemon.log. Images stay masked. The Claude key is
     in the Keychain as `offload.anthropic/api-key`; pass it as OFFLOAD_ANTHROPIC_KEYCHAIN. Never print the key.

## Next steps (in order)
1. Push main. Read REVIEW-wave-B.md. Merge the PRs marked MERGE (via `integration-wave-b` or one by one with
   `merge --no-ff`), run verify-all (stage 1 and S2-), push. Send FIX FIRST items back to the cloud as fix-round routines.
2. Start wave C as cloud routines:
   - S2-09 cloud workers + overnight
   - S2-10 continuity
   - S2-11 dashboard wiring
   - S2-13 Mac company surfaces. This one is Swift/app work, so run it as a local agent.

   Then S2-12 security review + e2e (needs human counsel sign-off), then Stage 1 s15 (any-domain e2e).
3. After DESIGN-REVIEW-4: one UI fix round as a local agent (app is Swift and needs macOS). Include the MCP server
   "this will download and run code" confirm dialog from s17's risks.
4. Show the operator the blind-test REPORT: top tasks, workflows, cost and caveats. Ask them to judge accuracy.

## How to dispatch cloud builders
Use the RemoteTrigger tool, loaded via ToolSearch.
- `create` with `run_once_at` about 2 minutes ahead (UTC from `date -u`).
- Environment `env_01ABkfk1X7yBKLnPRnV3CaUB`, model `claude-opus-5-5`.
- Source `https://github.com/tabani-png/offload`.
- Prompt must be self-contained: branch name, slice SPEC/verify paths, frozen files, Bun 1.3.12 exact
  (`curl -fsSL https://bun.sh/install | bash -s bun-v1.3.12`, lockfileVersion 1), Postgres 17, "open PR, do not merge",
  commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, "GitHub Actions has no minutes; red CI
  without a runner is expected", "never fake a pass".
- IMMEDIATELY after create: `update` with `{"clear_mcp_connections": true}`. Create attaches ALL of the operator's
  connectors (Gmail, Xero, ...) by default.
- Check progress with `list_runs` and `gh pr list -R tabani-png/offload`.
- Agent `isolation: "remote"` does NOT go to the cloud here; it runs locally in the wrong repo. Do not use it.

## Gotchas
- **Disk** is about 4 GB free. Use at most one local worktree at a time and remove it after. Never delete Capital
  Canada files, images or uv caches (a CC server holds the uv lock).
- After merges, app snapshots go stale against source mtimes. Fix with `bash app/build.sh snapshot app/snapshots`,
  then `bash scripts/live-captures.sh`, with the screen unlocked.
- `verify-all.sh` skips S2-* unless named (`scripts/verify-all.sh S2-`). Contract amendments go in
  `plan/stage-2/adr/0111-*`; add a new ADR for new ones.
- Never send email or commit to real accounts in tests. The operator approves sends; the gate enforces exact
  single-use approval.

## Decisions already made (do not re-ask)
- Hosted multi-tenant control plane.
- Working-time and per-person views off by default, with notice.
- WorkOS for identity. Managed Agents for cloud workers.
- Claude by default via the router (Opus designs, Sonnet executes, Haiku repeats and captions); Ollama is the fallback.
- MCP-first, best tool per job. Composio for connections. Drafts are allowed writes; launching a campaign is the
  user's action.
- Messaging playbook: keep the message and patterns, not personal details.
- ADR 0111: PKCE loopback enrollment, dept-lead summaries, forward-only consent, approvers-only visibility.

## Open for the operator
- Rotate the Anthropic key after the blind test; it was pasted into a chat once.
- Pick a product name.
- Restore GitHub Actions billing (optional; CI is set up in .github/workflows/ci.yml).
- Human steps for a real run: Mac permissions, Composio Gmail with an `always_allow` account, tone blind test.
