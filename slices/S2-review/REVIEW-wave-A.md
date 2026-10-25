# Stage 2 wave A review: PRs #2, #3, #4

Reviewer: independent code review, 2026-10-25. Judged on code, tests and evidence only, not on the builders' notes.
Environment: macOS, Bun 1.3.12 (the repo pin; CI uses `bun-version: 1.3.x`), Docker via colima, origin/main = f203a59.
Each PR was checked out as a detached worktree, verified, then removed along with its node_modules and the Postgres
container. No PR was pushed, merged or edited.

## Summary

| PR | verdict | verify.sh as committed | verify.sh after regenerating the lockfile with Bun 1.3.12 (local only, not committed) |
|---|---|---|---|
| #2 S2-01 control core | FIX FIRST (one-line fix) | FAIL, 14 checks: `bun install --frozen-lockfile` fails, then typecheck and every suite fail | PASS: typecheck ok, 216 tests, RLS 16, TENANT 9, AUTH 14, DEVICE 15, RBAC 99, AUDIT 13, DSYNC 12, ORG 22, SCHEMA 7, LOADER 9 |
| #3 S2-02 Mac sync | FIX FIRST (rebase) | PASS: typecheck ok, 87 tests, PROJECT 11, CONSENT 12, ENVELOPE 14, REF 7, OUTBOX 13, ENROLL 15, ROUTES 10, HERMETIC 5, full brain suite green | n/a (brain lockfile untouched) |
| #4 S2-04 admin web | FIX FIRST | FAIL, 12 checks: same lockfile failure | PASS: typecheck ok, 74 tests, TOKENS 8, SCHEMA 7, ROUTES 14, STATES 21, NORANK 6, A11Y 14, BUILD 4, vite build ok |

Brain `bun test` on the #3 branch: 998 tests, 993 pass, 5 skip, 0 fail. That includes the Stage 1 test
`s05b-runner/idempotency H3` that the builder reported failing in the cloud; it passes here. On origin/main the brain
suite has 1038 tests, all green. The branch is 8 commits behind main, so Stage 1 has to be re-proven after the rebase.

Frozen files: `git diff origin/main origin/<branch>` on `slices/<id>/SPEC.md`, `slices/<id>/verify.sh`,
`schemas/stage2/**` and `slices/S2-common/verify-lib.sh` is empty for all three PRs. They are untouched.

Merge check (`git merge-tree` against origin/main): #2 and #4 merge cleanly. #3 conflicts in `brain/src/api/server.ts`
and `brain/API.md`.

### The "Bun 1.4" question: it matters
`control/bun.lock` and `web/bun.lock` both start with `"lockfileVersion": 2`. Bun 1.3.12 rejects that
(`error: Unknown lockfile version`, then `lockfile had changes, but lockfile is frozen`). The builders evidently ran
Bun 1.4. Bun 1.3.x is the pin in `brain/package.json` (`@types/bun 1.3.12`), in ADR 0110 and in `.github/workflows/ci.yml`.
The `@types/bun` pins in both new packages say 1.3.12, so the only real damage is the lockfile, and it is a hard
failure: `s2_install` runs `--frozen-lockfile`. The fix is to regenerate both lockfiles with Bun 1.3.12 and commit
them. With that lockfile the two suites go green without any code change (table above). `brain/bun.lock` stays at v1
and #3 does not touch it.

## Ranked issues (all PRs)

