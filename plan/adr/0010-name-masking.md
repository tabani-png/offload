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
2. Text that goes to a model is masked with stable per-run placeholders (`<person:N>`, `<person:N.first>`, ...,
   `<person:me>` for the user) by the model router, the one egress for model calls (ADR 0009). The map is in memory
   only and is never written or sent. Drafts the user reviews are restored on the Mac before validation; outputs that
   become names or notes get `<name>`.
3. Notes and span descriptions store `<name>` (no numbering, no map). Record identifiers stay as they are (sealed,
   needed for grouping, never sent to a model).
4. The user's own name is masked by default and restored locally; `privacy.json ownNameToClaude: "keep"` sends it.
5. What the user approves is the real text; the gate hash is computed on it (ADR 0006 unchanged).

## Consequences
- A name the rules miss (an unusual name with no cue and not in the lexicons) still leaves; the rates are measured in
  `slices/s18-name-masking/verify.sh` and the lexicons can grow without code changes.
- A product or company named like a person (no organisation word, not in the product list) can be masked by mistake;
  the reply is restored for drafts, so the cost is a slightly vaguer prompt, not a wrong output.
