// POST /v1/sync/batches (ADR 0103 server side, SPEC S2-05): verify, replay check, per-object schema + consent +
// feature re-check, dispatch to the owning module's syncHandlers[kind], idempotent ledger, one transaction.
import { join } from "node:path";
import type { Context } from "hono";
import { SYNC_OBJECTS_PER_HOUR, SYNC_RATE_WINDOW_MS } from "../../config.ts";
import { loadModules, principalOf, tenantTx, type AppEnv, type Deps, type Principal, type SyncHandler } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { jcs, sha256Hex } from "../../schema/encoding.ts";
import { HttpError, forbidden, invalid } from "../../schema/http.ts";
import {
  SENT_AT_WINDOW_MS, SIGNATURE_HEADER, badSignature, parseEnvelope, parseSignatureHeader, readCapped, replay, verifyBytes,
} from "./envelope.ts";

/** The closed set of sync kinds (ADR 0103 §1) and the schema each object must match. */
export const KIND_SCHEMAS: Readonly<Record<string, string>> = {
  notice_ack: "offload/stage2/notice-ack.schema.json",
  run_outcome: "offload/stage2/run-outcome.schema.json",
  review_event: "offload/stage2/review-event.schema.json",
  baseline_sample: "offload/stage2/baseline-sample.schema.json",
  daily_aggregate: "offload/stage2/daily-aggregate.schema.json",
  working_time_aggregate: "offload/stage2/working-time-aggregate.schema.json",
  workflow_proposal: "offload/stage2/workflow-definition.schema.json",
};

export type RejectCode =
  | "validation_failed" | "consent_missing" | "feature_disabled" | "duplicate" | "unknown_workflow" | "rate_limited" | "server_error";

const REJECT_CODES = new Set<string>(["validation_failed", "consent_missing", "feature_disabled", "duplicate", "unknown_workflow", "rate_limited", "server_error"]);
const RETRYABLE = new Set<RejectCode>(["rate_limited", "server_error"]);

/**
 * A handler rejects one object (and only that object) by throwing an error carrying `syncCode`, or an HttpError 4xx
 * (validation_failed); its writes are rolled back to the object's savepoint. Any other error is a retryable
 * server_error for that object.
 */
export class SyncReject extends Error {
  constructor(readonly syncCode: RejectCode, message: string = syncCode) {
    super(message);
  }
}

export interface Receipt {
  seq: number;
  accepted: string[];
  rejected: Array<{ id: string; code: RejectCode; retryable: boolean }>;
}

/**
 * syncHandlers of the modules mounted beside this one (modules/*), merged by kind. The app loader mounts routes but
 * does not hand modules to each other, so ingest reads the same folder it was loaded from (cached imports: the very
 * module objects the app mounted). Two modules handling one kind is a startup-time error.
 */
const handlersByDir = new Map<string, Promise<ReadonlyMap<string, SyncHandler>>>();
export function siblingHandlers(dir = join(import.meta.dir, "..")): Promise<ReadonlyMap<string, SyncHandler>> {
  let p = handlersByDir.get(dir);
  if (!p) {
    p = loadModules(dir).then((mods) => {
      const out = new Map<string, SyncHandler>();
      const by = new Map<string, string>();
      for (const m of mods) {
        for (const [kind, fn] of Object.entries(m.syncHandlers ?? {})) {
          if (!Object.hasOwn(KIND_SCHEMAS, kind)) throw new Error(`module ${m.name} handles unknown sync kind ${kind}`);
          if (by.has(kind)) throw new Error(`sync kind ${kind} handled by both ${by.get(kind)} and ${m.name}`);
          by.set(kind, m.name);
          out.set(kind, fn);
        }
      }
      return out;
    });
    handlersByDir.set(dir, p);
    // A failed load is not kept: the next batch loads again instead of failing with the same error forever.
    p.catch(() => {
      if (handlersByDir.get(dir) === p) handlersByDir.delete(dir);
    });
  }
  return p;
}

function syncCodeOf(err: unknown): RejectCode | null {
  const code = (err as { syncCode?: unknown } | null)?.syncCode;
  if (typeof code === "string" && REJECT_CODES.has(code)) return code as RejectCode;
  // A handler that answers like a route (an HttpError 4xx: unknown notice, wrong jurisdiction, bad fields) found the
  // object itself wrong: rejected for good, like a SyncReject("validation_failed"), never retried. 5xx and anything
  // else stay a retryable server_error.
  const status = (err as { status?: unknown } | null)?.status;
  return err instanceof HttpError && typeof status === "number" && status >= 400 && status < 500 ? "validation_failed" : null;
}

