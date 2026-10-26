# 0012 Messaging playbook: review fixes (names, identity digest, model errors)

Date: 2026-10-26. Status: accepted (s19 fix round, slices/S2-review/REVIEW-wave-B.md PR #11). Amends 0011.

## Context
The wave-B review found that a capitalised word at the start of a sentence ("Priya is an engineer at Ramp.") and any
non-Latin name passed the playbook masker and the leak check; that a notes edit or a promotion after the tone pack had
expired was checked against facts.md only while reporting "re-checked"; and that one model error aborted a build.

## Decision
1. **Masking (amends 0011 §2, §4).** Words are Unicode letters (`\p{L}`). A word is capitalised when it starts with an
   upper- or title-case letter or a letter of a script without case. A capitalised word at the start of a sentence is
   masked unless it is generic, one of a fixed list of common words, or written in lower case elsewhere in the
   messages. A `coreClaim` never starts with an unmasked capitalised word.
2. **Leak check (amends 0011 §4).** Besides the identity set, any capitalised word that is not generic, not a common
   word and not written in lower case anywhere in the playbook's own text is a name. The check depends on the playbook
   and the identity only, so it answers the same with or without the tone pack.
3. **Identity digest (amends 0011 "Consequences": "never stored").** A build writes
   `workflows/<id>/playbook-identity.json` (0600): the identity set as salted SHA-256 hashes (a fresh random salt per
   build), never plain words. It stays on the Mac and is not part of the promotable playbook. A notes edit and
   `playbookForPromotion` check against the tone pack identity, facts.md and this digest. With neither the tone pack
   nor a digest they are refused with 409 (PlaybookInputError): rebuild the playbook.
4. **Model errors.** A failed Haiku label keeps that message's rule read; a failed Opus wording keeps the code
   baseline. Each adds a fixed warning (counts only, no content). At most 60 label calls per build; the rest keep
   their rule read.
5. **Corrupt playbook.json** reads as no playbook with a fixed warning; a dry run or a run drafts without it.

## Consequences
- The masker errs further toward masking: an uncommon ordinary word at the start of a sentence that the messages
  never write in lower case becomes `[name]`, which can cost a label but never leaks. A model wording that starts a
  sentence with such a word is dropped for the baseline.
- A hashed name set can be tested against a guessed name by someone holding the file and its salt; the file is 0600
  in the user's own home, like the sealed tone pack keys.

## Fix round 2 (independent re-review of PR #11)
6. **Known contacts in any case (amends §1, §2).** The recipients' names and organisations (from addresses and
   greetings, not from capitalisation) are masked and counted as leaks whatever their case ("we help alice at
   northzone"), unless the word is also a common or generic word ("will", "hope"), where only the capitalised form is
   taken for the name. Role address local parts (`sales@`, `support@`, ...) are not people. The identity digest keeps
   these contacts as their own hashed set (`contacts`); a digest without it treats every hashed name as a contact.
7. **Auto-run pin (amends 0011 "auto-run").** Changed files are the union of pinned, current and drafted-with names:
   a pinned `playbook.json` that is removed, or one a batch was drafted with that the pin never saw, holds the batch.
8. **Shape.** Links are counted once, as the `[link]` placeholders of the masked core.
9. **Labeller free text.** A model's `coreClaim` / `positioning` is kept only when, masked, it is a passage of the
   masked core the model was shown; otherwise the rule read stands. No model wording of its own reaches the playbook
   through these fields.

### Follow-ups (not fixed in this round)
- `playbook-identity.json` hashes are salted but the salt sits beside them, so a holder of the file can test a guessed
  or dictionary name. Proposed: delete the digest with the playbook and when the tone pack is deleted, and expire it
  with the tone pack's retention (rebuild re-creates it); or key the hashes with a secret from the keychain instead of
  a stored salt.
- `buildWorkflowPlaybook` takes no per-workflow lock: two concurrent builds (up to 61 model calls each) can race on
  `playbook.json` and the digest. Proposed: a per-workflow build lock (409 while one runs).

## Fix round 4 (Codex re-review of 5b955cc)
10. **Only name-like words join the identity (amends §1).** The author and company sets are matched whatever the case,
    so every heuristic that fills them (facts `sign:`/`company:`, the sign name, the signature block, subject brand
    words) adds a word only when it is two letters or more, letters only, not a common or generic word, not a job-title
    word and not a word the generator writes (`GENERATOR_WORDS`, guarded by a drift test over `synth.ts`). A Title Case
    subject gives no capitalisation evidence: it adds no brand word and its words count as sentence-initial. Greeting
    names skip honorifics ("Dear Ms Kowalski" -> kowalski) and single letters; an address organisation is the
    registrable label ("app.northzone.com" -> northzone), not a subdomain.
11. **Ordinary words are never masked in lower case or read as a leak**, even when an older identity digest holds them,
    so routine subjects or recipients named like generator words ("Tom Hook at Progress") cannot fail the build closed.
    A real name that is also an ordinary word is still masked when capitalised mid-sentence (`[name]`); it is no longer
    matched in lower case, which is the accepted cost.

## Fix round 5 (Codex re-review of adcba7b)
12. **One decision for masking and the leak check.** `identityHit` (mask.ts) says what a word is (author, company,
    this recipient, a name, or nothing); `maskText` and `findTextLeaks` both call it, and a property test checks they
    agree on generated text and that masked text never leaks. A known contact named like an ordinary word ("Will",
    "Hope") is a name whenever it is capitalised, except a generator opener ("Short") at the start of a sentence,
    where the generator writes the word itself (`GENERATOR_OPENERS`, drift-tested). Capitalised ordinary words that are
    not contacts are no longer masked mid-sentence; the leak check never flagged them, so they now agree.
