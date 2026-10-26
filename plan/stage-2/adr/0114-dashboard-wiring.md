# 0114 Dashboard wiring: serving the SPA from the control plane, and what the web reads

Date: 2026-10-26. Status: **proposed** (S2-11). Amends ADR 0110 (stack) and `plan/stage-2/API.md` where they were
silent. No schema changes; no change to `control/src/app.ts`, `ports.ts` or the RBAC matrix.

## Context
ADR 0110 says the control plane serves the admin SPA as a static bundle. `app.ts` (S2-01, closed to later slices) runs
the RBAC gate as the first middleware on `*`: any path that is not a row of the permission matrix is `404 not_found`
before a module route can run. A module therefore cannot answer `GET /` or `GET /assets/…` with a normal Hono route.

## Decisions
1. **Static serving is a module that fronts the app's fetch.** `control/src/modules/web/index.ts` wraps `app.fetch`
   (Hono's `request()` calls `this.fetch`, so tests see the same path). A `GET`/`HEAD` whose path does not start with
   `/v1/`, `/auth/` or `/webhooks/` is answered from `web/dist` (`OFFLOAD_WEB_DIST` overrides the directory); every
   other request goes to the gate unchanged. With no build present the module installs nothing. API routes, their
   headers and their error bodies are untouched.
2. **Headers.** HTML (`/` and every client route, which all get `index.html`) carries
   `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
   `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Opener-Policy: same-origin`. Content-hashed files under `/assets/` are
   `Cache-Control: public, max-age=31536000, immutable`; a missing asset is a plain `404`, never the HTML shell.
   Paths that resolve outside the build directory are never read.
3. **No inline style or script in the bundle.** The design tokens, written into a `<style>` element at start-up by
   S2-04, are now a build-time stylesheet (`virtual:offload-tokens.css`, generated from `tokenCss()` in
   `web/vite.config.ts`), so the CSP needs no `'unsafe-inline'`.
4. **The reporting period comes from the clock and the tenant's timezone.** Every screen reads "this month so far":
   `from` = the first of the current month and `to` = tomorrow (exclusive), as local days in
   `tenant.reportingTimezone`. Screens wait for `GET /v1/tenant` before asking for metrics. Evidence is asked for the
   same period as the overview, and the screen follows `page.nextCursor` until the end, so the runs listed add up
   exactly to the workflow's hours in the total (for the caller's scope).
5. **Workflow names come from the registry.** hs-1 reports carry `topWorkflows[].name` = the workflow id (the metrics
   module passes no workflow metadata to hs-1); the web shows `GET /v1/workflows` names instead.
6. **Department leads get person summaries** (ADR 0111 §2): the people screen renders `person-summary` rows without
   access role, jurisdiction or leaving date, and leaves the per-person gate to the server for them.
7. **Working time on the overview.** When `working_time` is enabled and effective, the overview shows company team
   medians (`GET /v1/metrics/working-time?scope=company`) under the group floor; nothing appears while it is off or in
   its notice period. The department page keeps its off notice.

## Consequences
- A deploy serves API and SPA from one origin, so the session cookie (`SameSite=Lax`) and `connect-src 'self'` work
  without CORS.
- Open, for the metrics owner (S2-05): putting registry names into `topWorkflows[].name` server-side would let the web
  drop decision 5. Times in tables are still shown in UTC; switching `timeText` to the tenant timezone is left for a
  later web change (S2-04 snapshots depend on UTC).

## Amendment (2026-10-26, on main after wave B)
Renumbered from 0113 (three ADRs held that number). Fitted to the merged S2-05, S2-07 and S2-08 behaviour:
8. **Hidden cells below the company say what is true of every case.** ADR 0113 (metrics floor) §1 suppresses a
   department or job role read whose cell is hidden in its parent's report, so the web can no longer tell a small
   group from the complementary cell, and §5 hides a whole adoption cell when any one figure rests on fewer than 5
   people. Department, job role, adoption and department working-time cells therefore read "Hidden to protect a group
   under 5 people" (`TREE_FLOOR_WORDS`); "Fewer than 5 people" stays only where it is certain (company-level single
   values). The extra own-scope read per hidden row is gone. The S2-04 mock floors department and job role reads the
   same way.
9. **Hidden months are not zero.** A suppressed month in the overview trend is drawn as a dashed outline with a dash
   and named "hidden" in the chart's label.
10. **Expected refusals are calm.** Evidence `422 group_floor` (too few people ran it in scope, or its baseline comes
    from fewer than 5 senders) is a note, not an alert; `GET /v1/me/digest` answering 404 (no digest for the day) says
    so and leaves the kill-switch controls usable.
11. **Kill-switch rights follow API.md.** "Stop all sending" is offered to owners and admins only. "Clear the stop" is
    offered to an owner, or to an admin when the stop was not set by an owner (setter's role from the directory; when
    unknown, not offered). The server stays the authority.
