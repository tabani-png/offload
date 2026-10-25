# Offload admin web (S2-04)

React 19 + Vite 7 SPA with TanStack Router and Query, on a mock API built from `schemas/stage2`. Contract:
`slices/S2-04-web-shell/SPEC.md`. Decision: ADR 0110. S2-11 swaps the mock for the real API with `VITE_API=real`
(the same `ApiClient` interface; screens do not change).

```sh
bun install --frozen-lockfile
bun run dev                     # mock API, http://localhost:5174
bun test tests                  # happy-dom + @testing-library/react
bash ../slices/S2-04-web-shell/verify.sh
```

Mock switches for review: `?features=per_person_views,working_time` turns the sensitive features on (they are off by
default), `?theme=light` shows the light palette.

## Layout
- `src/design/tokens.ts`: mirror of `app/Sources/Core/Tokens.swift` and `Theme.swift` (spacing, radii 24/16/12, type
  scale, durations, `cubic-bezier(0.16, 1, 0.3, 1)`, state colours). `tokenCss()` writes them as CSS variables.
- `src/design/components.tsx` + `styles.css`: Card, Well, Row, Ring, StatHero, GradeSplit, StateDot, Keycap, Sheet,
  Table (no sort prop), SuppressedCell, FeatureOffPanel, Bars, Segmented. Plain CSS, no framework.
- `src/api/`: `client.ts` (interface, HTTP client with CSRF, error words), `types.ts`, `mock/` (fixtures, hs-1 shaped
  metrics, route table covering every GET in `plan/stage-2/API.md`).
- `src/screens/`: one file per screen. `src/app/`: router, shell, data hooks.
- `tests/`: tags TOKENS, SCHEMA, ROUTES, STATES, NORANK, A11Y, BUILD.
- `scripts/screenshots.cjs` + `screenshots/`: Playwright captures of every view (uses the machine's Playwright; not a
  dependency).

## Keyboard
`1`-`9` move between views. Tables: `j`/`k` or arrows, `Enter` opens. `Enter` runs the view's white primary action
where its button shows the ↩ keycap. Sheets: focus moves in, `Tab` is trapped, `Esc` closes and returns focus.
Workflow page: `P` promote, `S` SOP preview, `E` evidence.

## Pinned versions (exact)
| package | version | why |
|---|---|---|
| react, react-dom | 19.3.1 | SPEC |
| @tanstack/react-router | 1.170.46 | SPEC |
| @tanstack/react-query | 5.104.5 | SPEC |
| vite | 7.3.7 | SPEC says Vite 7 (8.x is current; not taken) |
| @vitejs/plugin-react | 5.2.0 | last line that supports Vite 7 (6.x needs Vite 8) |
| typescript | 5.9.3 | SPEC |
| happy-dom | 21.0.4 | test only |
| @testing-library/react | 16.3.3 | test only |
| @testing-library/dom | 10.4.2 | test only; required peer of @testing-library/react |
| ajv | 8.20.0 | test only (2020-12 build) |
| @types/react, @types/react-dom | 19.3.0 | types |
| @types/bun | 1.3.12 | types; same pin as packages/hours-saved |

The SPEC asks for these under "Scope changes" in SPEC.md, but SPEC.md is frozen for builders, so they are recorded
here instead.
