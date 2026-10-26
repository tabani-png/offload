# Common English word list (s19 vocabulary default-deny)

`common-words.ts` is generated from SCOWL (Spell Checker Oriented Word Lists) release 2020.12.07,
http://wordlist.aspell.net/ (download: sourceforge.net/projects/wordlist, `scowl-2020.12.07.tar.gz`).

- Size 50: levels 10, 20, 35, 40 and 50 of `final/{english,american,british,british_z,canadian,australian}-words.*`
  and `final/english-contractions.*`.
- Only entries that start with a lower-case letter (SCOWL keeps proper nouns capitalised, in the `*-upper` lists,
  which are not used); possessives (`'s`) dropped. 63900 words.
- `supplement.ts`: a short hand-reviewed list of everyday business and software words SCOWL 2020 lacks (app, signup,
  onboarding, saas, ...). Never names, products or companies.
- At load, mask.ts also drops every unambiguous given or family name of the s18 lexicon (`privacy/lexicon.ts`).
- Licence: permissive (use, copy, modify, distribute and sell, with the notice kept): `SCOWL-Copyright.txt`.

Regenerate: extract the tarball, then keep the lower-case lines of those files (Latin-1 to UTF-8), sorted and unique.
