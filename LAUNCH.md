# Launch readiness

Snapshot: 2026-10-26, after the wave B/C merges, from `origin/main` and the open PRs on `tabani-png/offload`.
Status values: **done**, **open**, **blocked**.
Owner values: **manager** (the build agent that dispatches, reviews and merges) or **operator** (you).
Where the repo does not say, the item reads "check".

## 1. Open pull requests

| PR | What | Waits on | Status | Owner |
|---|---|---|---|---|
| #9 | S2-05 ingest + metrics | Final Codex fixes. | open | manager |
| #10 | S2-08 monitoring compliance | Ready. Merges after #9. Counsel sign-off on the notices (section 2). | open | manager |
| #21 | s24 brief runner | Security fix rounds. | open | manager |
| #16 | S2-10 continuity (stacked on wave B) | Next, after #9 and #10. | open | manager |
| #18 | S2-11 dashboard wiring (stacked on wave B) | Next, after #9 and #10. | open | manager |
| #19 | S2-09 cloud workers (stacked on wave B) | Next, after #9 and #10. | open | manager |
| #20 | Cindy eval research (draft) | Research only. Operator reads the USE/BORROW/SKIP verdicts. | open | operator |

Merged 2026-10-26: #23, #7, #17, #12, #26, #22, #28, #27, #15, #11, #29 (#25 merged with #29).

`main` holds Stage 1 s01 to s17 and Stage 2 S2-01 to S2-04 and S2-06.

## 2. Security

