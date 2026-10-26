// Review round 2 item 4: the brain's default model is the masking router.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrain } from "../../src/api/server.ts";

describe("s18 round 2: the brain's default model is the masking router", () => {
  test("EGRESS: createBrain with no model given routes every call through the router (no raw model fallback)", async () => {
    const home = mkdtempSync(join(tmpdir(), "offload-s18r2-"));
    try {
      const token = "d".repeat(40);
      const brain = createBrain({ home, token, workflows: { env: {} } });
      const st = (await (await brain.handle(new Request("http://127.0.0.1/status", { headers: { authorization: `Bearer ${token}`, host: "127.0.0.1" } }))).json()) as { models?: { backend: string } };
      expect(st.models?.backend).toBe("claude-code");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("EGRESS: server.ts never builds an unrouted model", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/api/server.ts"), "utf8");
    expect(/new AgentSdkModel\(/.test(src)).toBe(false);
  });
});
