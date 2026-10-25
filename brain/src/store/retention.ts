// The brain's whole purge (REVIEW-2 N3, N4, N8, privacy table). Runs at brain start before serving, hourly, and from
// `cli.ts purge --home DIR` (the app runs it at launch, so a closed brain still purges on time). The observer
// purges expired brain keys too (keys/brain-YYYY-MM-DD.key, engine 52b205b), so sealed files of an expired day
// cannot be opened even if neither of these ever runs again.
//   1. contacted ledger for live batches written plain before s10b (newer sends are journalled before they run);
//   2. vault.purgeExpired: expired sealed artefacts (dry runs, batches, labels, corpus, blind tests) and their keys,
//      legacy plaintext artefacts sealed in place;
//   3. tone cards the user did not edit, once the corpus they were built from has expired;
//   4. title-derived names left in workflow.json files from before s10b move into the sealed store;
//   5. purge-log.jsonl rotates at 5 MB.
import { chainPath, rememberTargets } from "../connectors/chain.ts";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rotateIfLarge } from "../log.ts";
import { toneDir } from "../tone/pack.ts";
import { BUCKETS } from "../tone/types.ts";
import type { Batch } from "../workflows/batch.ts";
import { migrateLabels } from "../workflows/labels.ts";
import { appendLedger, ledgerContacted } from "../workflows/runner.ts";
import { addressHash } from "../workflows/autorun.ts";
import { listWorkflowIds, workflowDir } from "../workflows/store.ts";
import { isExpired, localDay, purgeExpired, type PurgeOptions, type PurgeResult } from "./vault.ts";
import { purgeOutbox } from "../sync/outbox.ts";
import { purgeRefs } from "../sync/evidence-key.ts";

export interface PurgeAllResult extends PurgeResult {
  /** Unedited tone cards deleted with their expired corpus. */
  toneCards: number;
  /** workflow.json files whose title-derived name moved to labels.json.enc. */
  labelsMoved: number;
  /** Addresses added to contacted ledgers from plain (pre-s10b) live batches. */
  ledgered: number;
  /** S2-02: sync outbox day files (and evidence-ref maps) older than 7 days. */
  syncFiles: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Plain live batch files from before s10b: journal who they contacted before they are sealed or deleted. */
function ledgerLegacyBatches(home: string): number {
  let n = 0;
  for (const id of listWorkflowIds(home)) {
    const dir = join(workflowDir(home, id), "batches");
    if (!existsSync(dir)) continue;
    let known: Set<string> | null = null;
    for (const f of readdirSync(dir)) {
      if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
      let b: Batch;
      try {
        b = JSON.parse(readFileSync(join(dir, f), "utf8")) as Batch;
      } catch {
        continue;
      }
      if (b.kind !== "live") continue;
      for (const i of b.items) {
        const st = b.itemStates?.[i.key]?.state;
        const contacted = st === "sent" || st === "unknown" || st === "sending" || (st === undefined && b.results.some((r) => r.key === i.key && r.ok));
        if (!contacted) continue;
        known ??= ledgerContacted(home, id);
        if (known.has(addressHash(id, i.key))) continue;
        appendLedger(home, id, i.key, "contacted");
        known.add(addressHash(id, i.key));
        n += 1;
      }
    }
  }
  return n;
}

/** Generated tone cards follow their corpus: when the build day is past 7 days, cards still equal to what the brain
 * wrote are deleted. A card the user edited is the user's file and stays (listed in keptFiles). */
function purgeToneCards(home: string, now: number): number {
  const p = join(toneDir(home), "index.json");
  if (!existsSync(p)) return 0;
  let index: { builtAt?: number; buckets?: Record<string, { file: string; sha256: string; emails: number }> };
  try {
    index = JSON.parse(readFileSync(p, "utf8")) as typeof index;
  } catch {
    return 0;
  }
  if (typeof index.builtAt !== "number" || index.builtAt === 0 || !isExpired(localDay(index.builtAt), now)) return 0;
  let n = 0;
  for (const b of BUCKETS) {
    const rec = index.buckets?.[b];
    const file = join(toneDir(home), `${b}.md`);
    if (rec === undefined || !existsSync(file)) continue;
    if (sha(readFileSync(file, "utf8")) !== rec.sha256) continue; // edited by the user: kept
    rmSync(file, { force: true });
    delete index.buckets![b];
    n += 1;
  }
  if (n > 0) writeFileSync(p, JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
  return n;
}

export function purgeAll(home: string, now: number, opts: PurgeOptions = {}): PurgeAllResult {
  const log = opts.log ?? console.log;
  const ledgered = ledgerLegacyBatches(home);
  const res = purgeExpired(home, now, { log });
  const toneCards = purgeToneCards(home, now);
  const labelsMoved = migrateLabels(home, now);
  // s13: app targets of the connector chain (observed app names / hosts) older than 7 days, with their decisions.
  if (existsSync(chainPath(home))) rememberTargets(home, [], now);
  // S2-02: queued sync objects and the local evidence-ref maps follow the same 7-day rule (purge-log line per day).
  const outbox = purgeOutbox(home, now);
  const refs = purgeRefs(home, now);
  const syncFiles = outbox.files + refs.length;
  if (syncFiles > 0) log(`brain: purge removed ${outbox.files} sync outbox file(s) and ${refs.length} evidence-ref map(s) older than 7 days`);
  rotateIfLarge(join(home, "purge-log.jsonl"));
  if (toneCards + labelsMoved + ledgered > 0) log(`brain: purge removed ${toneCards} generated tone card(s), moved ${labelsMoved} observed name(s) into the sealed store, journalled ${ledgered} contacted address(es)`);
  return { ...res, toneCards, labelsMoved, ledgered, syncFiles };
}
