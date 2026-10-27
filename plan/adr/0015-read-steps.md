# ADR 0015: read steps fetch a workflow's data through Offload's own view of it

Status: accepted (operator, 2026-10-26). Slice: s27-workflow-reads.

## Context
"Once installed it records, and then fetches the data." A repeated task's values come from somewhere the person
reads first (a dashboard, a report). s27 learns that source from the recordings and reads it itself, read only. Two
questions came up in review of PR #35: what the read asks the source for, and what a screen read opens.

## Decision
1. **Read arguments are learned, not set up.** From the recordings Offload infers what the person looked at: the
   report (the page title without the product name), the fields (the labels shown before the values that were then
   typed) and the filters seen on screen (for example period "last 7 days"). This is `read.query`
   (`{report, fields, filters}`), code only (ADR 0005). It is shown in the dry run (`read.query`), it is part of the
   hashed item text of dry-run and live batches (so every approval covers it), and it is what connector, Composio
   and API reads are asked for (`job.args`). There is no extra setup step.
2. **Offload builds its own view of the data.** The page address the person had open (dashboard URL, ids in its path)
   is never stored. The read goes through a connector or API query Offload builds from the learned query. A screen
   read stays the last resort and opens only the site or app (the chain target's host), then reads its text: no
   click, no typing, no stored address.
3. **Read only, enforced in the gate** (mode `read`); a refusal stops the read. A pause or delete stops the whole
   chain: no next method, no screen opened; the method is not marked failed for it.
4. **Done rows are dropped before any limit.** A source with more rows than a batch is worked through to the end;
   an answer too large to read at once is refused, never cut.

5. **A read claims only what it can confirm** (PR #35 round 4). The screen read must see the learned report and
   filters before it accepts values; a connector answer that names another report or filter is refused. Rows without
   every value are skipped and reported, never counted done.

## Consequences
- The learned query may not match a given tool's argument names; a tool that refuses it fails that method and the
  chain moves on (to the screen, last). Mapping the query to each tool's schema is follow-up work.
- Without a stored address, a screen read sees the site's start page; when the values are not there the read fails
  plainly and the run falls back to the person's list, with a warning on every item.
