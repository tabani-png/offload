// LIVE (optional): a real Agent SDK build of a tiny brief. Runs ONLY when the key is in the Keychain
// (OFFLOAD_ANTHROPIC_KEYCHAIN) and NOT in this process's environment (a build refuses an environment key: same-user
// processes can read it through KERN_PROCARGS2); otherwise it is reported as skipped. Never faked.
import { describe, expect, test } from "bun:test";
import { approveBuild } from "../../src/builder/approval.ts";
import { runBuild } from "../../src/builder/runner.ts";
import { builderQuery } from "../../src/builder/service.ts";
import { NOW, prepared } from "./setup.ts";

const live = (process.env.OFFLOAD_ANTHROPIC_KEYCHAIN ?? "") !== "" && (process.env.ANTHROPIC_API_KEY ?? "") === "" && (process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "") === "";
if (!live) console.log("LIVE: skipped (needs OFFLOAD_ANTHROPIC_KEYCHAIN and no ANTHROPIC_API_KEY in the environment)");

describe("s24 live", () => {
  test.skipIf(!live)("LIVE: the real SDK builds slug.py until the recorded check passes, under $1", async () => {
    const p = await prepared();
    const { token } = approveBuild(p.home, p.briefId, p.briefHash, p.checkHash, NOW);
    const rec = await runBuild({ home: p.home, briefId: p.briefId, token, query: await builderQuery({}), env: { OFFLOAD_ANTHROPIC_KEYCHAIN: process.env.OFFLOAD_ANTHROPIC_KEYCHAIN, PATH: process.env.PATH, HOME: process.env.HOME }, profile: { mode: "allowlist", containerSandbox: false }, limits: { maxTries: 2, maxUsd: 1, wallMs: 5 * 60_000 } });
    console.log(`LIVE: ${rec.outcome} tries ${rec.tries.length} $${rec.totals.costUsd}`);
    expect(rec.outcome).toBe("PASS");
  }, 6 * 60_000);
});
