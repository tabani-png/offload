# 0010 Person names are masked in code before text leaves the Mac or is stored in a note

Date: 2026-10-25. Status: accepted (operator brief, s18).

## Context
ADR 0003 keeps Offload metadata first; ADR 0007 and 0009 let masked text (and, opt-in, engine-masked frames) reach the
user's own Anthropic account. `maskText` masked numbers, emails, dates and ids but not person names, so names reached
frame notes, span descriptions and the source text of text-step prompts (a CV, a ticket, a recipient row).

## Decision
1. A deterministic masker (`brain/src/privacy/names.ts`, embedded word lists, no model, no dependency) detects person
   names from known names (the run so far, the user's own name, contacts in workflow recipient lists), honorifics,
   greeting/role cues, given+family pairs, signatures, lone given names and email local parts that equal a name, and
   leaves common words, UI labels, months, product and organisation names alone.
2. Text that goes to a model is masked with stable per-run placeholders (`<person:TAG.N>`, `<person:TAG.N.first>`,
   ..., `<person:TAG.me>` for the user; TAG is a random 4-letter tag per run) by the model router, the one egress for
   text model calls (ADR 0009). The map is in memory only and is never written or sent. Placeholder-shaped text in the
   input that the map did not write becomes `<name>` first, so input cannot name another person's placeholder. Drafts the user reviews are restored on the Mac before validation; outputs that
   become names or notes get `<name>`.
3. Notes and span descriptions store `<name>` (no numbering, no map). Record identifiers stay as they are (sealed,
   needed for grouping, never sent to a model).
4. The user's own name is masked by default and restored locally; `privacy.json ownNameToClaude: "keep"` sends it.
5. What the user approves is the real text; the gate hash is computed on it (ADR 0006 unchanged). A draft that still
   holds a placeholder or `<name>` is never sent by auto-run; it waits for review with a warning.

## Consequences
- A name the rules miss (a name in no lexicon with no cue, e.g. "CV - Njeri Wambugu.pdf") still leaves. The tuned
  corpus rate (verify.sh gate) says little about real mail, so a held-out set of such names is measured and printed
  apart (`tests/s18-name-masking/heldout.ts`; at this commit the rules miss all of them). The lexicons can grow without
  code changes, and contacts in recipient lists are always masked.
- Three model paths bypass the router and are not name-masked: screenshot captioning (the engine-masked image; its
  text turn is masked), the computer-use planner (screenshots, AX outline), and the approved batch to the executor
  (real text by design).
- A product or company named like a person (no organisation word, not in the product list) can be masked by mistake;
  the reply is restored for drafts, so the cost is a slightly vaguer prompt, not a wrong output.
