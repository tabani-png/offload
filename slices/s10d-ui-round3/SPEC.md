# s10d UI round 3 (after DESIGN-REVIEW-2)

Owner: UI. Paths: `app/`, `scripts/`, `brain/fixtures/` (demo data), `slices/s10d-ui-round3/`. Done-signal: `verify.sh`.
Depends on the s10b brain additions (`autoRunPin`, `held`, `keptFiles`, `cli.ts purge`, `serve --log-file`).

## The 8 top fixes (DESIGN-REVIEW-2 section E)

1. **Confirm is a real sheet, placed the same way in snapshot and live.** Live was already `NSWindow.beginSheet`; on
   macOS 26 that is a panel centred on the window with the window dimmed. The snapshot chrome (`WindowChrome(sheet:)`)
   now draws exactly that: scrim over the whole window, sheet centred, radius 24. The blocker is said once, as the
   amber lines; the "Connect … first. Turn on needs every step able to run." line is gone from the sheet and from the
   window footer (↩/⌘↩ while blocked now press the primary instead of writing a message). The blocked primary is
   "Connect Gmail ⌘↩". A disabled `PrimaryButton` keeps its label (quiet fill, tertiary ink), so Approve is never a
   blank pill. With no recipient list yet, the headline and note are plain text, not a card inside the sheet. The
   sheet fill is lighter (`sheetFill`) so its edge holds on a dimmed dark window.
2. **One persona and one week.** `brain/fixtures/gen.ts` and `sent-mail.ts`: the observed user is Muhammad Ali,
   founder of Offload, muhammad@offload.so, with the app mock's pitch and figures (40 design partners, 3 paying,
   $2.5M seed). Deterministic (same seed, same bytes); brain suite 390/390 before and after; only persona
   text in brain/tests changed (no assertion logic). App side: `Core/MockWeek.swift` is the only place the
   sample week's minutes are written; `SampleWeek` insights compute hours, tracked total and share from it. 1,476 min
   of outreach / 2,292 min tracked = 64.4% = 24.6 h of 38.2 h, and 492 × 3.0 min = the same 24.6 h. Tests tie the
   card, the timeline bars and the dashboard's "38.2 h tracked".
3. **Pointer label in free space.** `PointerLabelPlacement` (Core, tested): candidates along the target's line, then
   scanning down and up, anchored at the arrow and flipped at the window edge; it rejects any rect that touches the
   target, the arrow or a registered obstacle (padded by the gap). Surfaces mark their text with `.pointerObstacle`
   (and every other pointer anchor counts too). Copy: "Sign in to HubSpot here".
