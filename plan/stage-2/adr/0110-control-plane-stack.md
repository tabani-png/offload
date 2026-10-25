# 0110 Control plane and admin web stack

Date: 2026-10-25. Status: proposed. Details and rejected options: plan/stage-2/plan.md "Tech choices".

## Decision
- Control plane: Bun 1.3 + TypeScript strict (brain's tsconfig flags), Hono router on `Bun.serve`, `Bun.sql` to
  Postgres 17, plain SQL migrations with per-slice number ranges, Ajv 8 (JSON Schema 2020-12) validating every request
  and sync object against `schemas/stage2/`, `@anthropic-ai/sdk` 1.3.0 (`client.beta.*` for Managed Agents) behind a
  narrow interface with a fake, WorkOS Node SDK behind a narrow interface with a fake.
- Reuse: the broker imports the brain's pure batch-hash, canonical-hash and allowlist functions read-only by relative
  path; it never edits `brain/`. If a function is not pure, S2-07 copies it with a parity test, and a later ADR extracts
  a shared package.
- Admin web: React 19 + Vite 7 SPA, TanStack Router + Query, CSS variables from `web/src/design/tokens.ts`, which
  mirrors `app/Sources/Core/Tokens.swift` (a parity test reads the Swift file). Dark hero surfaces, white is the only
  primary action colour, colour encodes state only, progress as rings, radii 24/16/12, motion easing
  `cubic-bezier(0.16,1,0.3,1)`, SF Pro / system font stack, no bold weights.
- Local: `control/docker-compose.yml` with `postgres:17-alpine` only. No deploy in Stage 2 build slices.
- New dependencies need the coordinator's sign-off and a pinned version in the slice SPEC.
