// SAFETY / RECORD (Codex review of 85c0ec8): nothing in the retained artifact is excluded from the integrity and
// secret checks. Disposable folders (__pycache__, .tmp, .pytest_cache, ...) are deleted before the final hash, then
// everything that remains is hashed and scanned; verifyArtifact hashes everything and fails if one reappears.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveBuild } from "../../src/builder/approval.ts";
import { verifyArtifact } from "../../src/builder/record.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { fakeQuery, NOW, prepared, releaseTemps, writeSlug } from "./setup.ts";

// Remove every temp folder this file created (and fail if one is left).
afterAll(releaseTemps);

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

async function pass(act: (ws: string) => void = writeSlug("good")) {
  const p = await prepared();
  const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
  const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: fakeQuery([{ act }]).query, profile: ALLOW, limits: { maxTries: 1 } });
  return { p, rec };
}

describe("s24 nothing is skipped", () => {
  test("RECORD: bytecode added or changed after PASS makes verifyArtifact false (no __pycache__ exemption)", async () => {
    const { p, rec } = await pass((ws) => {
      writeSlug("good")(ws);
      mkdirSync(join(ws, "__pycache__"));
      writeFileSync(join(ws, "__pycache__", "slug.cpython-314.pyc"), "original bytecode");
    });
    expect(rec.outcome).toBe("PASS");
    // Disposable folders are gone from the kept artifact.
    expect(readdirSync(rec.artifactPath)).not.toContain("__pycache__");
    expect(verifyArtifact(p.home, rec.id)).toBe(true);
    mkdirSync(join(rec.artifactPath, "__pycache__"));
    writeFileSync(join(rec.artifactPath, "__pycache__", "slug.cpython-314.pyc"), "different behaviour");
    expect(verifyArtifact(p.home, rec.id)).toBe(false);
  }, 30_000);

  test("SAFETY: a secret placed in __pycache__ is not a PASS", async () => {
    const { rec } = await pass((ws) => {
      writeSlug("good")(ws);
      mkdirSync(join(ws, "__pycache__"));
      writeFileSync(join(ws, "__pycache__", "leak.pyc"), "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab");
    });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("artifact contains a secret");
  }, 30_000);

  test("SAFETY: a secret placed in .tmp is not a PASS", async () => {
    const { rec } = await pass((ws) => {
      writeSlug("good")(ws);
      writeFileSync(join(ws, ".tmp", "leak.txt"), "AKIAABCDEFGHIJKLMNOP");
    });
    expect(rec.outcome).not.toBe("PASS");
    expect(rec.reason ?? "").toContain("artifact contains a secret");
  }, 30_000);

  test("RECORD: a .tmp file added after PASS makes verifyArtifact false", async () => {
    const { p, rec } = await pass();
    expect(rec.outcome).toBe("PASS");
    mkdirSync(join(rec.artifactPath, ".tmp"), { recursive: true });
    writeFileSync(join(rec.artifactPath, ".tmp", "x"), "x");
    expect(verifyArtifact(p.home, rec.id)).toBe(false);
  }, 30_000);
});
