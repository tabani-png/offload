// GATE: a build starts only after the exact single-use approval of this brief hash + this check-script hash.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { BriefError } from "../../src/solutions/brief.ts";
import { fakeQuery, NOW, prepared, writeSlug, releaseTemps } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof BriefError ? e.code : String(e)));

describe("s24 build gate", () => {
  test("GATE: no build without an approval: refused before any workspace exists and the SDK is never called", async () => {
    const p = await prepared();
    const f = fakeQuery([{ act: writeSlug("good") }]);
    expect(await codeOf(runBuild({ home: p.home, briefId: p.briefId, token: "nope", query: f.query, profile: ALLOW }))).toBe("forbidden");
    expect(f.seen).toHaveLength(0);
    expect(existsSync(join(p.home, "builds"))).toBe(false);
  });

  test("GATE: an approval naming a different check hash is rejected", async () => {
    const p = await prepared();
    expect(() => approveBuild(p.home, p.briefId, p.briefHash, "0".repeat(64), NOW)).toThrow(/not the current check script/);
  });

  test("GATE: an approval naming a stale brief hash is rejected", async () => {
    const p = await prepared();
    expect(() => approveBuild(p.home, p.briefId, "f".repeat(64), p.checkHash, NOW)).toThrow(/not this brief's current content/);
  });

  test("GATE: the token is single use", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    expect((await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW })).outcome).toBe("PASS");
    expect(await codeOf(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW }))).toBe("conflict");
    expect(f.seen).toHaveLength(1);
  });

  test("GATE: a wrong token is refused", async () => {
    const p = await prepared();
    approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{}]);
    expect(await codeOf(runBuild({ home: p.home, briefId: p.briefId, token: "x".repeat(43), query: f.query, profile: ALLOW }))).toBe("forbidden");
  });

  test("GATE: a check script changed on disk after approval is refused (no build)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    writeFileSync(join(p.home, "solutions", p.briefId, "checks", "accept.py"), "import sys\nsys.exit(0)\n");
    const f = fakeQuery([{}]);
    expect(await codeOf(runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW }))).toBe("conflict");
    expect(f.seen).toHaveLength(0);
  });

  test("GATE: an edited brief file is refused at approval", async () => {
    const p = await prepared();
    const bp = join(p.home, "solutions", p.briefId, "brief.json");
    const b = JSON.parse(require("node:fs").readFileSync(bp, "utf8"));
    b.spec.builderPrompt += " and also email everyone";
    writeFileSync(bp, JSON.stringify(b));
    expect(() => approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW)).toThrow(/changed after it was drafted/);
  });
});
