# 0106 Overnight mode policy model

Date: 2026-10-25. Status: proposed. Evidence: research/stage2/05-overnight-mode.md (P1-P11).

## Context
Operator: a person can "2-3x themselves": Offload suggests overnight jobs and runs them while they sleep. Plan
principle 4: reads and drafts run freely; commits need morning approval or a pre-approved policy. ADR 0006 holds.

## Decision
1. **Step classes**: `read`, `draft`, `commit` (from the workflow definition). Reads and drafts run unattended.
2. **Default mode `drafts_only`**: commits queue as a pending batch in the morning digest.
3. **`preapproved` mode** (opt-in per workflow version, by the person who owns the run or the dept lead for role
   identities) is an `OvernightPolicy`:
   - `recipients`: allowlist of emails and/or domains, or `replies_to_threads_started_by_identity`;
   - `templateHash` (sha256 of SKILL.md + facts.md + tone card, as Stage 1 auto-run pin) must match at commit time;
   - `maxCommitsPerNight`, `maxPerRecipientPerWeek`, `sendWindow` (local business hours in the recipient's timezone,
     default 08:00-18:00 Mon-Fri; approved sends are scheduled into it), `attachmentsAllowed` (default false);
   - `budgetCentsPerNight`;
   - `dryRunNights` (default 3): the first K nights run as drafts only regardless of mode;
   - `circuitBreakers`: bounce rate over 5% of the night's sends, negative-reply spike, any recipient outside the
     allowlist, template hash mismatch, connection auth change, 2 consecutive failed runs → pause the policy and queue
     the rest.
   The broker evaluates the policy per item (pure function `evaluateOvernight(policy, item, counters) → allow | queue
   | trip(reason)`); `allow` mints the same one-use token a human approval would, with `approverKind: "policy"` and the
   policy id recorded on the commit.
4. **Kill switch** at tenant, person and workflow scope: pauses deployments, interrupts running sessions, revokes
   unspent tokens; queued batches stay queued. Reachable from the digest email link (signed, single-purpose) and
   the app.
5. **Morning digest** at the person's chosen time: what ran, drafts made, batches waiting (batch approve / edit /
   reject), what auto-committed under which policy, costs, errors, breaker trips, and tonight's suggestions with
   their class and estimated minutes (hs-1 estimate, labelled estimated).
6. **Identity**: overnight commits go out as the running person's own `personal-allowed` connection only while they
   are active, or as the role identity; never as anyone else; frozen people's workflows never run (ADR 0107).
7. **Schedules**: cron in the person's timezone, never 01:00-03:59 local (ADR 0105 §5).

## Consequences
- An overnight auto-send is always explainable: policy id, template hash, counters at the time.
- Suggestions engine (calendar, threads awaiting reply) is a Mac-side feature; it proposes, the policy decides.