| # | sev | PR | file:line | issue |
|---|---|---|---|---|
| 1 | BLOCKER | #2 | control/bun.lock:2 | lockfileVersion 2 (Bun 1.4); verify fails on the pinned Bun 1.3.12. Regenerate with 1.3.12. |
| 2 | BLOCKER | #4 | web/bun.lock:2 | Same as #1. |
| 3 | HIGH | #3 | brain/src/api/server.ts, brain/API.md | Merge conflicts with main (branch base 287aabf, main f203a59). Rebase, then rerun verify.sh and the full brain suite (main now has 1038 tests). |
| 4 | HIGH | #4 | web/src/api/mock/server.ts:78, :338; screenshot 16 | Per-person gating ignores the subject's jurisdiction. The enablement covers only CA-ON and GB, but people in US-NY, CA-QC, DE, US-CA and CA-BC still get numbers, and screenshot 16 shows them. API.md: "F:x only when sensitive feature x is enabled for the subject's jurisdiction". The mock and the screen both encode the wrong state, so S2-11 inherits it. |
| 5 | HIGH | #4 | web/src/api/mock/server.ts:278-287; web/src/screens/Approvals.tsx:79, :97; screenshot 11 | The owner (Pia, Operations) sees the recipients and bodies of an SDR Sales batch whose policy is `runner_or_dept_lead`, and gets an Approve button. API.md: item fields only for the runner and approvers; owner/admin approve only if the role policy names them; `GET /v1/batches` for O/A means "per role-policy approvers". The screen has no "you are not an approver / no fields" state. |
| 6 | HIGH | #2 + #3 (coordinator) | brain/src/sync/enroll.ts:70; control/src/auth/routes.ts:18-22; control/src/auth/devices.ts:80-118 | The device enrollment handshake does not meet in the middle. S2-02 opens `/auth/login?client=offload-mac&redirect_uri=<loopback>&code_challenge=…` and waits for a redirect carrying the enrollment code, and it sends `Offload-Code-Verifier`. S2-01's `/auth/login` ignores those parameters, always redirects to `afterLoginPath`, issues codes only via `POST /v1/devices/enrollment-codes`, and never checks a verifier. Neither PR is wrong against its own SPEC, but nothing can enroll end to end. This needs a contract decision before S2-13. |
| 7 | MEDIUM | #2 | control/src/app.ts:177-179; control/src/modules/org/util.ts:11 | The global gate lets `F:x` cells through: it checks only the scope. Feature enforcement is left to each handler. Today it fails closed, because `allow()` passes an empty feature set, but the S2-03/S2-05/S2-08 handlers for metrics and working time must remember to resolve features. Suggest a gate-level tenant check through `FeaturePort`, or a test asserting that every F row's handler calls `authorize` with real features. |
| 8 | MEDIUM | #2 (coordinator) | control/src/modules/org/people.ts:26-40 | API.md says `GET /v1/people` returns "name, department, access role, state only for L", but dept leads get the full Person (email, jurisdiction, jobRoleIds, leavingOn). `person.schema.json` requires every field, so the contract itself conflicts. Also, list reads are not audited, while single reads write `person.read` (people.ts:49-56). |
| 9 | MEDIUM | #2 | control/src/audit/audit.ts:84-94 | The chain verifies links but has no anchor. Truncating the tail, or rewriting the whole chain as table owner, goes undetected. `offload_app` cannot do either (verified: SELECT, INSERT only), so this is a DB-operator threat. Suggest periodic external anchoring of the head hash (S2-12). |
| 10 | MEDIUM | #3 | brain/src/sync/client.ts:324-328; brain/src/sync/collect.ts:96-113 | After the notice ack, `daily_aggregate` and `baseline_sample` cover every completed day in the 7-day window, including days observed before the notice was acknowledged. Working time is already restricted by `workingTimeStartsAt`. Recommend the same cut (days ≥ ack date) for the other per-person kinds. This is the builder's open question 4; it needs a coordinator decision. |
| 11 | MEDIUM | #3 | brain/src/sync/consent.ts:35 | `requiredNotice === null` counts as G1 satisfied, so a tenant with no published notice receives every allowed kind. Confirm the server's meaning of null ("already acked" vs "no notice exists"). If it can mean the latter, the device should send only `notice_ack`. |
| 12 | MEDIUM | #3 | brain/src/sync/project/run-outcome.ts:16; brain/src/sync/client.ts:335-338 | The run_outcome object id is derived from `endedAt`. A batch that progresses (partial, then more results) therefore produces a second object with the same `runId`, and S2-05 ingest must upsert by runId or it double-counts. Also, `known[id]` freezes a day's daily_aggregate once it is queued, so reviews recorded later never update it. |
| 13 | MEDIUM | #4 | web/src/screens/People.tsx:30, :48 | With per_person_views on, the page fires one person-scope read per person on load. Against the real API that writes N `person.read` events per page view and puts the owner into every employee's "who looked" list. The enable sheet's own copy says "open one person's own hours". Prefer an explicit per-row open. A failed or forbidden row shows "…" forever instead of plain words. |
| 14 | MEDIUM | #4 | web/src/api/mock/metrics.ts:134, :151 | The group floor is computed on department headcount, not on "distinct people with data in the period" (ADR 0103 §5). It is mock-only, but the STATES tests encode it. |
| 15 | LOW | #2 | control/src/auth/devices.ts:120-132 | `POST /v1/devices/challenge` is unauthenticated, and each call inserts a nonce row, with no rate limit. The API.md rate limits and `Idempotency-Key` are not implemented anywhere yet; confirm which slice owns them (S2-12?). |
| 16 | LOW | #2 | control/src/auth/routes.ts:38 | The AuthKit access token is verified without `iss`/`aud`. The risk is low because the token comes from the server-side code exchange. |
| 17 | LOW | #2 | control/src/auth/directory.ts:82-83, :101-116 | Group-to-department mapping also matches on the group *name* (spoofable by an IdP admin who can create groups). There is no webhook event-id dedupe; only the 5-minute timestamp window applies. |
| 18 | LOW | #2 | control/src/modules/org/people.ts:125-130 | Two concurrent invites race: the second gets a unique-index 500 instead of a 409. |
| 19 | LOW | #3 | brain/src/sync/project/mask.ts:9 | `HOST_RE` uses a fixed TLD list, so hosts like .studio, .health, .pl and .br are not masked, and person names in SKILL.md are not masked either. The G4 preview mitigates this. |
| 20 | LOW | #3 | brain/src/sync/client.ts:298; brain/src/api/sync-routes.ts:46 | `?confirm=1` without `hash` queues whatever the definition is at confirm time. Make `hash` mandatory so the user confirms exactly what they previewed. |
| 21 | LOW | #3 | brain/src/sync/evidence-key.ts:89-100 | `purgeRefs` deletes the ref maps without a purge-log line (the outbox purge writes one). |
| 22 | LOW | #4 | web/src/design/components.tsx:213 | A complementary-suppressed cell (≥ 5 people) still reads "Fewer than 5 people", because the schema has only the `group_floor` reason. The overview footnote explains it, but the cell's words are inaccurate. |
| 23 | LOW | #4 | web/src/main.tsx | The mock fixtures (invented names) ship in the production `dist/`. This is fine until S2-11 swaps the API. |

