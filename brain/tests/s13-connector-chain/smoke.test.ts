// s13 SMOKE (opt-in, never in verify.sh): the real Composio CLI on this Mac, read-only. Run with
//   OFFLOAD_S13_SMOKE=1 bun test tests/s13-connector-chain/smoke.test.ts
// The probe's runner refuses any command that is not read-only (listing, search, connection status, schemas), so this
// can never send, draft or change anything in a real account.
import { describe, expect, test } from "bun:test";
import { chainDeps } from "../../src/connectors/chain.ts";
import { ComposioProbe, isReadOnlyComposioArgv } from "../../src/connectors/composio.ts";
import type { LinkRunner } from "../../src/connectors/link.ts";
import { catalogTarget } from "../../src/connectors/targets.ts";
import { tempHome } from "./setup.ts";

const on = process.env.OFFLOAD_S13_SMOKE === "1";

describe.skipIf(!on)("s13 smoke: the real Composio CLI (read-only)", () => {
  test("SMOKE: Gmail through the Composio CLI: toolkit, an active account and mail.send through GMAIL_SEND_EMAIL", async () => {
    const { home, cleanup } = tempHome();
    try {
      const base = chainDeps({ home, env: process.env, timeoutMs: 60_000 });
      const seen: string[][] = [];
      const runner: LinkRunner = {
        run: (argv, o) => {
          seen.push([...argv]);
          if (!isReadOnlyComposioArgv(argv)) throw new Error("smoke: refusing a command that is not read-only");
          return base.runner.run(argv, o);
        },
      };
      const r = await new ComposioProbe().probe(catalogTarget("gmail")!, { ...base, runner });
      console.log("smoke: composio gmail ->", JSON.stringify({ health: r.health, code: r.code, reads: r.reads, writes: r.writes, tools: r.tools, latencyMs: r.latencyMs }));
      expect(seen.every((a) => isReadOnlyComposioArgv(a))).toBe(true);
      expect(["ok", "skipped", "failed"]).toContain(r.health);
      if (r.health === "ok") expect(r.reads).toContain("mail.search");
    } finally {
      cleanup();
    }
  }, 120_000);
});
