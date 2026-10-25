// REF: instanceRef = hex(HMAC-SHA256(deviceEvidenceKey, localInstanceId))[0:32]; same instance -> same ref on one
// device; another evidence key -> another ref; a ref resolves only on the Mac that holds the key and the map.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceKey, purgeRefs, refsDir } from "../../src/sync/evidence-key.ts";
import { clearSyncKeyCache, rawKeyPath } from "../../src/sync/keys.ts";
import { clearBrainKeyCache } from "../../src/store/vault.ts";
import { tempHome } from "../helpers.ts";
import { NOW } from "./setup.ts";

const DAY_MS = 86_400_000;
let home: string;
let cleanup: () => void;
beforeEach(() => {
  clearSyncKeyCache();
  clearBrainKeyCache();
  ({ home, cleanup } = tempHome());
});
afterEach(() => cleanup());

test("REF: a ref is the first 32 hex chars of HMAC-SHA256(deviceEvidenceKey, localInstanceId)", () => {
  const key = new Uint8Array(32).fill(7);
  const ek = EvidenceKey.fromBytes(home, key);
  const want = createHmac("sha256", key).update("in_01M4QMSBNS6MFWR7YKNNZ247M9").digest("hex").slice(0, 32);
  expect(ek.ref("in_01M4QMSBNS6MFWR7YKNNZ247M9")).toBe(want);
  expect(want).toMatch(/^[0-9a-f]{32}$/);
});

test("REF: the same instance gives the same ref on one device, also after a restart (stored key)", () => {
  const a = EvidenceKey.load(home, { create: true })!;
  const r1 = a.ref("in_A");
  expect(a.ref("in_A")).toBe(r1);
  clearSyncKeyCache();
  const b = EvidenceKey.load(home, { create: false })!;
  expect(b.ref("in_A")).toBe(r1);
  expect(b.ref("in_B")).not.toBe(r1);
  expect(readFileSync(rawKeyPath(home, "device-evidence"))).toHaveLength(32);
});

test("REF: a different evidence key (another Mac) gives a different ref for the same instance id", () => {
  const other = tempHome();
  try {
    const a = EvidenceKey.load(home, { create: true })!;
    const b = EvidenceKey.load(other.home, { create: true })!;
    expect(a.ref("in_A")).not.toBe(b.ref("in_A"));
  } finally {
    other.cleanup();
  }
});

test("REF: a ref resolves to the instance only on the Mac that made it; elsewhere it is opaque", () => {
  const a = EvidenceKey.load(home, { create: true })!;
  const day = "2026-10-15";
  const refs = a.remember([{ instanceId: "in_A", day }, { instanceId: "in_B", day }], NOW);
  const ref = refs.get("in_A")!;
  expect(a.resolve(ref, NOW)).toEqual({ instanceId: "in_A", day });
  const other = tempHome();
  try {
    const b = EvidenceKey.load(other.home, { create: true })!;
    expect(b.resolve(ref, NOW)).toBeNull();
  } finally {
    other.cleanup();
  }
  expect(a.resolve("0".repeat(32), NOW)).toBeNull();
  expect(a.resolve("not-a-ref", NOW)).toBeNull();
});

test("REF: the local ref map is sealed (no instance id in plaintext) and follows the 7-day rule", () => {
  const a = EvidenceKey.load(home, { create: true })!;
  const ref = a.remember([{ instanceId: "in_SECRET_INSTANCE", day: "2026-10-12" }], NOW).get("in_SECRET_INSTANCE")!;
  for (const f of readdirSync(refsDir(home))) expect(readFileSync(join(refsDir(home), f), "utf8")).not.toContain("in_SECRET_INSTANCE");
  expect(a.resolve(ref, NOW)).not.toBeNull();
  // 2026-10-12 is 8 days old on 2026-10-20: it no longer resolves, and the purge deletes the map.
  expect(a.resolve(ref, NOW + DAY_MS)).toBeNull();
  expect(purgeRefs(home, NOW + DAY_MS)).toEqual(["2026-10-12"]);
  expect(existsSync(join(refsDir(home), "2026-10-12.json.enc"))).toBe(false);
});

test("REF: instances older than 7 days get no ref and no map entry", () => {
  const a = EvidenceKey.load(home, { create: true })!;
  const refs = a.remember([{ instanceId: "in_OLD", day: "2026-10-01" }, { instanceId: "in_NEW", day: "2026-10-18" }], NOW);
  expect([...refs.keys()]).toEqual(["in_NEW"]);
});

test("REF: object ids are deterministic per device key and differ between devices", () => {
  const a = EvidenceKey.fromBytes(home, new Uint8Array(32).fill(1));
  const b = EvidenceKey.fromBytes(home, new Uint8Array(32).fill(2));
  expect(a.ids("run_outcome", "x", NOW)).toBe(a.ids("run_outcome", "x", NOW));
  expect(a.ids("run_outcome", "x", NOW)).not.toBe(b.ids("run_outcome", "x", NOW));
  expect(a.ids("run_outcome", "x", NOW)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
});