| Item | Detail | Status | Owner |
|---|---|---|---|
| S2-12 security review + e2e | Contract is in `slices/S2-12-security-e2e/`. Not run. Needs every other S2 slice merged first. | blocked | manager |
| `agent-control/security-status.md` | Still the empty template. No audit, no SAST, no dependency audit recorded. Fill it during S2-12. | open | manager |
| Counsel sign-off on monitoring notices | S2-08 (PR #10) ships notice, policy and DPIA templates. A lawyer must approve them before any company turns on monitoring. | open | operator |
| Rotate the Anthropic key | It was pasted into a chat once. Make a new key in the Anthropic console. Store it with `security add-generic-password -U -s offload.anthropic -a api-key -w`. Then revoke the old key. | open | operator |
| GitHub hardening | See section 3. | open | operator |
| Secret scan follow-up | See section 5. | open | operator |
| s24 key source | s24 builds require the Anthropic key in the Keychain (`OFFLOAD_ANTHROPIC_KEYCHAIN`); a brain launched with `ANTHROPIC_API_KEY` in env refuses to build. | open | operator |

## 3. GitHub hardening

| Item | Detail | Status | Owner |
|---|---|---|---|
| Main branch protection | PR required, no force-push, no delete. Checked with `gh api repos/tabani-png/offload/branches/main/protection`. | done | manager |
| Admins bound by protection | `enforce_admins` is off, so the owner can still push past the rules. Turn it on if you want no exceptions: `gh api -X POST repos/tabani-png/offload/branches/main/protection/enforce_admins`. | open | operator |
| Dependabot alerts | Off today (the API returns 404). Turn on: `gh api -X PUT repos/tabani-png/offload/vulnerability-alerts` | open | operator |
| Dependabot security fixes | Off today (`enabled: false`). Turn on after alerts: `gh api -X PUT repos/tabani-png/offload/automated-security-fixes` | open | operator |
| Secret scanning | Not available here. The repo is private and owned by a user account. GitHub's docs say user-owned repos get secret scanning only on Enterprise Cloud with Enterprise Managed Users. Org-owned private repos need GitHub Secret Protection on Team or Enterprise Cloud. Until then, run gitleaks locally before each release. | blocked | operator |
| CI | `.github/workflows/ci.yml` exists. GitHub Actions has no minutes, so every PR shows red. Restore billing, or add a self-hosted runner, or keep using local `scripts/verify-all.sh`. | blocked | operator |

CI is still red (no Actions minutes). Local verify is the gate. PR merges this session used Codex review (Claude independent reviewers while Codex was out of credits) plus local verify.

## 4. Known product gaps before launch

| Gap | Detail | Status | Owner |
|---|---|---|---|
| Company window not wired | Wired in PR #22. | done | manager |
| Saving numbers are overstated | Fixed in PR #15; s23 caps freed hours to leave checking time. | done | manager |
| Demo data is outreach-heavy | Done for the time screen: PR #29 uses a neutral week. | done | manager |
| Time breakdown first screen | s23 shipped in PR #29. | done | manager |
| No disconnect / withdraw-consent control | Needs a brain route and an app control (follow-up #13 in `agent-control/followups-20261026.md`). | open | manager |
| Product name | "Offload" is a working name. The brief lists "pick a product name" as open. | open | operator |

## 5. Secret scan result

A gitleaks scan of `main`'s history found 8 `generic-api-key` hits.
All 8 are in test fixtures or docs.

One hit looks like a real Linear key (`lin_api_` prefix).
It appears in two files:

- `brain/tests/s17-connect-anything/setup.ts` (the `SECRET` constant)
- `slices/s17-connect-anything/tests/S17Tests.swift` (`static let key`)

Both tests use it as a canary.
They check that the value never reaches a file on disk.
So it is most likely fake.
The value is not printed here.

| Item | Detail | Status | Owner |
|---|---|---|---|
| Confirm the Linear value is fake | Open Linear > Settings > API and check that no key you own matches it. | open | operator |
| If it is real | Revoke it in Linear. Replace the constant with an obviously fake value. Note: it stays in git history. | open | operator |
| Make canaries obviously fake | Use values like `lin_api_TEST_CANARY_000…` so scanners and people do not flag them. | open | manager |

## 6. Distribution

| Item | Detail | Status | Owner |
|---|---|---|---|
| Code signing | `app/build.sh` signs ad hoc by default. s25: with `OFFLOAD_SIGN_IDENTITY` it signs inside-out with the hardened runtime (bun gets `app/brain.entitlements`, ADR 0013). Still needs an Apple Developer ID Application certificate. | open | operator |
| Notarization | s25: `OFFLOAD_NOTARY_PROFILE` (a `notarytool store-credentials` keychain profile) submits, waits and staples. Untested until a Developer ID exists. | ready, untested | operator |
| Permissions on a signed app | Today permissions attach to the terminal app when run from a shell (`engine/README.md`). A signed bundle gets its own entries. Retest onboarding then. | open | manager |
| Install without the repo | s25 (ADR 0013): the app carries a pinned bun and the brain JS and uses them first; the repo is a dev-only fallback. Proof: `slices/s25-standalone-install/verify.sh` runs the brain from a read-only copy outside the repo with no bun on PATH. Bundle about 395 MB (claude binary 261 MB). | done | manager |
| Update path | No updater (no Sparkle, no appcast). Users would reinstall by hand. | open | manager |
| Privacy policy | None in the repo. Needed before any outside user. | open | operator |
| Terms of service | None in the repo. Stage 2 plan relies on a "purpose lock in terms" (no use of numbers for pay or rankings). | open | operator |
| DPA and sub-processors | Stage 2 plan says Managed Agents is a sub-processor to disclose in the DPA. Templates come with S2-08 (PR #10). | open | operator |
| License | No LICENSE file. Fine for a private repo; decide before sharing code. | open | operator |
| Control plane hosting | Deploy target is TBD. Needs managed Postgres 17 and a KMS. | open | operator |

## 7. Open decisions

- Overlapping date ranges in metrics: fixed report periods (manager recommends) vs noise. Operator to decide.

## 8. Launch order

1. Rotate the Anthropic key. Confirm the Linear canary is fake. (operator)
2. Turn on Dependabot alerts and security fixes. Decide on CI: billing or local verify. (operator)
3. Merge #13. Then merge wave B (#9, #10, #12) and #7, #11, #14 as their fix rounds pass. Run `scripts/verify-all.sh`, then `scripts/verify-all.sh S2-`, one at a time. (manager)
4. Finish s20 (PR #15) so the saving numbers are honest. Switch the demo week to neutral data. (manager)
5. Build s23, the time breakdown first screen. Wire the Company window (#22). (manager)
6. Merge wave C (#16, #18, #19) after wave B. Then run S2-12, the security review and e2e. (manager)
7. Get counsel sign-off on the monitoring notices and write the privacy policy and terms. (operator)
8. Get a Developer ID, then sign, notarize and bundle the brain with the app. Pick an update path. (operator, then manager)
9. Pick the product name. Run a private beta on one Mac before any company rollout. (operator)
