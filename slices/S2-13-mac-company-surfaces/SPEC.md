---
id: S2-13-mac-company-surfaces
title: Mac app company surfaces - connect to company, notice sheet, share-with-team preview, sync status, self-view link
depends_on: [S2-02-mac-sync-client (brain routes), S2-08-compliance (notice content and acks)]
parallel_safe: true
starts: wave C
human_gated: false
verify: bash slices/S2-13-mac-company-surfaces/verify.sh
paths_in_scope: [app/Sources/Surfaces/Company/** (new), app/Sources/Core/CompanyClient.swift (new), app/Sources/Surfaces/Windows.swift + OnboardingWindow.swift (additive entry points only; Scope changes note), app/snapshots/company/**, app/tests or snapshot harness additions, slices/S2-13-mac-company-surfaces/**]
paths_out_of_scope: [brain/**, engine/**, control/**, web/**, app/Sources/Design/** (use components, do not change), schemas/** (frozen)]
---

# S2-13 Mac company surfaces

## Summary
UI for the S2-02 brain routes with the existing design system (s06-s10e components; plain swiftc build, ADR 0002).

## Acceptance (snapshot + model tests)
- CONNECT: "Connect to company" opens the browser sign-in and shows connected state with tenant name.
- NOTICE: the notice sheet renders the tenant's Markdown, lists what the company sees and what it never sees, shows
  the features on for me, and records the ack through `POST /sync/notice/ack`; no sync before ack.
- SHARE: "Share with my team" shows the exact JSON preview from `GET /workflows/:id/share` in plain words with a
  "View source" disclosure; confirm queues it.
- STATUS: rail/dashboard show sync state (paused, waiting for notice, last sync) with colour = state only.
- SELFVIEW: a link opens `/me` in the browser.
- SNAPSHOTS: light/dark snapshots for each new surface; design review checklist (radii, easing, white primary only).

## Done-signal
`verify.sh`: app builds with `app/build.sh`; model tests pass; snapshots present; Design/** untouched.
