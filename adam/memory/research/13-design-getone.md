# 13. Design teardown: getone.one ("One")

Captured 2026-10-24 with Playwright at 1440x900 (computed styles read from the live DOM). Firecrawl was
unavailable (out of credits). Screenshots are in `assets/getone/`:
`00-full-page.jpg`, `01-hero.png`, `02-what-it-is.png`, `03-hero-scroll-demo.png`, `04-how-it-works.png`, `05-pricing.png`.
These notes cover principles and tokens only. Do not reuse their logo, mascot, wallpapers or copy.

## 1. What it is, and how you interact with it

One is a native Mac app (with an iPhone companion and a Linux server connector) that sits on top of the
coding agents you already run: Claude Code, Codex, OpenCode and others. When an agent stops to ask a
question or finishes a task, One shows it in a single **Inbox** and in a slim **Toolbar** at the edge of the
screen. You answer with a keystroke (1/2/3), by voice (double-tap Option opens the **Router**), or from your
phone. It is not another agent. It is a calm layer that collects interruptions and lets you clear them.

Core interaction model: **ambient status, then a targeted interruption, then a one-key answer, then an undo window.**
- Ambient: one colored dot per agent at the screen edge (blue = working, amber = needs you, green = done).
- Interruption: a floating glass card anchored to the toolbar shows one question with numbered options, a "Recommended" tag, and a reply field.
- Answer: press 1/2/3, or J/K to move between cards and E to clear one.
- Safety: "Every answer waits 2 seconds. Press Escape to undo." Nothing acts on its own.

## 2. Design tokens

### Type
| Role | Family | Size / line-height | Weight | Tracking |
|---|---|---|---|---|
| Display XL (closing CTA) | Aeonik (display grotesk) | 64 / 1.02 | 500 | -0.045em |
| Display L (H1/H2) | Aeonik | clamp(32px, 4.2vw, 52px) / 1.04 | 500 | -0.04em |
| Title (card/step heads) | Aeonik | 20 / 1.25 | 500 | -0.02em |
| Lead paragraph | Inter | 16 / 1.6, white at 60% | 400 | 0 |
| Body (the default) | Inter | 15 / 1.5 | 400 | -0.01em |
| Small heading (mini-features) | Inter | 15 / 1.35 | 500 | -0.01em |
| UI label / nav / button S | Inter | 13 / 1.5 | 400-500 | -0.01em |
| Chip / caption | Inter | 12 or 11.5 / 1 | 500 | +0.01em |
| Mono (terminal content) | ui-monospace, SF Mono, Menlo | 13 | 400 | 0 |

Only three weights are used: 400, 500 and 600 (600 appears only in numbered step badges). There is no bold.
For our native app: **SF Pro Display** for display sizes, **SF Pro Text** for anything at 17px or below, and **SF Mono** for mono. Keep the negative tracking on display sizes. Use `text-wrap: balance` on headings and `pretty` on paragraphs.

### Color (dark-only)
| Token | Value | Use |
|---|---|---|
| `bg/canvas` | `#09090A` | page background ("night") |
| `bg/raised` | `#0F0F11` | cards |
| `bg/elevated` | `#141416` at 70% + blur | floating nav pill |
| `fg/primary` | `#FFFFFF` | titles, active text |
| `fg/secondary` | white at 85-90% | body copy inside cards |
| `fg/tertiary` | white at 55-60% | lead text, nav, descriptions |
| `fg/quaternary` | white at 40-50% | inactive tabs, struck prices |
| `hairline` | white at 8% (rest), 15-18% (hover) | 1px ring on cards |
| `fill/control` | white at 8-10% | secondary buttons, chips, toggles |
| `btn/primary` | `#FFFFFF` bg, `#0B0B0C` text; hover `#E4E4E7` | the single primary action |
| `status/working` | `#4C9DFF` (system blue `#0A84FF` for focus) | agent working |
| `status/needs-you` | `#FFC75C` | agent waiting on you |
| `status/done` | `#30D158` (system green) | done |
| `accent/positive` | `#4ADE80` / `#86EFAC` | "live" dots, offer ring, glow |
| `traffic lights` | `#FF5F57` `#FEBC2E` `#28C840` | window chrome in mockups |
| Feature tints (title only) | `#BFE2FF` `#DDD6FF` `#FFC9D9` `#FFD5B0` `#B3F5E3` | one pastel per feature card heading |
| Glass veil | `rgba(12,18,44,0.42)` + white 12% overlay | tinted glass over wallpaper |

