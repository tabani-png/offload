/**
 * Ports between the control core and the modules of later slices (SPEC S2-01). A module overrides a port by
 * listing it in `ModuleDef.provides`; anything not provided gets the safe default below.
 */
import type { Tx } from "./db/pool.ts";
import { writeAudit, type AuditEvent, type AuditInput } from "./audit/audit.ts";
import type { SensitiveFeature } from "./rbac/permissions.ts";

export interface Clock {
  now(): number;
}

export interface AuditPort {
  /** Appends a hash-chained event in the caller's transaction (ADR 0108 §5). */
  write(tx: Tx, event: AuditInput): Promise<AuditEvent>;
}

export interface ConsentPort {
  /** May this person's device send sync objects of `kind`? (ADR 0103.) */
  allows(tx: Tx, personId: string, kind: string): Promise<boolean>;
}

export interface FeaturePort {
  /** Sensitive features enabled for a person's jurisdiction (ADR 0108). */
  enabledFor(tx: Tx, jurisdiction: string): Promise<ReadonlySet<SensitiveFeature>>;
}

export interface RegistryPort {
  /** Workflow ids the person runs or owns (hand-over input on freeze). */
  workflowsOf(tx: Tx, personId: string): Promise<string[]>;
}

export interface BrokerPort {
  /** Revokes unspent approval tokens minted by the person; returns how many. */
  revokeTokensOf(tx: Tx, personId: string): Promise<number>;
  /** Is any kill switch active for this tenant, person or workflow? */
  killSwitchActive(tx: Tx, target: { personId?: string; workflowId?: string }): Promise<boolean>;
}

export interface WorkersPort {
  /** Pauses cloud workers and deployments the person ran; returns how many. */
  pauseFor(tx: Tx, personId: string): Promise<number>;
}

export interface FreezeReason {
  source: "directory" | "admin";
  detail?: string;
}

export interface ContinuityPort {
  /** Freezes a person (ADR 0107 §2): revokes web sessions and devices in this transaction. */
  freeze(tx: Tx, personId: string, reason: FreezeReason): Promise<void>;
}

export interface Ports {
  audit: AuditPort;
  consent: ConsentPort;
  features: FeaturePort;
  registry: RegistryPort;
  broker: BrokerPort;
  workers: WorkersPort;
  continuity: ContinuityPort;
}

/** Revokes every web session and device of a person; returns the counts. */
export async function revokeAccess(tx: Tx, personId: string, now: number): Promise<{ sessions: number; devices: number }> {
  const at = new Date(now);
  const s = await tx`update sessions set revoked_at = ${at} where person_id = ${personId} and revoked_at is null`;
  const d = await tx`update devices set state = 'revoked', revoked_at = ${at}
    where person_id = ${personId} and state = 'active'`;
  return { sessions: s.count, devices: d.count };
}

export function defaultPorts(clock: Clock): Ports {
  const audit: AuditPort = { write: (tx, e) => writeAudit(tx, e, clock.now()) };
  return {
    audit,
    // Until the compliance slice provides consent, a device may send only its notice acknowledgement.
    consent: { allows: async (_tx, _personId, kind) => kind === "notice_ack" },
    // Sensitive features are off until the compliance slice records an owner's enablement.
    features: { enabledFor: async () => new Set<SensitiveFeature>() },
    registry: { workflowsOf: async () => [] },
    broker: {
      revokeTokensOf: async () => 0,
      // With no broker there is nothing to commit; report stopped so callers fail closed.
      killSwitchActive: async () => true,
    },
    workers: { pauseFor: async () => 0 },
    continuity: {
      // Records a pending freeze (picked up by the continuity slice) and cuts access now.
      async freeze(tx, personId, reason) {
        const now = clock.now();
        await tx`update people set state = 'frozen', pending_freeze_at = ${new Date(now)}
          where id = ${personId} and state <> 'departed'`;
        const revoked = await revokeAccess(tx, personId, now);
        await audit.write(tx, {
          actor: { type: "system", id: null, accessRole: null },
          action: "person.freeze",
          subjectPersonId: personId,
          resource: { type: "person", id: personId },
          detail: { pending: true, source: reason.source, ...revoked },
        });
      },
    },
  };
}