4. **Timeline legibility.** The focus task is ink; everything else is one neutral ("Everything else"), so no two greys
   at 1.5:1. Offload's runs are a green-outlined, green-hatched span at least 16 pt wide. `TimelineMerge.display`
   folds spans under 10 min into a neighbour within 10 min (never Offload's runs), so live rows start clean. The live
   composer adds an empty today row and the layout covers "now", so the marker is always drawn ("now 02:25").
5. **Live dry run on real examples.** With the offline sample model the app runs at least 3 examples
   (`OFFLOAD_DRYRUN_LIMIT=1` caps paid model calls; the stub costs nothing). The item header is two lines (who and the
   saving; subject and a time column that never truncates), and the subject drops the fund already on the line.
   `FactCheck` flags numbers, amounts, months and weekdays in a draft that are in neither the sent email nor the
   facts ("Check “March”: not in what you sent or in your facts."). Underlines mark only words that carry a claim and
   that the sent email never used.
6. **Dashboard state copy.** `ObserverAction`: Pause only while watching; Resume when paused or not recording; Open
   Settings when not recording and Screen Recording is off. The "Measured compares…" note shows only with a measured
   figure. "Show the evidence" has no keycap in the button; the key is in the page legend ("2 point to the evidence").
   "Sign in…" replaces "Add key…" everywhere.
7. **Card headline and numbers.** Whole percent in the headline ("take 64% of your week"); the receipt's By hand line
   reads "492 emails × 3.0 min" when count × printed median gives the printed hours (else the brain's own formula).
   `BalancedWrap` breaks the title where both lines are even. Light amber text is #6E4500 (4.5:1 on its tint). The
   hint pill has one way out ("1 2 3 choose · esc close"); E still dismisses (tooltip on row 3). The likely range is
   the receipt's footnote.
8. **System pass and fresh evidence.** Rail: the observer is a ring above a hairline, automations are solid dots, each
   has a tooltip, and the hover card lists every dot by name. The inbox badge is a neutral count (insights are
   suggestions; amber stays for "needs you"). Lock hangs left of step 5's number. Literals moved to `Tokens.Layout` /
   `Tokens.Window`; light inks are `Tokens.Ink.light*`; one `barHairline`; the zero-opacity Recommended ring is gone.
   Every committed and live PNG is re-taken after the last source change (verify.sh checks mtimes).

## The rest of the brief

- **Dashboard layout (choice).** A sidebar: Overview (time saved, what needs you, observer), Automations, This week,
  Observing (with kept files). Live it is an `NSSplitViewController` sidebar item (system material, Tahoe floating
  sidebar, title after the sidebar edge); ⌘1-⌘4 switch. Snapshots draw the same SwiftUI rows in `WindowChrome(sidebar:)`.
  Why: round 2 scored the one 1,300-px column as a web page, and round 1's objection to a sidebar (hiding sections)
  is answered by an Overview page that carries the one-line state of each.
- **Brain additions.** Auto-send: "Send without asking…" on an active automation opens a sheet; on confirm the app
  posts `auto-run`, and the sheet shows the pin: "Auto-send covers these 37 people and your current facts and voice.
  Anyone new waits for you." (plus who already waits, and a note when a pinned file changed). Kept files: Observing
  lists them ("Kept until you delete them") with Reveal in Finder. `cli.ts purge` runs once at launch (bounded 10 s).
  `serve --log-file ~/Library/Logs/Offload/brain.log` (the brain rotates it at 5 MB, keeping 2); the app keeps
  rotating `brain.err.log` itself.
- **Plain words.** Connect help is a sheet in plain words (no connectors.json, environment variable, MCP); "Your
  voice" replaces "tone card" in messages and in the brain's step text; steps editor messages say "Steps saved".
  verify.sh parses every string literal in Copy.swift and Surfaces/ and fails on key/token/MCP/SKILL/gate/json.
- **Steps sheet.** The read-only Steps sheet repeated the page, so S and the toolbar open the editor (same as E).
  The raw SKILL.md view is gone; "Show in Finder" opens the folder for anyone who wants the file. `review-skill` is the
  editor; `review-skill-source` is the editor after a refused save (the names stay so s08/s10a verify keep passing).
- **Your voice.** The empty editor carries its instruction as a placeholder at 72 pt; the review window opens with no
  text focused, so R, E and S act at once; while you type, the action bar says the keys type letters.

## Round-1 items not taken, and why

- **M2 generic mark.** A brand mark is a brand decision, not a UI fix; out of scope for this slice.
- **R3 window shadow.** The card and rail use our own tight contact shadow; the titled windows use the system's
  shadow live. Only the snapshot chrome draws one (now tokenised at r16 y8).

## Test changes outside this slice

Copy that the brief changed is pinned in two older suites; each line is commented `s10d`:
`S08LogicTests.swift:129` ("Add key…" → "Sign in…"), `S10ATests.swift:79, 289, 332, 333` (whole-percent headline,
"Sign in to Google Sheets"). No assertion was loosened.

## Live captures

`E2E=1 slices/s09a-wiring/verify.sh` (stub model) and `scripts/live-captures.sh` (glass over our own backdrop via
the card window, onboarding, confirm, steps editor, dashboard pages with both pointers, the auto-send sheet, light
dashboard, and the real-brain week with today's row and observing with real kept files).