Color carries status, never decoration. The surfaces are neutral graphite. The only saturated hues are the three status colors and the soft wallpaper gradients behind the illustrations (for example `linear-gradient(180deg,#22325F,#55659F 46%,#B78896 62%,#2A2A40)`).

### Spacing (4pt base)
The gaps that occur are 4, 6, 8, 10, 12, 16, 24, 32 and 64. Cards are padded `20 24 24`. Section padding runs 96 top and 72 bottom up to 120 vertical. Content max-width is 1120 (layout 1232). Text columns are capped at 34em (lead) and 62ch (FAQ answers). Cards in a grid sit 16 apart. Within a card, 12 separates label from description.

### Radii (concentric)
`pill 9999` (buttons, chips, segmented control, nav) · `24` (outer cards) · `22` (dock) · `18` (floating question card) · `16` (illustration well inset 8px inside a 24 card) · `14/11` (option rows, icon tiles) · `8/6/5` (small keys and badges). The rule is that inner radius equals outer radius minus inset, so 24 minus 8 gives 16.

### Shadows and borders
- Cards have no drop shadow. They use a 1px ring only: `0 0 0 1px rgba(255,255,255,.08)`, rising to `.15` or `.18` on hover.
- Glass controls stack three layers: `inset 0 0 0 1px rgba(255,255,255,.20)` (edge), `inset 0 1px 0 rgba(255,255,255,.32)` (top specular highlight), and `0 14px 30px -12px rgba(4,7,22,.6)` (a soft, tight contact shadow with negative spread).
- The floating nav uses `0 10px 30px -10px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.10)`.
- The primary button hover adds a halo: `0 0 0 4px rgba(255,255,255,.14), 0 10px 30px rgba(255,255,255,.16)`.
- The success glow is `0 0 18px rgba(74,222,128,.28)` plus an inset ring of green at 45%.

### Materials (blur and vibrancy)
| Material | Recipe | macOS equivalent |
|---|---|---|
| Nav pill | `blur(20px) saturate(1.5)`, bg #141416 at 70% | `.headerView` / `.menu` |
| Glass control | `blur(18px) saturate(1.4)`, veil rgba(12,18,44,.42) + white 12% | `.hudWindow` / `.popover` |
| Dock / large tray | `blur(40px)`, white at 17% | `.underWindowBackground` |
| Menu bar strip | `blur(24px)`, black at 30% | `.titlebar` |
| Badges over imagery | `blur(12px)`, near-black at 75% | `.toolTip` |
Saturation is always boosted (1.4 to 1.5) so the color behind the glass reads through. That is what makes it look like Apple glass and not a flat grey frost.

### Motion
| Token | Value | Use |
|---|---|---|
| `ease/out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | the default for opacity, transform and rings |
| `ease/standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | color changes |
| `dur/press` | 100ms | button bg, scale |
| `dur/fast` | 150ms | color, small scale |
| `dur/base` | 200ms | hover ring, tabs, segmented control |
| `dur/slow` | 300ms | opacity cross-fades, nav color |
| `dur/ambient` | 500ms | slow glow or box-shadow shifts |
- Press: `active:scale(0.97)` at 100ms. This is the only tactile scale on the page.
- Arrival: `conversation-arrive` animates from `opacity 0, translateY(7px)` to rest. The logo enters from translateY(8px).
- Live status: `live-ring` pulses a green box-shadow from 0 to a 6px spread, every 1.3 to 2s.
- Progress chapters: `chapter-fill` animates scaleX 0 to 1 under the active chapter chip (a story progress bar).
- Scroll: the hero is a 210svh section holding a `position: sticky; height: 100svh` stage. Scrolling drives a scripted Mac desktop demo that advances through the chapters "Agents ask", "You answer in a keystroke" and "Or from your phone". It has a pause button.
- Attention: `dockbounce` (a two-hop decaying bounce, as in the macOS Dock) and `halo`/`sheen` are reserved for single moments.
- A `prefers-reduced-motion` stylesheet exists. Respect it.

