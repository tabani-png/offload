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