## PR #2 S2-01 control core: FIX FIRST (then MERGE)

Tenant isolation is the strongest part of this wave:
- Every tenant table has `tenant_id` first in its key, and every FK is composite `(tenant_id, id)`, which closes the
  "FK checks ignore RLS" hole.
- RLS is enabled and forced on all 13 tenant tables plus `tenants`. Policies use `nullif(current_setting(...,true),'')`.
- `offload_app` is a separate login role. It is NOSUPERUSER, has no BYPASSRLS, owns no table, and has no DELETE on
  audit, people, sessions or devices. Tests connect as that role, not as the container's superuser.
- There is no SECURITY DEFINER. Settings are set with `set_config(..., true)` inside one transaction, and a test proves
  they do not leak across pooled connections.
- Pre-auth lookups are read-only transactions with narrowly keyed SELECT policies.
- Tenant always comes from the credential: the cookie's tenant part is only a routing hint (the token hash is globally
  unique, and swapping the tenant part gives a 401), and the device JWT is signed by the server. The forged-header test
  is real: it sends `X-Tenant-Id` set to tenant B and asserts it still gets A, and that B's person is a 404.

RBAC:
- I checked `permissions.ts` against API.md row by row and found no cell mismatch.
- `rbac.test.ts` parses API.md and fails on missing or extra rows. Its per-row tests prove only "allowed → not 403"
  (unimplemented later-slice routes 404, so they pass vacuously). That is acceptable for S2-01.
- The scope logic (`Dp`, `S`) is enforced per handler, and out-of-scope resources return 404.

Audit: `sha256(prevHash || JCS(event))`, a per-tenant advisory lock, and `UNIQUE(tenant_id, prev_hash)`. Events are
written in the request transaction, and the rollback tests are real.

