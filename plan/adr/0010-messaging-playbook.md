# 0010 Messaging playbook: the message and its patterns, not the person

Date: 2026-10-25. Status: accepted (operator decision, s19). Builds on 0005 (numbers are code), 0006 (gates), 0007
(masked text only) and 0009 (model router).

## Context
Operator: when a workflow is about messaging (outreach, follow-ups, replies), Offload must understand the style of the
messaging, the MESSAGE the person is trying to portray and the PATTERNS behind it, not just copy their tone. Personal
things (who the person is, private relationships, personal details) are not carried over; the patterns are. The
style card (s05, research 10 section 4, LaMP-style retrieval) captures how someone sounds and is personal by design:
it cannot be handed to a successor. Stage 2 promotes personal workflows to role workflows (ADR 0104), and a successor
or a cloud worker needs to keep the same message going in their own voice.

## Decision
1. A per-workflow **messaging playbook** (`$OFFLOAD_HOME/workflows/<id>/playbook.json` + `PLAYBOOK.md`), separate
   from the style card: the message in 2-3 sentences, do/don't rules (some machine-checkable), templates as slots,
   3-5 example skeletons, cadence, avoid, counted patterns and outcomes.
2. **Per-message read in fixed vocabularies** (intent, opener, moves, CTA, proof kind, personal-hook KIND, objection
   handling, audience): rules first, Haiku 5.5 (route classify) may overrule within the vocabularies. Opus 5.5 (route
   understand) only rewords a baseline the code wrote. Models see masked text only (names, addresses, phones, links,
   figures masked; the author is `{sender}`, their company `{company}`).
3. **Numbers are code**: counts, shares, lengths, gaps, outcomes. Outcomes come from thread state (a later reply by the
   user = they replied; a follow-up = no reply; explicit thread state when the source has it) and are shown as counts
   with sample sizes; below 5 known outcomes a pattern reads "too few to say". No rate is computed or written.
4. **De-personalisation fails closed**: any author or recipient name, organisation, mid-sentence proper noun of the
   messages, address, phone, link, figure not in the playbook's own counts, or the author's identity, in any text
   field including the user's notes, refuses the write. Findings name kind and field, never the value. A model
   wording that fails any check is dropped for the code baseline.
5. **Drafting** uses the playbook for the message and the CURRENT user's style card and sent mail for the voice. The
   dry run shows "follows the playbook: yes / partly / no" with the rule. Auto-run pins playbook.json.

## Consequences
- A successor drafts with the original message and their own greeting, sign-off and phrasing (s19 SUCCESSOR tests).
- The playbook is plain (unsealed) because it holds no mail text; the identity set used to check it is recomputed
  from the sealed tone pack and facts.md when needed and never stored.
- Masking is heuristic (capitalised words, address parts, signature lines, facts). It errs toward masking more; a name
  written in lower case and not in any address or signature can pass the mask but is still a single word, never a
  sentence of mail. Promotion (ADR 0112, proposed) re-checks before anything leaves the Mac.
- Rejected: fine-tuning or embedding the author's mail into the role workflow (personal by construction); letting the
  model write counts or rates (ADR 0005).
