# 0111 Wave A contract amendments

Date: 2026-10-25. Status: accepted (coordinator, after slices/S2-review/REVIEW-wave-A.md). Amends ADR 0102, 0103 and
API.md where they were silent or contradicted each other. Builders of S2-01, S2-02 and S2-04 may edit the files named here
for these changes only.

## 1. Device enrollment = loopback PKCE (RFC 8252 + RFC 7636 S256)
The Mac flow in `brain/src/sync/enroll.ts` is the contract:
1. The Mac opens `GET {control}/auth/login?client=offload-mac&redirect_uri=http://127.0.0.1:<port>/callback&state=<s>&code_challenge=<c>&code_challenge_method=S256`.
2. The control plane accepts `redirect_uri` only when it is `http://127.0.0.1:<port>/callback` (any port, no other host or
   path), runs the normal AuthKit sign-in, and on success mints a one-time enrollment code bound to the signed-in person,
   the tenant and the `code_challenge`, valid 10 minutes, single use.
3. It redirects to `redirect_uri?code=<code>&state=<s>` (or `?error=<reason>&state=<s>`).
4. `POST /v1/devices/enroll` with the device public JWK and header `Offload-Code-Verifier: <verifier>`; the server checks
   `b64url(sha256(verifier)) == code_challenge` in constant time, consumes the code, and audits `device.enrolled`.
Admin-issued codes (`POST /v1/devices/enrollment-codes`) stay as a fallback (no PKCE binding, same single-use and 10-minute rules).

## 2. What a department lead sees about a person
API.md wins: a dept lead in scope sees `{id, displayName, departmentId, jobRoleIds, state}` only. Add
`schemas/stage2/person-summary.schema.json`; list endpoints return summaries for dept leads, full `person` for owner/admin.
Every person read, list or single, writes one audit event (lists write one event with the ids read).

## 3. Consent is forward-only
Nothing observed before the employee acknowledged the notice ever leaves the Mac: daily aggregates, baseline samples,
run outcomes and working time all start at the acknowledgement time (not the day). A config with no required notice
means nothing but the acknowledgement kind may be sent (fail closed), never "everything flows".

## 4. Run outcome identity
A run outcome's object id is derived from `runId` only; later updates to the same run reuse the id with a higher
`seq`, and ingest keeps the latest by `(deviceId, runId)`.

## 5. Group floor and per-person jurisdiction
The 5-person floor counts people with data in the period, not headcount. Per-person views apply by the subject's
jurisdiction: a person is shown only if per-person views are enabled for their jurisdiction.

## 6. Approvals visibility
Only people who can approve a batch under its policy see its recipients and bodies. Others in scope see the count,
the workflow and the state, with a plain "You are not an approver for this batch" line and no approve button.

## 7. Toolchain
Lockfiles are written by Bun 1.3.x (the repo pin). `lockfileVersion` 2 lockfiles are rejected by verify.
