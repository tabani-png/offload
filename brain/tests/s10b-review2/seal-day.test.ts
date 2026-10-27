// s10b N3 (REVIEW-2): sealed artefacts are dated, and purged, by the CAPTURE day of the oldest source data they
// contain, never by the day they were written. The case from the review: OCR captured 2026-10-16, dry run written
// 2026-10-19: sealed under 10-16, readable through 11-15 (30 local days), gone from 11-16.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { purgeExpired, sealedDay, sealText, openText } from "../../src/store/vault.ts";
import { dryRun, readLastDryRun } from "../../src/workflows/dryrun.ts";
import { listBatches, workflowDir } from "../../src/workflows/store.ts";
import { local } from "../s09b-brain/setup.ts";
import { world, type World } from "../s05-workflows/setup.ts";

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(() => w.cleanup());

const WRITTEN = local(2026, 10, 19, 12);

describe("s10b N3: seal day = capture day", () => {
  test("N3: a dry run of 10-16 captures written on 10-19 is sealed under 2026-10-16 (file, history and its batch)", async () => {
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 1, now: () => WRITTEN });
    expect(r.instances.map((i) => i.day)).toEqual(["2026-10-16"]);
    const dir = workflowDir(w.home, w.outreach.id);
    expect(sealedDay(join(dir, "dry-run.json.enc"))).toBe("2026-10-16");
    for (const n of readdirSync(join(dir, "dry-runs"))) expect(sealedDay(join(dir, "dry-runs", n))).toBe("2026-10-16");
    expect(sealedDay(join(dir, "batches", `${r.batchHash}.json.enc`))).toBe("2026-10-16");
  });

  test("N3: readable through 2026-11-15, refused and purged on 2026-11-16 (not 11-18)", async () => {
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 1, now: () => WRITTEN });
    expect(readLastDryRun(w.home, w.outreach.id, local(2026, 11, 15, 23, 59))).not.toBeNull();
    const at = local(2026, 11, 16, 0, 1);
    expect(readLastDryRun(w.home, w.outreach.id, at)).toBeNull();
    purgeExpired(w.home, at, { log: () => {} });
    const dir = workflowDir(w.home, w.outreach.id);
    expect(existsSync(join(dir, "dry-run.json.enc"))).toBe(false);
    expect(existsSync(join(dir, "batches", `${r.batchHash}.json.enc`))).toBe(false);
    expect(listBatches(w.home, w.outreach.id, at).filter((b) => b.kind === "dry_run")).toEqual([]);
  });

  test("N3: with instances from several days the oldest one dates the file", async () => {
    const r = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 50, now: () => WRITTEN });
    const oldest = [...r.instances.map((i) => i.day)].sort()[0]!;
    expect(r.instances.length).toBeGreaterThan(1);
    expect(sealedDay(join(workflowDir(w.home, w.outreach.id), "dry-run.json.enc"))).toBe(oldest);
  });

  test("N3: a dry run with no instances is dated by the day it ran", async () => {
    const empty = { ...w.analysis, tasks: [] };
    const r = await dryRun({ home: w.home, analysis: empty, workflowId: w.outreach.id, model: w.model, now: () => WRITTEN });
    expect(r.instances).toEqual([]);
    expect(sealedDay(join(workflowDir(w.home, w.outreach.id), "dry-run.json.enc"))).toBe("2026-10-19");
  });

  test("N3: sealText takes a day label as well as a timestamp", () => {
    const f = join(w.home, "x.enc");
    sealText(w.home, f, "hello", "2026-10-16");
    expect(sealedDay(f)).toBe("2026-10-16");
    expect(openText(w.home, f, WRITTEN)).toBe("hello");
    expect(() => sealText(w.home, f, "x", "2026-13-99")).toThrow();
  });
});
