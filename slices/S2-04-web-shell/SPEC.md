---
id: S2-04-web-shell
title: Admin web shell - design tokens, layout, every screen on a schema-driven mock API
depends_on: [schemas/stage2 (frozen), plan/stage-2/API.md, app/Sources/Core/Tokens.swift + app/Sources/Design/* (read-only reference)]
parallel_safe: true
starts: immediately (wave A)
human_gated: false
verify: bash slices/S2-04-web-shell/verify.sh
paths_in_scope: [web/**, slices/S2-04-web-shell/**]
paths_out_of_scope: [app/** (read-only), brain/**, control/**, packages/**, schemas/** (frozen), engine/**, packet/**]
---

# S2-04 admin web shell

## Summary
ADR 0110. React 19 + Vite 7 SPA with TanStack Router and Query. Every screen of the admin dashboard runs against a
mock API whose fixtures validate against `schemas/stage2`. S2-11 later swaps the mock for the real API without
changing screens.

## Dependencies (pin exact versions at slice start; record them here under "Scope changes")
react, react-dom, @tanstack/react-router, @tanstack/react-query, vite, @vitejs/plugin-react, typescript 5.9.3,
dev: happy-dom, @testing-library/react, ajv (2020 build). No CSS framework, no component kit, no chart library
(rings and bars are our own SVG components).

## Design system (must match the Mac app)
- `web/src/design/tokens.ts` mirrors `Tokens.swift`: 4-pt spacing, radii card 24 / well 16 / row 12 (+ key 5,
  control 6), the type scale (SF Pro via `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui`; weights 400
  and 500 only; hierarchy by opacity), motion easing `cubic-bezier(0.16,1,0.3,1)` and the app's durations.
- Dark hero surfaces; white is the only primary action colour; colour is used only for state (ok, waiting, needs
  you, failed, suppressed); progress and shares as rings; focus rings visible; reduced motion respected.
- `web/src/design/` components: Card, Well, Row, Ring, StatHero, GradeSplit (A/B/C), StateDot, Keycap, Sheet,
  Table (no sort-by-person affordance), SuppressedCell ("Fewer than 5 people"), FeatureOffPanel.

## Screens (routes)
`/` company overview (hours saved hero + ring of A/B/C, trend, by department, top workflows, overnight share,
quality); `/departments/:id`; `/workflows` registry + `/workflows/:id` (versions, promote sheet, SOP preview);
`/approvals` (pending batches, batch sheet); `/digest`; `/workers` + run detail; `/people` (directory only: name,
department, access role, state; metrics column exists only when per_person_views is on); `/offboarding` +
hand-over sheet; `/compliance` (features, enable sheet with DPIA attestation, notices, acks, audit log, chain
verify); `/me` self-view (incl. who viewed my data).

## Acceptance (tag = test name prefix in web/tests/)
- TOKENS: parity test parses `app/Sources/Core/Tokens.swift` and asserts radii, spacing and easing equal tokens.ts.
- SCHEMA: every mock fixture validates against its schema with Ajv; mock routes cover every GET in API.md.
- ROUTES: each route renders with fixtures (happy-dom) and shows its primary content.
- STATES: suppressed cells render the floor message and no number; sensitive views hidden when the feature is off;
  errors render plain words from `error.code`.
- NORANK: no table of people offers sorting by a metric; grep finds no `sort` over person metrics.
- A11Y: text/background contrast ≥ 4.5:1 for body tokens; every interactive element focusable with a visible ring.
- BUILD: `vite build` succeeds; bundle has no source maps with absolute local paths.

## Done-signal
`verify.sh`: typecheck, ≥ 50 tests, tags, build.
