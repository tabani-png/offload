# SOP: Investor outreach

This SOP describes version 2 of 2. Owner job role: SDR (Sales).

## Purpose
Write a short intro email to each new investor lead and log it. Ask [email] for the list.

## Trigger
Runs on a schedule: `0 9 * * 1` (America/Toronto).

## Steps
1. **Read new leads**. Read the rows added to the leads sheet since the last run.
   - What it does: Reads; capability `sheet.read`.
   - Connection: Sales shared mailbox (Microsoft 365 shared mailbox, company connection).
   - Gate: no gate.
2. **Draft the intro**. Draft one email per lead from facts.md. Call [number] if unsure.
   - What it does: Drafts (nothing leaves before review); capability `text.draft`.
   - Connection: no connection (runs on its own).
   - Gate: no gate.
3. **Send the intro**. Send each approved email exactly as approved.
   - What it does: Commits (sends, posts or writes outside); capability `mail.send`.
   - Connection: Sales shared mailbox (Microsoft 365 shared mailbox, company connection).
   - Gate: waits for a person to approve the exact batch.

## Rules
- At most 20 items per run and 1 run per day.
- Drafts may state only these facts (the values are kept by the job role, not in this SOP): `calendly_link`, `company_name`.
- Nothing is sent before the review step approves the exact batch.
- Drafts state only what is in facts.md. Gaps show as [missing: ...].
- company_name: [fact]
- Book calls via [link] or call [number].
- No commit step uses a personal-forbidden connection or a personal LinkedIn.

## Gates
- Step 3 (Send the intro): waits for a person to approve the exact batch.

## Connections
- Sales shared mailbox (Microsoft 365 shared mailbox): steps 1, 3.

## Owner
- Job role: SDR
- Department: Sales
- State: in use

## Version history
| Version | Created (UTC) | Definition hash |
|---|---|---|
| 1 | 2026-10-26 09:00 | `aaaaaaaaaaaa` |
| 2 | 2026-10-27 14:30 | `464b5109a00b` |
