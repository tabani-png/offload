# Rework ledger — agentic team closed loop

Append-only. One row when a review **blocks**, a babysitter **re-dispatches**, or Tier-1 **re-routes** after fail. Not for operator taste/creds (those stay in `human-queue.md`).

Goal: builder → review → rework becomes **system patches** (skills, SPEC/HANDOFF, gates), not only fixed slices.

## Classes (pick one)

| class | meaning |
|---|---|
| `spec_gap` | SPEC/HANDOFF underspecified or ambiguous |
| `truth_drift` | Wrong live state / stale context / ignored schema truth |
| `scope_creep` | Built past done-when / out of scope |
| `gate_skip` | Claimed done without green verifier / skipped tests |
| `contract_mismatch` | Wrong API, schema, or cross-repo assumption |
| `taste` | Operator standard reject (rails may have been fine) |
| `infra` | Env, secrets, managed Postgres, OAuth — not agent competence |
| `review_fp` | Reviewer wrong; note so we don't overfit |
| `verify_fp` | Done-signal tooling false failure (e.g. scope check); fix the gate once, not each slice |

## Ledger

| date | slice_or_pod | stage | class | one_liner | system_fix |
|---|---|---|---|---|---|
| 2026-10-25 | s18 PR #7 | orchestrator | spec_gap | names masked case-sensitively for single words; cue names dropped by common-word filter (Codex P1 + Claude) | none (candidate: masking SPEC must list casing/unicode/cue cases) |
| 2026-10-25 | s19 PR #11 | orchestrator | spec_gap | lowercase known identities leak; removed playbook not detected by auto-run pin (Codex P1 x2) | none (same class as s18: casing) |
| 2026-10-25 | S2-07 PR #12 | orchestrator | spec_gap | widening restarts dry run but queued auto-approved items still send; member can create preapproved policy bypassing approvers (Codex P1 + Claude HIGH) | none |
| 2026-10-25 | S2-05 PR #9 | orchestrator | spec_gap | run dedupe after filters; review events not bound to run owner (Codex P2 + Claude MED) | none |
| 2026-10-25 | S2-08 PR #10 | orchestrator | spec_gap | notice publish accepts missing required sections; concurrent ack -> 500 (Codex P2 x2) | none |
| 2026-10-25 | s21 PR #14 | orchestrator | spec_gap | regroup merges null-key first frame; events-orig stale after re-import (Codex P2 x2) | none |
| 2026-10-25 | S2-07 PR #12 | orchestrator | spec_gap | round 3: person identity over company connection skips ownership; frozen runner can still send after new approval (Codex P1 x2) | candidate: send-path invariant checklist enforced at execute, in S2 SPEC template |
| 2026-10-25 | s18 PR #7 | orchestrator | spec_gap | round 3: known contact parts not registered without full name (Codex P1) | candidate: table-driven leak suite through router egress as standard for masking slices |
| 2026-10-25 | S2-05 PR #9 | orchestrator | spec_gap | round 3: anomalies leak for suppressed groups; rate limit dedupes updates (Codex P1+P2) | none |
| 2026-10-25 | s19 PR #11 | orchestrator | spec_gap | round 3: bracketed identities exempt; playbook loader trusts shape (Codex P2 x2) | same class as s18 |
| 2026-10-25 | S2-08 PR #10 | orchestrator | spec_gap | round 3: self-view hours saved always zero (Codex P2) | none |
| 2026-10-26 | s22 PR #17, s24 PR #21, S2-13 PR #22 | orchestrator | verify_fp | verify.sh scope check false-failed after the branch merged origin/main: `git diff "$BASE"...HEAD` with a fixed BASE counts every file main changed since BASE; managers cleared it by hand each time (s24: 226 files counted, 31 its own) | scripts/lib/slice-changes.sh (net diff vs merge-base with origin/main; SLICE_GREP mode adds --remerge-diff) used by every slice verify.sh and S2-common; rule in docs/adam-rules.md and docs/adam-folder-contract.md |
| 2026-10-26 | s31 PR #38 | orchestrator | success reported without checking the side effect | ObserverAgent.remove deleted the plist and reported off when `launchctl bootout` failed with the agent still loaded (Codex P2) | remove() checks `launchctl print` after a failed bootout; keeps the plist and throws (S31ReviewTests) |
| 2026-10-26 | s31 PR #38 | orchestrator | derived state not used in a guard | consent question used options.demo only; the onboarding demo week (demoActive) still asked and Yes started the observer on the real home (Codex P2) | shouldAsk takes demoActive (S31ReviewTests) |

### stage values

- `graph-review` — [`review-via-graph`](../../../skills/review-via-graph/SKILL.md) `verdict: block`
- `runtime-review` — [`review-runtime`](../../../skills/review-runtime/SKILL.md) AC fail / send-back
- `e2e` — [`e2e-acceptance`](../../../skills/e2e-acceptance/SKILL.md) `verdict: block` / Hold for fixes
- `babysit` — [`babysit-builders`](../../../skills/babysit-builders/SKILL.md) redirect / auto-retry
- `orchestrator` — Tier-1 re-dispatch when no review/babysit row was written yet

## Rules

- Append **before** re-dispatching the fix. One row per rework event (not per finding).
- If the file is missing, create it from this template (or copy from `~/adam/foundation/repo/agent-control/rework-ledger.md`).
- `system_fix` may be `none` mid-run; end-of-run / [`session-steward`](../../../skills/session-steward/SKILL.md) fills top recurring classes → skill/HANDOFF patches.
- **Writers:** review skills, `babysit-builders`, Tier-1 `orchestrate-build`, `session-steward`. **Not** Tier-2 managers or Tier-3 workers.