## 3. Component inventory

1. **Floating nav pill.** Fixed 12px from the top and centered. Radius 9999, padding `4 4 4 12`, nav material. Links are 13px at 60% white. The right end holds a small white primary pill (36h, 16px x-padding, with an arrow icon). Over the hero it is a full-width transparent bar that condenses into the pill once you scroll.
2. **Primary button.** White fill, near-black text, 15/500, height 52 (L) or 36 (S), fully round, and a trailing arrow. Hover moves the fill to #E4E4E7 and adds the halo. Press scales to 0.97. The focus ring is a 2px outline at 40% white with 2px offset.
3. **Secondary button.** White at 8-10% fill, 1px inset ring at 12-16%, white text. Over imagery it gets `blur(12px)`. It has the same geometry as the primary.
4. **Floating badge on a button.** A 20h pill above the button's top edge reading "Limited offer · Only 46 left", with a green live dot. It is a blurred dark chip at 11.5/500.
5. **Feature card (carousel).** 300w, radius 24, bg #0F0F11, 8% ring. The top half is an illustration well with a soft wallpaper gradient and a glass mock UI. The bottom half has an icon tile (24px, rounded 6, tinted) next to a title in a pastel tint, then a 60% description and a 90% "how it behaves" line. Horizontal snap scroll with round prev/next arrows (40px, white at 8%).
6. **Step card.** Radius 24 with the illustration well inset 8px (radius 16, height 300). The title row is a numbered badge (24px circle, white at 8%, ring at 10%) followed by a 20px title. On activation the badge cross-fades to a solid white circle (300ms opacity).
7. **Question card (core product UI).** A glass panel about 380w and radius 18. Header: a bold title, a dotted progress indicator and a close X. Agent row: avatar, name and a "Waiting for your answer · web" subtitle. Below that, a question in 15/500, then **numbered option rows** (height 36-48, radius 11, a keycap number at left, the label, and an optional amber "Recommended" tag), then a reply field with mic and send icons. A detached hint pill sits under it: "Press [1], [2] or [3] to answer".
8. **Edge toolbar.** A vertical capsule (about 44w) at the right screen edge. It holds an inbox icon with a count badge (amber circle) and one 10px dot per agent in status colors. Separate capsules hold the voice and screenshot tools and an overflow menu.
9. **Router input.** A glass pill holding a mic icon and the spoken text ("Add a yearly toggle"), next to an Option keycap tile. Agent tiles below show a selection dot on the routed one.
10. **Segmented control.** A pill track at white 8% with a 4px inner pad. The active thumb is a lighter glass pill. Labels are 14/500; inactive labels sit at 60%. The thumb slides in 200ms out-expo. Used for Inbox/Talk and Monthly/Yearly.
11. **Chip / tag.** 24h, 10px x-padding, 12/500, white at 8% fill, inset ring at 10%. The "Recommended" variant is amber text on an amber 15% fill.
12. **Status dot.** 8-10px circle in a status color. The live variant adds the `live-ring` pulse.
13. **Pricing card.** Same card shell. The featured card gets a 1px green ring and a glow, plus a top-center "Limited offer" chip overlapping the border. Price numerals are display weight with superscript currency and cents. A tier ladder shows sold-out steps at 40%, then the current step in green with "46 left".
14. **FAQ.** Native `<details>`/`<summary>` with no marker. Rows separated by a white 8% top border, 20px vertical padding, question at 16/500 and 90%, answer at 14.5/1.65 and 55%, max 62ch. A plus/chevron icon sits at the right.
15. **Chapter scrubber.** Under the hero demo: a pause button (34px circle) next to a pill track of chapter chips (12/500). The active chip is white with a fill bar animating underneath. Inactive chips sit at 50% and go to 80% on hover.
16. **Logo strip.** Monochrome customer logos at roughly 50% white, preceded by a "Used by engineers at" label at 13/500 and 60%.

