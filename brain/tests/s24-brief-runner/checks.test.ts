// CHECKS: the acceptance lines become one frozen check script through the router (role build_checks, Sonnet) before
// any build; bad replies are refused; the text sent to the model goes through the mask hook.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkSha, checkWriterPrompt, parseCheckReply, readChecks, writeChecks } from "../../src/builder/checks.ts";
import { DEFAULT_MODELS, StubModel } from "../../src/models/model.ts";
import { ROLE_ROUTES, ROUTES } from "../../src/models/router.ts";
import { BriefError, readBrief } from "../../src/solutions/brief.ts";
import { briefHome, CHECK_REPLY, fakeRouted, NOW, prepared } from "./setup.ts";

describe("s24 checks first, frozen", () => {
  test("CHECKS: the recorded Sonnet reply becomes accept.py on disk (0600) with its sha256, before any build", async () => {
    const p = await prepared();
    const want = JSON.parse(CHECK_REPLY).content as string;
    const dir = join(p.home, "solutions", p.briefId, "checks");
    expect(readFileSync(join(dir, "accept.py"), "utf8")).toBe(want);
    expect(statSync(join(dir, "accept.py")).mode & 0o777).toBe(0o600);
    expect(p.checkHash).toBe(checkSha(want));
    const r = readChecks(p.home, p.briefId)!;
    expect(r.set).toMatchObject({ briefId: p.briefId, briefHash: p.briefHash, file: "accept.py", sha256: p.checkHash, model: "router:build_checks" });
    expect(existsSync(join(p.home, "builds"))).toBe(false);
  });

  test("CHECKS: the check writer is a separate call on the router's code-writing route (draft, Sonnet), fed the acceptance lines", async () => {
    const p = await prepared();
    expect(ROLE_ROUTES.build_checks).toBe("draft");
    expect(ROUTES.draft.tier).toBe("sonnet");
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0]!.role).toBe("build_checks");
    expect(p.calls[0]!.model).toBe("claude-sonnet-5-5");
    const brief = readBrief(p.home, p.briefId)!;
    for (const a of brief.spec.acceptance) expect(p.calls[0]!.prompt).toContain(a);
  });

  test("CHECKS: BUILD.md shows the brief and the exact script with both hashes for approval", async () => {
    const p = await prepared();
    const md = readFileSync(join(p.home, "solutions", p.briefId, "BUILD.md"), "utf8");
    expect(md).toContain("## Acceptance check script (frozen before the build)");
    expect(md).toContain(p.checkHash);
    expect(md).toContain(p.briefHash);
    expect(md).toContain("## Prompt for the builder (Claude Code)");
    expect(md).toContain('cases = [("Hello World", "hello-world")');
  });

  test("CHECKS: a reply that is not JSON, names another file, or is empty is refused and nothing is written", async () => {
    for (const bad of ["sure, here is a script", JSON.stringify({ file: "../evil.sh", content: "rm -rf /" }), JSON.stringify({ file: "accept.py", content: "  " })]) {
      expect("reason" in parseCheckReply(bad)).toBe(true);
      const b = briefHome();
      const { model } = fakeRouted(b.home, bad);
      await expect(writeChecks({ home: b.home, briefId: b.briefId, model, models: DEFAULT_MODELS, modelLabel: "x", now: NOW })).rejects.toBeInstanceOf(BriefError);
      expect(readChecks(b.home, b.briefId)).toBeNull();
    }
    expect(parseCheckReply("```json\n" + CHECK_REPLY + "\n```")).toMatchObject({ file: "accept.py" });
  });

  test("CHECKS: the mask hook is applied to every brief line sent to the check writer (s18 TODO seam)", async () => {
    const b = briefHome();
    const brief = readBrief(b.home, b.briefId)!;
    const masked = checkWriterPrompt(brief, (t) => t.replace(/[A-Za-z]/g, "x"));
    expect(masked).not.toContain(brief.spec.acceptance[0]!);
    expect(checkWriterPrompt(brief)).toContain(brief.spec.acceptance[0]!);
  });

  test("CHECKS: the stub model writes the deterministic fallback check (offline CLI and demos)", async () => {
    const b = briefHome();
    const c = await writeChecks({ home: b.home, briefId: b.briefId, model: new StubModel(), models: DEFAULT_MODELS, modelLabel: "stub", now: NOW });
    expect(c.set.file).toBe("accept.py");
    expect(c.content).toContain("workspace has build output");
  });
});