Secrets: only the sha256 of the session secret and of the enrollment codes is stored; connections hold references
only; the WorkOS keys and the device signing JWK come from env.

Directory sync: owner is never granted from the IdP, and an existing owner stays owner. Deactivation goes through
`ContinuityPort.freeze`, which revokes sessions and devices in the same transaction. A frozen person is never
re-activated by a later "active" event.

Dependencies: hono 4.13.13, ajv 8.20.0 and @workos-inc/node 11.0.0 are all approved and exact-pinned. The only
transitive packages are Ajv's own and @types/node.

Fix: the lockfile (#1). Items #7-#9 can be follow-ups, with #8 going to the coordinator.

## PR #3 S2-02 Mac sync client: FIX FIRST (rebase), otherwise MERGE

Privacy:
- The projectors (`brain/src/sync/project/*`) import only `../types`, `../encoding` and `../jcs` (checked by grep and by
  verify). `collect.ts` is the only reader of brain state, and the input types carry only numbers, ids, hashes and refs.
- The seven kinds are a closed union, and each object is validated against its frozen schema before it is queued.
- The privacy property test over the s09 week checks the outbox, the preview and the wire bodies against more than
  500 fixture strings.
- Refs are the first 32 hex characters of `HMAC-SHA256(device-evidence key, instanceId)`. The ref map is sealed per
  day with the 7-day expiry, and object ids are also keyed on the device secret.

Envelope:
- Its own JCS implementation, tested against the RFC 8785 vectors. ES256 over the exact body bytes.
- `seq` is persisted before each request, so it is never reused after a crash, and envelopes split at 500 objects or
  1 MiB.
- The fake control plane re-verifies the signature, canonical form, seq replay, the sentAt window, and G1/G2 on the
  server side.

Consent: an unknown config sends nothing but `notice_ack`, and acks go first in every envelope. Working time needs the
feature on, a listed ack and the notice period passed, and it is dropped when the feature is turned off. A proposal
needs a confirm, and pause holds everything.

Transport: the control URL must be https, except on loopback. Tokens live in memory only.

Stage 1: the only edits outside new files are additive (mounting the routes and the timer in `server.ts`, and the
outbox/ref purge in `retention.ts`). The full brain suite is green here.

Dependencies: none added.

Fix: the rebase (#3). Take #10-#12 to the coordinator and S2-05; the builder's open questions 1, 2 and 4 are real and
match #6 and #10.

## PR #4 S2-04 admin web shell: FIX FIRST

Design fidelity is good. Looking at the 22 screenshots:
- Dark surfaces; a single white primary per screen ("Review 3 waiting batches", "Approve 6 items", "Download my data").
- Colour only for state: green for active and running, amber for needs-you, blue for provisional or in-flight, grey for
  off.
- A/B/C confidence as rings, and card/well/row radii checked against `Tokens.swift` by the parity test.
- Weights 400/500 only, keycap hints (1-9, esc, return), focus-visible rings, and a focus-trapped Sheet with Esc and
  focus return.
- No hype copy (grep clean).
- The light theme mirrors the app's light tokens (`Tokens.swift` lightPrimary and related values), so it is not a
  deviation.

Suppression is shown plainly: "Fewer than 5 people" with no number (screenshots 01 and 03), and the overview footnote
explains the complementary rule. Per-person views and working time are off by default, with a FeatureOffPanel
(screenshots 15, 02, 03). People rows stay in directory order, and NORANK finds no sort.

Dependencies: react/react-dom 19.3.1, @tanstack/react-router 1.170.46, @tanstack/react-query 5.104.5, vite 7.3.7,
@vitejs/plugin-react 5.2.0, happy-dom 21.0.4, @testing-library/react 16.3.3, ajv 8.20.0 and typescript 5.9.3 are all
exact. Two packages are outside the approved list:
- `@testing-library/dom` 10.4.2: a required peer of @testing-library/react, within the approved family. Fine.
- `@types/react`, `@types/react-dom` and `@types/bun`: types only. Fine.

`scripts/screenshots.cjs` uses a machine-installed Playwright, which is not a dependency.

Fix: the lockfile (#2), plus the two mock-fidelity issues (#4 and #5) before S2-11 builds on these states. Items
#13-#14 are should-fix.