## 4. The feel: 12 rules

1. **One accent, and it is white.** There is one solid white primary button per view, and everything else is translucent white on graphite. Brand color never competes with status color.
2. **Color means state.** Blue is working, amber needs you, green is done, applied the same way everywhere. Pastels only tint feature titles.
3. **Rings, not shadows, define surfaces.** Use a 1px white ring at 8% on near-black. Drop shadows appear only on floating glass, and they are tight with negative spread.
4. **Glass has three layers:** an edge ring, a top specular inset at 20-32% white, and a saturated blur. Without the top highlight it reads as a flat web panel.
5. **Concentric radii.** 24 outside, 16 for an 8px inset, 11-14 for rows, pill for anything you press.
6. **Two fonts, three weights, no bold.** Display at 500 with tight negative tracking. Body at 15/1.5. Hierarchy comes from opacity steps (100/90/60/40), not from weight.
7. **Every action has a key.** Numbered options and visible keycaps, plus J/K/E and Esc. The hint pill teaches the shortcut in context.
8. **Reversible by default.** Answers wait 2 seconds and Escape undoes them. Calm comes from knowing nothing is final yet.
9. **Ambient first, interrupt rarely.** Status lives in tiny dots at the screen edge. A card appears only when a human decision is needed, and it shows one question at a time.
10. **Recommend, don't decide.** One option carries a quiet "Recommended" tag. The human still presses the key.
11. **Fast and decelerating.** 100-200ms with `cubic-bezier(.16,1,.3,1)`. Things arrive from 7-8px below and fade in. Nothing bounces except a single Dock-style nudge when attention is truly needed.
12. **Plain, short copy.** Two-sentence descriptions: what it is, then exactly how it behaves ("Press 1, 2 or 3 and the agent has its answer."). There is no hype.

## 5. Applying this to our product