export async function ingest(c: Context<AppEnv>, deps: Deps): Promise<Receipt> {
  const p0 = principalOf(c);
  if (p0.kind !== "device") throw forbidden("only devices post sync batches");
  const sig = parseSignatureHeader(c.req.header(SIGNATURE_HEADER));
  if (!sig) throw invalid(`missing or malformed ${SIGNATURE_HEADER} (keyid=<deviceId>, sig=<b64url>)`);
  const bytes = await readCapped(c.req.raw);
  if (sig.keyid !== p0.deviceId) throw badSignature("keyid is not this device");
  const handlers = await siblingHandlers();

  return tenantTx(c, deps, async (tx, p) => {
    const device = p as Extract<Principal, { kind: "device" }>;
    const [d] = await tx`select public_key_jwk from devices where id = ${device.deviceId} and state = 'active'`;
    if (!d || !(await verifyBytes(d.public_key_jwk as { kty: string; crv: string; x: string; y: string }, bytes, sig.sig))) {
      throw badSignature();
    }
    // Only signed bytes are parsed.
    const env = parseEnvelope(bytes);
    if (env.deviceId !== device.deviceId) throw forbidden("envelope deviceId is not this device");
    const now = deps.clock.now();
    if (Math.abs(env.sentAt - now) > SENT_AT_WINDOW_MS) throw replay("sentAt is more than 10 minutes from server time");

    await tx`select set_config('app.sync_seq', ${String(env.seq)}, true)`;
    // The device's first envelope creates its row; later ones lock it, which serialises envelopes of one device.
    const [first] = await tx`insert into device_seq (tenant_id, device_id, last_seq, last_sent_at_ms, updated_at)
      values (current_setting('app.tenant_id')::uuid, ${device.deviceId}, ${env.seq}, ${env.sentAt}, ${new Date(now)})
      on conflict (tenant_id, device_id) do nothing returning last_seq`;
    if (!first) {
      const [last] = await tx`select last_seq from device_seq where device_id = ${device.deviceId} for update`;
      if (Number(last!.last_seq) >= env.seq) throw replay(`seq ${env.seq} is not above the last accepted ${last!.last_seq}`);
    }

    // Per-device budget of accepted objects per rolling hour, replacements of a run outcome included (migration 0504);
    // the device_seq lock above makes the count exact.
    const [used] = await tx`select coalesce(sum(accepted), 0)::int as n from sync_accepts
      where device_id = ${device.deviceId} and at > ${new Date(now - SYNC_RATE_WINDOW_MS)}`;
    const budget = { left: (deps.config.syncObjectsPerHour ?? SYNC_OBJECTS_PER_HOUR) - used!.n };

    const receipt: Receipt = { seq: env.seq, accepted: [], rejected: [] };
    const reject = (id: string, code: RejectCode) => receipt.rejected.push({ id, code, retryable: RETRYABLE.has(code) });
    for (const obj of env.objects) {
      const code = await one(tx, deps, device, handlers, obj, env.seq, now, budget);
      if (code === null) receipt.accepted.push(obj.id);
      else reject(obj.id, code);
    }

    if (receipt.accepted.length > 0) {
      await tx`insert into sync_accepts (tenant_id, device_id, seq, at, accepted)
        values (current_setting('app.tenant_id')::uuid, ${device.deviceId}, ${env.seq}, ${new Date(now)}, ${receipt.accepted.length})`;
    }
    await tx`update device_seq set last_seq = ${env.seq}, last_sent_at_ms = ${env.sentAt}, updated_at = ${new Date(now)}
      where device_id = ${device.deviceId}`;
    await tx`update devices set last_sync_at = ${new Date(now)} where id = ${device.deviceId}`;
    return receipt;
  });
}

/** One object: schema, duplicate, rate limit, consent, feature, handler, ledger. Returns null when accepted. */
async function one(
  tx: Tx,
  deps: Deps,
  p: Extract<Principal, { kind: "device" }>,
  handlers: ReadonlyMap<string, SyncHandler>,
  obj: Record<string, unknown> & { id: string },
  seq: number,
  now: number,
  budget: { left: number },
): Promise<RejectCode | null> {
  const kind = typeof obj.kind === "string" ? obj.kind : "";
  // Own entries only: a kind like "constructor" or "__proto__" must not find an inherited property (Codex, 9c2c93b).
  const schema = Object.hasOwn(KIND_SCHEMAS, kind) ? KIND_SCHEMAS[kind] : undefined;
  // Any field outside the kind's schema (a recipient, a title) fails here, before anything is stored.
  if (schema === undefined || !deps.validator.validate(schema, obj).ok) return "validation_failed";
  const digest = sha256Hex(jcs(obj));
  const [prev] = await tx`select kind, digest from sync_objects where device_id = ${p.deviceId} and object_id = ${obj.id}`;
  // Idempotent on (tenant, device, object id). A run outcome may come again under its id with a newer state (ADR 0111 §4).
  if (prev && (prev.digest === digest || prev.kind !== kind || kind !== "run_outcome")) return "duplicate";
  if (budget.left <= 0) return "rate_limited";
  if (!(await deps.ports.consent.allows(tx, p.personId, kind))) return "consent_missing";
  if (kind === "working_time_aggregate" && !(await deps.ports.features.enabledFor(tx, p.jurisdiction)).has("working_time")) {
    return "feature_disabled";
  }
  const handler = handlers.get(kind);
  // No module handles this kind yet (e.g. notice_ack before S2-08): retryable, so the Mac keeps it.
  if (!handler) return "server_error";
  try {
    await tx.savepoint(async (sp) => {
      await handler(sp as unknown as Tx, obj, { principal: p, deps });
      await sp`insert into sync_objects (tenant_id, device_id, object_id, kind, digest, seq, received_at)
        values (current_setting('app.tenant_id')::uuid, ${p.deviceId}, ${obj.id}, ${kind}, ${digest}, ${seq}, ${new Date(now)})
        on conflict (tenant_id, device_id, object_id) do update set digest = excluded.digest, seq = excluded.seq,
          received_at = excluded.received_at`;
    });
  } catch (err) {
    const code = syncCodeOf(err);
    if (code !== null) return code;
    console.error(`sync: ${kind} handler failed`, err);
    return "server_error";
  }
  budget.left--;
  return null;
}
