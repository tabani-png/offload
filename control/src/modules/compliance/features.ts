/**
 * Sensitive feature enablement (ADR 0108 §2): owner only, with a DPIA attestation, a legal basis, a published notice
 * that lists the feature and a notice period; per jurisdiction, matched exactly (an unknown jurisdiction is off).
 */
import type { App, Deps } from "../../app.ts";
import { actorOf, body, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { HttpError, conflict, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import { DAY_MS, SENSITIVE, dayIn, ms, noticeById, applies, offsetOf, type Sensitive } from "./common.ts";
import { P, bodyOf, replyLocal } from "./schemas.ts";

/** Jurisdictions whose notice rule needs at least one day between notice and monitoring (NY §52-c, CT §31-48d, DE §705). */
export const NOTICE_DAY_REQUIRED: ReadonlySet<string> = new Set(["US-NY", "US-CT", "US-DE"]);
/** The placeholder for "jurisdiction not set"; it can never be enabled (ADR 0108 §1: unknown = most restrictive). */
export const UNKNOWN_JURISDICTION = "ZZ";

const isGermany = (j: string) => j === "DE" || j.startsWith("DE-");

export interface EnableRequest {
  feature: Sensitive;
  jurisdictions: string[];
  legalBasis: "legitimate_interest" | "contract" | "consent" | "works_agreement" | "other";
  dpiaAttestation: { completedOn: string; documentHash: string; documentName: string; signerName: string; signerTitle: string };
  noticeVersionId: string;
  noticePeriodDays: number;
  worksAgreementRef: { documentHash: string; documentName: string; allowedViews: string[] } | null;
  quebecActivationAck: boolean;
  purposeLock: "process_improvement";
}

interface EnablementRow {
  id: string;
  feature: Sensitive;
  jurisdictions: string[];
  legal_basis: EnableRequest["legalBasis"];
  dpia_attestation: EnableRequest["dpiaAttestation"];
  notice_version_id: string;
  notice_period_days: number;
  works_agreement_ref: EnableRequest["worksAgreementRef"];
  quebec_activation_ack: boolean;
  purpose_lock: "process_improvement";
  enabled_by: string;
  enabled_at_ms: string;
  effective_at_ms: string;
  disabled_at_ms: string | null;
}

export function enablementDto(r: EnablementRow) {
  return {
    feature: r.feature,
    jurisdictions: r.jurisdictions,
    legalBasis: r.legal_basis,
    dpiaAttestation: r.dpia_attestation,
    noticeVersionId: r.notice_version_id,
    noticePeriodDays: r.notice_period_days,
    worksAgreementRef: r.works_agreement_ref,
    quebecActivationAck: r.quebec_activation_ack,
    purposeLock: r.purpose_lock,
    enabledBy: r.enabled_by,
    enabledAt: Number(r.enabled_at_ms),
    effectiveAt: Number(r.effective_at_ms),
    disabledAt: ms(r.disabled_at_ms),
  };
}

/** Is `feature` on for people in `jurisdiction` at instant `at`? (effectiveAt ≤ at, not disabled by then.) */
export async function isEnabled(tx: Tx, feature: Sensitive, jurisdiction: string, at: number): Promise<boolean> {
  return (await effectiveSince(tx, feature, jurisdiction, at)) !== null;
}

/** When the enablement in force at `at` became effective, or null when the feature is off then. */
export async function effectiveSince(tx: Tx, feature: Sensitive, jurisdiction: string, at: number): Promise<number | null> {
  const [r] = await tx`select min(effective_at_ms) as since from feature_enablements
    where feature = ${feature} and jurisdictions @> ${[jurisdiction]}::jsonb
      and effective_at_ms <= ${at} and (disabled_at_ms is null or disabled_at_ms > ${at})`;
  return ms((r?.since as string | null | undefined) ?? null);
}

export async function enabledFor(tx: Tx, jurisdiction: string, at: number): Promise<Set<Sensitive>> {
  const on = new Set<Sensitive>();
  for (const f of SENSITIVE) if (await isEnabled(tx, f, jurisdiction, at)) on.add(f);
  return on;
}

/** Every rule of ADR 0108 §2 that the schema cannot express. Returns the first broken rule, or null. */
export async function enablementProblem(tx: Tx, req: EnableRequest, today: string): Promise<string | null> {
  const js = req.jurisdictions;
  if (new Set(js).size !== js.length) return "jurisdictions must not repeat";
  if (js.includes(UNKNOWN_JURISDICTION)) return "set people's jurisdiction first: ZZ (unknown) cannot be enabled";
  if (req.dpiaAttestation.completedOn > today) return "dpiaAttestation.completedOn is in the future";
  if (req.dpiaAttestation.documentName.trim() === "") return "dpiaAttestation.documentName is empty";
  const notice = await noticeById(tx, req.noticeVersionId);
  if (!notice || notice.published_at_ms === null) return "noticeVersionId must be a published notice";
  if (notice.replaced_at_ms !== null) return "noticeVersionId was replaced by a newer notice";
  if (!notice.features.includes(req.feature)) return `the notice does not list ${req.feature}`;
  const uncovered = js.filter((j) => !applies(notice, j));
  if (uncovered.length > 0) return `the notice does not cover ${uncovered.join(", ")}`;
  const needDay = js.filter((j) => NOTICE_DAY_REQUIRED.has(j));
  if (needDay.length > 0 && req.noticePeriodDays < 1) return `noticePeriodDays must be at least 1 for ${needDay.join(", ")}`;
  if (js.some(isGermany)) {
    if (!req.worksAgreementRef) return "DE needs a works agreement (worksAgreementRef)";
    if (!req.worksAgreementRef.allowedViews.includes(req.feature)) return `the works agreement does not allow ${req.feature}`;
  }
  if (req.legalBasis === "works_agreement" && !req.worksAgreementRef) return "legal basis works_agreement needs worksAgreementRef";
  if (js.includes("CA-QC") && req.quebecActivationAck !== true) {
    return "CA-QC needs quebecActivationAck: the notice must describe how the profiling functions are activated (s.8.1)";
  }
  return null;
}

function sensitiveParam(v: string | undefined): Sensitive {
  if (v === "workflow_metrics") throw invalid("workflow_metrics is always on and has no enablement");
  if (!SENSITIVE.includes(v as Sensitive)) throw notFound();
  return v as Sensitive;
}

export function featureRoutes(app: App, deps: Deps): void {
  app.get("/v1/compliance/features", async (c) => {
    const { limit, cursor } = pageParams(c);
    const offset = offsetOf(cursor);
    const out = await tenantTx(c, deps, async (tx) => {
      const rows = (await tx`select * from feature_enablements order by enabled_at_ms desc, id
        offset ${offset} limit ${limit + 1}`) as EnablementRow[];
      return page(rows.map(enablementDto), limit, () => ({ n: offset + limit }));
    });
    return replyLocal(c, deps, 200, out, `${P}/feature-enablement-list.json`);
  });

  app.post("/v1/compliance/features/:feature/enable", async (c) => {
    const feature = sensitiveParam(c.req.param("feature"));
    const req = await bodyOf<EnableRequest>(c, `${P}/enable-request.json`);
    if (req.feature !== feature) throw invalid("body feature must match the path");
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      // One enabler at a time per tenant and feature, so two overlapping enablements cannot both pass the check.
      await tx`select pg_advisory_xact_lock(hashtextextended('feature:' || current_setting('app.tenant_id') || ${feature}, 0))`;
      const [t] = await tx`select reporting_timezone from tenants`;
      const problem = await enablementProblem(tx, req, dayIn(t!.reporting_timezone as string, now));
      if (problem) throw invalid(problem);
      const [overlap] = await tx`select id from feature_enablements where feature = ${feature} and disabled_at_ms is null
        and exists (select 1 from jsonb_array_elements_text(jurisdictions) j
          where j in (select jsonb_array_elements_text(${req.jurisdictions}::jsonb))) limit 1`;
      if (overlap) throw conflict(`${feature} already has an enablement for one of these jurisdictions; disable it first`);
      const effectiveAt = now + req.noticePeriodDays * DAY_MS;
      const [row] = await tx`insert into feature_enablements (tenant_id, feature, jurisdictions, legal_basis, dpia_attestation,
          notice_version_id, notice_period_days, works_agreement_ref, quebec_activation_ack, purpose_lock, enabled_by,
          enabled_at_ms, effective_at_ms)
        values (current_setting('app.tenant_id')::uuid, ${feature}, ${req.jurisdictions}::jsonb, ${req.legalBasis},
          ${req.dpiaAttestation}::jsonb, ${req.noticeVersionId}, ${req.noticePeriodDays},
          ${req.worksAgreementRef}::jsonb, ${req.quebecActivationAck},
          ${req.purposeLock}, ${p.personId}, ${now}, ${effectiveAt})
        returning *`;
      const dto = enablementDto(row as EnablementRow);
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "feature.enable",
        resource: { type: "feature_enablement", id: (row as EnablementRow).id },
        detail: {
          feature,
          jurisdictions: req.jurisdictions,
          legalBasis: req.legalBasis,
          noticeVersionId: req.noticeVersionId,
          noticePeriodDays: req.noticePeriodDays,
          effectiveAt,
          dpia: { completedOn: req.dpiaAttestation.completedOn, documentHash: req.dpiaAttestation.documentHash, signerName: req.dpiaAttestation.signerName },
        },
      });
      return dto;
    });
    return replyLocal(c, deps, 201, out, "offload/stage2/feature-enablement.schema.json");
  });

  app.post("/v1/compliance/features/:feature/disable", async (c) => {
    const feature = sensitiveParam(c.req.param("feature"));
    await body(c, deps, "offload/control/empty.json");
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      const rows = (await tx`update feature_enablements set disabled_at_ms = ${now}, disabled_by = ${p.personId}
        where feature = ${feature} and disabled_at_ms is null returning *`) as EnablementRow[];
      if (rows.length === 0) throw new HttpError(404, "not_found", `${feature} has no active enablement`);
      rows.sort((a, b) => Number(b.enabled_at_ms) - Number(a.enabled_at_ms));
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "feature.disable",
        resource: { type: "feature_enablement", id: rows[0]!.id },
        detail: { feature, enablementIds: rows.map((r) => r.id), jurisdictions: [...new Set(rows.flatMap((r) => r.jurisdictions))] },
      });
      return enablementDto(rows[0]!);
    });
    return replyLocal(c, deps, 200, out, "offload/stage2/feature-enablement.schema.json");
  });
}