Product: a macOS app that observes work for 7 days, finds where the time goes ("65% of your time is manual
email"), proposes an automation ("saves about 90% of that"), lets the user review and approve the built
workflow step by step, then runs a dashboard of automations.

Mapping:
- **Edge toolbar** becomes the observation status. One dot shows the 7-day learning state (blue = observing, amber = an insight is ready, green = automation running). Show a day counter "Day 4 of 7" on hover.
- **Question card** becomes the insight and approval card, with numbered choices (1 Build it, 2 Show me the evidence, 3 Not now).
- **2-second undo** becomes a staged approval. "Turn on" waits for a 5-second countdown with Esc to cancel, and every automation has a dry-run first.
- **Recommended tag** marks our suggested option. The user still decides.
- **Status colors** for automations use the same three: blue = running, amber = needs review (low confidence or a failure), green = healthy.
- Native: NSVisualEffectView `.popover`/`.hudWindow` for cards, `.menu` for the menu-bar panel, SF Pro and SF Symbols, system blue/green/yellow, and spring animations with response 0.3 and damping 0.9 (the native analog of out-expo 200ms).

### Screen A. Menu-bar / notch suggestion (ambient, then interruption)
```
 ───────────────────────────────────────── [◐ notch ◑] ───── ● ⌁ ⌕ 12:15
                                         ╭───────────────────────────────╮
                                         │ ● Insight ready     Day 7/7  ✕│  glass .popover, r18
                                         │                               │
                                         │ Email is 65% of your week     │  15/600 white
                                         │ 18.4 h of 28.3 h tracked      │  13/400, 60%
                                         │ ▇▇▇▇▇▇▇▇▇▇▇▇▇░░░░░░░          │  bar, amber fill
                                         │                               │
                                         │ [1] See the automation   Rec. │  option rows r11
                                         │ [2] Show me the evidence      │
                                         │ [3] Remind me tomorrow        │
                                         ╰───────────────────────────────╯
                                           ( Press 1, 2 or 3 · Esc to dismiss )   hint pill
```
Behavior: it slides down 8px and fades in over 200ms out-expo from the menu-bar item, then auto-collapses to the dot after 12s idle. The menu-bar dot is amber while an insight waits.

### Screen B. Insight card (opened from 1)
```
╭──────────────────────────────────────────────────────────────╮  r24, #0F0F11, ring 8%
│ ╭──────────────────────────────────────────────────────────╮ │
│ │  soft gradient well (r16, 8px inset)                     │ │
│ │   Mon ▇▇▇▇▇▇▇░   Tue ▇▇▇▇▇▇░░   Wed ▇▇▇▇▇▇▇▇  ...        │ │  email minutes per day
│ │   ● Gmail 11.2h   ● Outlook 4.1h   ● Sheets copy 3.1h    │ │  glass chips
│ ╰──────────────────────────────────────────────────────────╯ │
│  You spent 65% of your time on manual emails                 │  SF Pro Display 28/500
│  Mostly replying to invoice questions and copying totals     │  15/400, 60%
│  from Sheets into replies.                                   │
│                                                              │
│  ┌ Proposed automation ───────────────────────────────────┐  │
│  │ Draft invoice replies from Sheets      saves ~90%      │  │  green chip
│  │ 16.6 h back per week · You approve every send          │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  [ Review the workflow → ]   ( Not now )                     │  white primary + glass secondary
╰──────────────────────────────────────────────────────────────╯
```
Evidence before ask: the numbers sit above the proposal. "saves ~90%" is a green chip and never a banner.

### Screen C. Workflow review (approve step by step)
```
╭ Draft invoice replies ─────────────────────── ● Dry run ready ╮
│  ① Trigger   New email in Gmail matching "invoice"     ✓ ok   │  numbered badge 24px
│  ② Read      Look up the invoice # in "AR 2026" sheet  ✓ ok   │
│  ③ Draft     Write a reply using your last 40 replies  ◐ 2/3  │  amber = needs a look
│              ┌ Preview ─────────────────────────────────┐     │
│              │ Hi Dana, invoice 1182 was paid on Oct 3… │     │  mono-free, 14/1.6
│              └──────────────────────────────────────────┘     │
│  ④ Hand off  Save as draft. Never sends on its own.     ✓ ok  │
│                                                               │
│  J/K move · E edit step · Space preview                       │  keycap hints, 12px 50%
│  ─────────────────────────────────────────────────────────    │
│  ( Run dry run again )            [ Approve and turn on → ]   │
╰───────────────────────────────────────────────────────────────╯
   after Approve:  ( Turning on in 5s · Esc to cancel )  ▇▇▇▇░  chapter-fill bar
```

### Screen D. Dashboard of automations
```
 Automations                                  ( Week | Month )      segmented
 ╭────────────╮ ╭────────────╮ ╭────────────╮
 │ 16.6 h     │ │ 3 running  │ │ 1 to review│                        stat tiles, r24
 │ saved/week │ │ ● ● ●      │ │ ●          │                        dots = status colors
 ╰────────────╯ ╰────────────╯ ╰────────────╯
 ┌──────────────────────────────────────────────────────────────┐
 │ ● Invoice replies     Gmail → Sheets     41 runs   9.8 h   ›│   row h56, ring 8%
 │ ● Weekly AR summary   Sheets → Email      1 run    1.2 h   ›│   hover ring 15%
 │ ● Lead intake         Form → CRM          2 fails  needs you›│   amber dot + chip
 └──────────────────────────────────────────────────────────────┘
 Observing · Day 3 of 7 for new patterns  ● (live-ring pulse)       footer status, 13px 60%
```

### Build checklist for UI engineers
- Dark-first graphite surfaces (#09090A, #0F0F11) with a 1px white 8% ring, and a light-mode mirror later.
- One white primary per view. Everything else is a translucent fill.
- Glass = blur 18-20 + saturate 1.4 + edge ring + top specular.
- Motion tokens: 100/150/200/300ms with out-expo. Press scale 0.97. Arrive from 7px below.
- Every card has numbered options and keycaps. Every irreversible action gets an Esc countdown.
- Status colors: blue, amber and green only, used the same way everywhere.
