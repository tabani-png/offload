// SAFETY / TAMPER / LOOP (Codex review of af0711a): accept/ is protected by CANONICAL path (a symlinked alias of it is
// still accept/), sandboxed builder code cannot create symlinks or hard links at all (no swap window for the
// unsandboxed SDK file tools), the whole accept/ listing is locked (a new file there = TAMPER), and a relative --home
// is made absolute before any path is derived.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { approveBuild, consumeBuildApproval } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { decideTool } from "../../src/builder/sandbox.ts";
import { fakeQuery, NOW, prepared, tmp, writeSlug, shell } from "./setup.ts";

const ALLOW = { mode: "allowlist" as const, containerSandbox: false };

describe("s24 canonical accept/", () => {
  test("SAFETY: Write, Edit and Bash through a symlinked alias of accept/ are denied", () => {
    const ws = tmp("offload-s24-ws-");
    mkdirSync(join(ws, "accept"));
    writeFileSync(join(ws, "accept", "accept.py"), "x");
    symlinkSync(join(ws, "accept"), join(ws, "alias"));
    symlinkSync("accept", join(ws, "rel-alias"));
    expect(decideTool(ws, "Write", { file_path: "alias/json.py", content: "x" }).allow).toBe(false);
    expect(decideTool(ws, "Write", { file_path: join(ws, "rel-alias", "json.py"), content: "x" }).allow).toBe(false);
    expect(decideTool(ws, "Edit", { file_path: "alias/accept.py", old_string: "x", new_string: "y" }).allow).toBe(false);
    expect(decideTool(ws, "Bash", { command: "cp slug.py alias/json.py" }).allow).toBe(false);
    expect(decideTool(ws, "Bash", { command: "mkdir rel-alias/sub" }).allow).toBe(false);
    // A write that goes through ANY symlink inside the workspace is refused (no check-then-swap window).
    mkdirSync(join(ws, "real"));
    symlinkSync(join(ws, "real"), join(ws, "other"));
    expect(decideTool(ws, "Write", { file_path: "other/a.py", content: "x" }).allow).toBe(false);
    expect(decideTool(ws, "Write", { file_path: "real/a.py", content: "x" }).allow).toBe(true);
  });

  test("SAFETY: sandboxed builder code cannot create symlinks or hard links in the workspace", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    let out = "";
    const f = fakeQuery([
      {
        act: async (ws, o) => {
          writeSlug("good")(ws);
          writeFileSync(
            join(ws, "links.py"),
            ["import os", "for n, f in [('symlink-accept', lambda: os.symlink('accept', 'alias')), ('symlink-any', lambda: os.symlink('slug.py', 's2')), ('hardlink-accept', lambda: os.link('accept/accept.py', 'h1')), ('hardlink-any', lambda: os.link('slug.py', 'h2'))]:", "    try:", "        f(); print('ESCAPED ' + n)", "    except Exception as e:", "        print('BLOCKED ' + n)", ""].join("\n"),
          );
          const r = await o.canUseTool!("Bash", { command: "python3 links.py" }, { signal: new AbortController().signal, toolUseID: "t" } as never);
          const cmd = String((r as unknown as { updatedInput: { command: string } }).updatedInput.command);
          const sh = await shell(cmd, ws);
          out = `${sh.stdout}${sh.stderr}`;
        },
      },
    ]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    for (const n of ["symlink-accept", "symlink-any", "hardlink-accept", "hardlink-any"]) expect(out).toContain(`BLOCKED ${n}`);
    expect(out).not.toContain("ESCAPED");
    expect(existsSync(join(rec.artifactPath, "alias"))).toBe(false);
    expect(rec.outcome).toBe("PASS");
  }, 30_000);

  test("TAMPER: a new file appearing under accept/ (e.g. a module that shadows the check's imports) ends the run as TAMPER", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const f = fakeQuery([{ act: (ws) => { writeSlug("good")(ws); writeFileSync(join(ws, "accept", "subprocess.py"), "raise SystemExit(0)\n"); } }]);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("TAMPER");
    expect(rec.tries[0]!.checkExit).toBeNull();
  }, 30_000);
});

describe("s24 relative home", () => {
  test("LOOP: a relative home works (paths made absolute before the approval is used)", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const rel = relative(process.cwd(), p.home);
    expect(rel.startsWith("/")).toBe(false);
    const f = fakeQuery([{ act: writeSlug("good") }]);
    const rec = await runBuild({ home: rel, briefId: p.briefId, token, query: f.query, profile: ALLOW });
    expect(rec.outcome).toBe("PASS");
    expect(rec.artifactPath.startsWith("/")).toBe(true);
    expect(f.seen[0]!.options.cwd!.startsWith("/")).toBe(true);
  }, 30_000);
});

describe("s24 input paths", () => {
  test("GATE: a brief id that is not a sol_ id (path traversal) is refused before any file is read or written", async () => {
    const p = await prepared();
    // A valid brief + checks copied to a folder outside solutions/, reachable only by traversal.
    require("node:fs").cpSync(join(p.home, "solutions", p.briefId), join(p.home, "evil"), { recursive: true });
    expect(() => approveBuild(p.home, "../evil", p.briefHash, p.checkHash, NOW)).toThrow(/no brief|brief id/);
    expect(existsSync(join(p.home, "evil", "build-approval.json"))).toBe(false);
    for (const bad of ["../x", "../../solutions/" + p.briefId, "sol_ok/../../x", ""]) {
      expect(() => approveBuild(p.home, bad, p.briefHash, p.checkHash, NOW)).toThrow(/no brief|brief id/);
      expect(() => consumeBuildApproval(p.home, bad, "t", NOW)).toThrow(/no brief|brief id/);
    }
  });
});
