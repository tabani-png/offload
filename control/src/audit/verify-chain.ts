/**
 * verify-chain: checks every tenant's audit chain against its latest anchor (audit_anchors) and, with --checkpoint,
 * against a signed checkpoint file kept outside the database. Exit 0 intact, 1 broken (truncated, rewritten, a bad
 * link, a tenant gone or a bad checkpoint signature), 2 usage.
 *
 *   OFFLOAD_ANCHOR_PG_URL=... [OFFLOAD_ANCHOR_PUBLIC_JWK='{...}'] bun run src/audit/verify-chain.ts [--checkpoint <file>]
 */
import { readFileSync } from "node:fs";
import type { Db } from "../db/pool.ts";
import { createPool } from "../db/pool.ts";
import type { Jwk } from "../auth/jwt.ts";
import { verifyAllChains, verifyCheckpoint, type Checkpoint } from "./anchor.ts";

export async function verifyChainCommand(
  db: Db,
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ code: 0 | 1 | 2; lines: string[] }> {
  const i = argv.indexOf("--checkpoint");
  const file = i >= 0 ? argv[i + 1] : undefined;
  if (i >= 0 && !file) return { code: 2, lines: ["usage: verify-chain [--checkpoint <file>]"] };
  let checkpoint: Checkpoint | null = null;
  if (file) {
    if (!env.OFFLOAD_ANCHOR_PUBLIC_JWK) return { code: 2, lines: ["--checkpoint needs OFFLOAD_ANCHOR_PUBLIC_JWK"] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return { code: 1, lines: [`BROKEN checkpoint ${file} is unreadable`] };
    }
    if (!(await verifyCheckpoint(parsed, JSON.parse(env.OFFLOAD_ANCHOR_PUBLIC_JWK) as Jwk))) {
      return { code: 1, lines: [`BROKEN checkpoint ${file} has a bad signature`] };
    }
    checkpoint = parsed as Checkpoint;
  }
  const r = await verifyAllChains(db, checkpoint);
  const lines = r.tenants.map((t) =>
    t.verdict.ok
      ? `ok ${t.tenantId} (anchor: ${t.against})`
      : `BROKEN ${t.tenantId} ${t.verdict.reason}${"brokenAt" in t.verdict ? ` at ${t.verdict.brokenAt}` : ""} (anchor: ${t.against})`,
  );
  return { code: r.ok ? 0 : 1, lines };
}

if (import.meta.main) {
  const url = process.env.OFFLOAD_ANCHOR_PG_URL;
  if (!url) {
    console.error("missing env OFFLOAD_ANCHOR_PG_URL");
    process.exit(2);
  }
  const db = createPool(url, { max: 1, ...(process.env.OFFLOAD_DB_SCHEMA ? { schema: process.env.OFFLOAD_DB_SCHEMA } : {}) });
  const r = await verifyChainCommand(db, process.argv.slice(2), process.env);
  await db.close();
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
