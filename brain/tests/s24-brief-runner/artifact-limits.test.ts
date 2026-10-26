// SAFETY (Codex review of e0f40de): the artifact is sized BEFORE it is read. A sparse file (huge logical length, few
// real blocks) and a workspace over the total cap fail closed without reading the data; hashing then runs
// asynchronously in chunks so it never blocks the brain.
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { fakeQuery, NOW, prepared, writeSlug, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

describe("s24 artifact limits", () => {
  test("SAFETY: a sparse file is rejected without reading its logical length (fast, 'sparse')", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); const s = join(ws, "sparse.bin"); writeFileSync(s, ""); truncateSync(s, 8 * 1024 * 1024 * 1024); } }]);
    const t0 = Date.now();
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("sparse");
    expect(Date.now() - t0).toBeLessThan(10_000);
    rmSync(join(rec.artifactPath, "sparse.bin"), { force: true });
  }, 60_000);

  test("SAFETY: a workspace over the total size cap is rejected before hashing ('workspace too large')", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const chunk = Buffer.alloc(60 * 1024 * 1024, 0x62);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); for (let i = 0; i < 5; i++) writeFileSync(join(ws, `blob${i}.bin`), chunk); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("workspace too large");
    rmSync(p.home, { recursive: true, force: true });
  }, 120_000);

  test("SAFETY: hashing does not block the event loop (a timer keeps firing while a large artifact is hashed)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const chunk = Buffer.alloc(50 * 1024 * 1024, 0x63);
    let maxGap = 0;
    let last = Date.now();
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); for (let i = 0; i < 4; i++) writeFileSync(join(ws, `data${i}.bin`), chunk); last = Date.now(); } }]);
    const tick = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW, limits: { maxTries: 1 } });
    clearInterval(tick);
    expect(rec.outcome).toBe("PASS");
    // Synchronous hashing of 200 MB blocks for ~270 ms at a time here; chunked async hashing yields every few ms.
    expect(maxGap).toBeLessThan(150);
    rmSync(p.home, { recursive: true, force: true });
  }, 120_000);
});
