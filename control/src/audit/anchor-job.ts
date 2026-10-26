/**
 * The anchoring job: a separate process with its own role (offload_anchor), so the app server never holds the
 * credential that writes anchors. Each pass appends moved chain heads to audit_anchors and writes a signed checkpoint
 * file into OFFLOAD_ANCHOR_DIR (ship that directory to append-only storage).
 *
 *   OFFLOAD_ANCHOR_PG_URL=... OFFLOAD_ANCHOR_SIGNING_JWK='{...}' OFFLOAD_ANCHOR_DIR=... bun run src/audit/anchor-job.ts [--every <minutes>]
 */
import { createPool } from "../db/pool.ts";
import { importEs256SigningKey, type Jwk } from "../auth/jwt.ts";
import { anchorAll, exportCheckpoint, writeCheckpointFile } from "./anchor.ts";

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
}

if (import.meta.main) {
  const db = createPool(need("OFFLOAD_ANCHOR_PG_URL"), { max: 1, ...(process.env.OFFLOAD_DB_SCHEMA ? { schema: process.env.OFFLOAD_DB_SCHEMA } : {}) });
  const key = await importEs256SigningKey(JSON.parse(need("OFFLOAD_ANCHOR_SIGNING_JWK")) as Jwk);
  const dir = need("OFFLOAD_ANCHOR_DIR");
  const i = process.argv.indexOf("--every");
  const everyMin = i >= 0 ? Number(process.argv[i + 1]) : 0;
  const pass = async () => {
    const now = Date.now();
    const run = await anchorAll(db, now);
    const path = writeCheckpointFile(dir, await exportCheckpoint(db, key, now));
    for (const b of run.broken) console.error(`BROKEN ${b.tenantId} ${JSON.stringify(b.verdict)}`);
    console.log(`anchored ${run.anchored.length} tenant(s), checkpoint ${path}`);
    return run.broken.length === 0;
  };
  if (everyMin > 0) {
    await pass();
    setInterval(() => void pass().catch((e) => console.error(e)), everyMin * 60_000);
  } else {
    const ok = await pass();
    await db.close();
    process.exit(ok ? 0 : 1);
  }
}
