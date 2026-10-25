---
id: S2-02-mac-sync-client
title: Mac sync client - enrollment, device key, projector, consent gate, signed outbox
depends_on: [Stage 1 brain (s05 workflows, s09 demo fixture); schemas/stage2 (frozen)]
parallel_safe: true
starts: immediately (wave A; a fake control plane in the tests stands in for S2-01/S2-05)
human_gated: false
verify: bash slices/S2-02-mac-sync-client/verify.sh
paths_in_scope: [brain/src/sync/**, brain/src/api/sync-routes.ts, brain/src/api/server.ts (mount sync routes, additive), brain/src/store/retention.ts (outbox purge, additive), brain/tests/S2-02-sync/**, brain/API.md (new "Company sync" section), slices/S2-02-mac-sync-client/**]
paths_out_of_scope: [brain/src/workflows/** (read-only), brain/src/connectors/**, brain/src/understanding/**, brain/src/vision/**, engine/**, app/**, control/**, web/**, packages/**, schemas/** (frozen), packet/**]
---

# S2-02 Mac sync client

## Summary
ADR 0103. The brain gains a sync client that can emit only the closed set of sync objects, only when consent allows,
signed by a device key, through an encrypted local outbox. No raw data has a code path to the network.

## Design
- `sync/device.ts`: P-256 key pair via WebCrypto; private key bytes wrapped by the observer
  (`offload-observer wrap-key --name device-signing`; `OFFLOAD_KEYS=file` in tests); public JWK for enrollment.
- `sync/enroll.ts`: opens the AuthKit URL from the control plane (`OFFLOAD_CONTROL_URL`), PKCE + loopback redirect on
  127.0.0.1 to receive the enrollment code, then `POST /v1/devices/enroll`; challenge/token refresh before expiry.
- `sync/evidence-key.ts`: 32-byte `deviceEvidenceKey` (observer-wrapped, name `device-evidence`);
  `instanceRef = hex(HMAC-SHA256(key, localInstanceId))[0:32]`; local map ref → instance kept with the 7-day rule.
- `sync/project/*.ts`: one projector per kind, reading brain state read-only (workflow store, batches, observed
  baselines, review timings, dashboard numbers) and returning objects typed from the schemas. Projectors receive
  only typed numeric/id inputs (a narrow `ProjectionInput`), never Events, spans, OCR, frame notes, recipients,
  subjects or bodies.
- `sync/consent.ts`: gates G1-G5 from `GET /v1/sync/config`; unknown config = send nothing but `notice_ack`.
- `sync/envelope.ts`: RFC 8785 JCS canonicalisation (own small implementation with test vectors), ES256 sign,
  `Offload-Signature` header, `seq` persisted, ≤ 500 objects / 1 MiB per envelope.
- `sync/outbox.ts`: sealed with brain day keys (`brain-YYYY-MM-DD`), purged after 7 days with a purge-log line;
  flush every 15 min and after each run; backoff to 6 h; handles `SyncReceipt` (retry only retryable codes).
- `api/sync-routes.ts` (local brain API, bearer token as today): `GET /sync/status`, `POST /sync/connect`,
  `POST /sync/pause|resume`, `GET /sync/preview` (the exact JSON of the next envelope), `POST /sync/notice/ack`,
  `POST /workflows/:id/share` (G4: returns the proposal JSON for preview; `?confirm=1` queues it).

## Acceptance (tag = test name prefix in brain/tests/S2-02-sync/)
- PROJECT: each projector's output validates against its schema; property test over the s09 demo fixture (100
  outreach emails/day): the serialized outbox contains none of the fixture's recipient addresses, subjects, body
  sentences, window titles, URLs or hosts.
- CONSENT: before ack only notice_ack leaves; working_time only when enabled + acked + past notice period; feature
  turned off in config → queued working_time objects are dropped; share needs confirm.
- ENVELOPE: JCS test vectors (RFC 8785 appendix); signature verifies with the public JWK; seq strictly increases
  across restarts; size limits split envelopes.
- REF: same instance → same ref on one device; different evidence key → different ref; ref resolves locally only.
- OUTBOX: sealed on disk (no plaintext JSON in the file); 7-day purge with purge-log line; retry/backoff; receipt
  handling.
- ENROLL: PKCE loopback flow against a fake control plane; token refresh before expiry; revoked device stops sync.
- ROUTES: local routes require the bearer token; preview equals what is sent next.
- HERMETIC: no test opens a non-loopback socket.

## Done-signal
`verify.sh`: brain typecheck; suite ≥ 70 tests; tags pass; full brain suite passes; `brain/src/sync/project/**`
imports nothing from `store/`, `understanding/`, `vision/`, `tone/` or the event types (static check).
