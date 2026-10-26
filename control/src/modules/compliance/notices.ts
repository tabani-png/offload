/**
 * Notice engine (ADR 0108 §3): versions drafted from `compliance/templates/`, published once, never rewritten;
 * acknowledgements from the web (`POST /v1/me/notices/:id/ack`) and from the Mac (`notice_ack` sync objects).
 */
import type { App, Deps, Principal, SyncHandler } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { ulid } from "../../schema/encoding.ts";
import { HttpError, conflict, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import {
  applies, listNotices, ms, noticeById, noticeDto, offsetOf, personRow, sameSet, uuidParam, type Feature, type NoticeRow,
} from "./common.ts";
import { CUSTOM_TEMPLATE, isTemplate, templateById, unfilledFields } from "./templates.ts";
import { P, bodyOf, replyLocal } from "./schemas.ts";

const NOTICE = "offload/stage2/notice.schema.json";
const ACK = "offload/stage2/notice-ack.schema.json";
/** How far ahead of the server clock a device's acknowledgedAt may be (the envelope's ±10 min rule). */
const SKEW_MS = 10 * 60_000;

interface NoticeCreate {
  template: string;
  title: string;
  markdown: string;
  features: Feature[];
  jurisdictions: string[];
}

export interface NoticeAckObject {
  id: string;
  kind: "notice_ack";
  createdAt: number;
  noticeVersionId: string;
  acknowledgedAt: number;
  jurisdiction: string;
  features: Feature[];
  channel: "mac_app" | "web";
}

interface AckRow {
  id: string;
  notice_id: string;
  acknowledged_at_ms: string;
  created_at_ms: string;
  jurisdiction: string;
  features: Feature[];
  channel: "mac_app" | "web";
}

export function ackDto(r: AckRow): NoticeAckObject {
  return {
    id: r.id,
    kind: "notice_ack",
    createdAt: Number(r.created_at_ms),
    noticeVersionId: r.notice_id,
    acknowledgedAt: Number(r.acknowledged_at_ms),
    jurisdiction: r.jurisdiction,
    features: r.features,
    channel: r.channel,
  };
}

async function ackOf(tx: Tx, personId: string, noticeId: string): Promise<AckRow | null> {
  const [a] = await tx`select * from notice_acks where person_id = ${personId} and notice_id = ${noticeId}`;
  return (a as AckRow | undefined) ?? null;
}

/**
 * Inserts one acknowledgement, points the person at it and audits it, in the caller's transaction. Concurrent acks of
 * one notice by one person (two web requests, or web and device sync) race to the (person, notice) unique key: the
 * loser inserts nothing and gets the winner's ack back, with `created: false`.
 */
async function recordAck(
  tx: Tx,
  deps: Deps,
  principal: Principal,
  n: NoticeRow,
  ack: { id: string; acknowledgedAt: number; jurisdiction: string; channel: "mac_app" | "web" },
): Promise<{ row: AckRow; created: boolean }> {
  const now = deps.clock.now();
  const deviceId = principal.kind === "device" ? principal.deviceId : null;
  const [row] = await tx`insert into notice_acks (tenant_id, id, person_id, notice_id, acknowledged_at_ms, created_at_ms,
      jurisdiction, features, channel, device_id)
    values (current_setting('app.tenant_id')::uuid, ${ack.id}, ${principal.personId}, ${n.id}, ${ack.acknowledgedAt}, ${now},
      ${ack.jurisdiction}, ${n.features}::jsonb, ${ack.channel}, ${deviceId})
    on conflict do nothing
    returning *`;
  if (!row) {
    const prior = await ackOf(tx, principal.personId, n.id);
    if (!prior) throw conflict("this acknowledgement id is already taken");
    return { row: prior, created: false };
  }
  await tx`update people set notice_ack_version_id = ${n.id} where id = ${principal.personId}`;
  await deps.ports.audit.write(tx, {
    actor: actorOf(principal),
    action: "notice.ack",
    subjectPersonId: principal.personId,
    resource: { type: "notice", id: n.id },
    detail: { version: n.version, channel: ack.channel, features: n.features, jurisdiction: ack.jurisdiction },
  });
  return { row: row as AckRow, created: true };
}

/** `syncHandlers.notice_ack`: an acknowledgement made in the Mac app. Idempotent on the object id and on (person, notice). */
export const syncNoticeAck: SyncHandler = async (tx, object, { principal, deps }) => {
  const v = deps.validator.validate(ACK, object);
  if (!v.ok) throw invalid("notice_ack does not match its schema", v.errors);
  const o = object as NoticeAckObject;
  if (o.channel !== "mac_app") throw invalid("a synced acknowledgement has channel mac_app");
  const [dup] = await tx`select 1 from notice_acks where id = ${o.id}`;
  if (dup) return;
  const n = await noticeById(tx, o.noticeVersionId);
  if (!n || n.published_at_ms === null) throw notFound("no such published notice");
  const p = await personRow(tx, principal.personId);
  if (!p) throw notFound();
  if (o.jurisdiction !== p.jurisdiction) throw conflict("the acknowledgement's jurisdiction is not the person's");
  if (!applies(n, p.jurisdiction)) throw conflict("this notice does not apply to the person's jurisdiction");
  if (!sameSet(o.features, n.features)) throw invalid("features must be exactly those the notice lists");
  const published = Number(n.published_at_ms);
  if (o.acknowledgedAt < published || o.acknowledgedAt > deps.clock.now() + SKEW_MS) {
    throw invalid("acknowledgedAt is before the notice was published or in the future");
  }
  const replaced = ms(n.replaced_at_ms);
  if (replaced !== null && o.acknowledgedAt >= replaced) throw conflict("a newer notice replaced this one");
  if (await ackOf(tx, principal.personId, n.id)) return;
  await recordAck(tx, deps, principal, n, { id: o.id, acknowledgedAt: o.acknowledgedAt, jurisdiction: p.jurisdiction, channel: "mac_app" });
};

export function noticeRoutes(app: App, deps: Deps): void {
  app.get("/v1/compliance/notices", async (c) => {
    const { limit, cursor } = pageParams(c);
    const offset = offsetOf(cursor);
    const out = await tenantTx(c, deps, async (tx, p) => {
      // Drafts are the editors' work in progress: owner and admin only.
      const publishedOnly = p.accessRole !== "owner" && p.accessRole !== "admin";
      const rows = await listNotices(tx, publishedOnly, offset, limit + 1);
      return page(rows.map(noticeDto), limit, () => ({ n: offset + limit }));
    });
    return replyLocal(c, deps, 200, out, `${P}/notice-list.json`);
  });

  app.post("/v1/compliance/notices", async (c) => {
    const req = await bodyOf<NoticeCreate>(c, `${P}/notice-create.json`);
    if (!isTemplate(req.template)) throw invalid(`unknown template ${req.template}`);
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('notice:' || current_setting('app.tenant_id'), 0))`;
      const [v] = await tx`select coalesce(max(version), 0) + 1 as next from notices`;
      const [row] = await tx`insert into notices (tenant_id, version, template, title, markdown, features, jurisdictions,
          created_by, created_at_ms)
        values (current_setting('app.tenant_id')::uuid, ${Number(v!.next)}, ${req.template}, ${req.title}, ${req.markdown},
          ${req.features}::jsonb, ${req.jurisdictions}::jsonb, ${p.personId}, ${now})
        returning id`;
      const n = (await noticeById(tx, row!.id as string))!;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "notice.create",
        resource: { type: "notice", id: n.id },
        detail: { version: n.version, template: n.template, features: n.features, jurisdictions: n.jurisdictions },
      });
      return noticeDto(n);
    });
    return reply(c, deps, 201, out, NOTICE);
  });

  app.post("/v1/compliance/notices/:id/publish", async (c) => {
    const id = uuidParam(c);
    await body(c, deps, "offload/control/empty.json");
    const now = deps.clock.now();
    const out = await tenantTx(c, deps, async (tx, p) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('notice:' || current_setting('app.tenant_id'), 0))`;
      const n = await noticeById(tx, id);
      if (!n) throw notFound();
      if (n.published_at_ms !== null) throw conflict("this notice version is already published");
      // Employees must never be asked to acknowledge "{{how}}": a template's fields are all filled before it goes out.
      const template = n.template === CUSTOM_TEMPLATE ? undefined : templateById(n.template);
      const unfilled = template ? unfilledFields(template, n.markdown) : [];
      if (unfilled.length > 0) {
        throw new HttpError(422, "validation_failed", `fill in every template field before publishing: ${unfilled.join(", ")}`, { fields: unfilled });
      }
      await tx`update notices set published_at_ms = ${now} where id = ${id}`;
      // The new version replaces every current one whose readers it fully covers.
      const replaced = await tx`update notices set replaced_at_ms = ${now}
        where id <> ${id} and published_at_ms is not null and replaced_at_ms is null
          and (${n.jurisdictions.length === 0}
            or (jsonb_array_length(jurisdictions) > 0 and ${n.jurisdictions}::jsonb @> jurisdictions))
        returning id`;
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "notice.publish",
        resource: { type: "notice", id },
        detail: { version: n.version, features: n.features, jurisdictions: n.jurisdictions, replaced: replaced.map((r: { id: string }) => r.id) },
      });
      return noticeDto((await noticeById(tx, id))!);
    });
    return reply(c, deps, 200, out, NOTICE);
  });

  app.get("/v1/compliance/notices/:id/acks", async (c) => {
    const id = uuidParam(c);
    const { limit, cursor } = pageParams(c);
    const offset = offsetOf(cursor);
    const scope = c.get("scope");
    const out = await tenantTx(c, deps, async (tx, p) => {
      if (!(await noticeById(tx, id))) throw notFound();
      const depts = scope === "Dp" ? p.departmentScope : null;
      const rows = (await tx`select a.person_id, a.acknowledged_at_ms from notice_acks a join people pe on pe.id = a.person_id
        where a.notice_id = ${id}
          and (${depts === null} or pe.department_id in (select jsonb_array_elements_text(${depts ?? []}::jsonb)::uuid))
        order by a.acknowledged_at_ms, a.person_id offset ${offset} limit ${limit + 1}`) as Array<{ person_id: string; acknowledged_at_ms: string }>;
      const pg = page(rows.map((r) => ({ personId: r.person_id, acknowledgedAt: Number(r.acknowledged_at_ms) })), limit, () => ({ n: offset + limit }));
      // A list of who acknowledged is a read about those people: one event naming them (as person lists do).
      await deps.ports.audit.write(tx, {
        actor: actorOf(p),
        action: "notice.acks_read",
        resource: { type: "notice", id },
        detail: { ids: pg.items.map((r) => r.personId) },
      });
      return pg;
    });
    return replyLocal(c, deps, 200, out, `${P}/notice-ack-list.json`);
  });

  app.post("/v1/me/notices/:id/ack", async (c) => {
    const id = uuidParam(c);
    await body(c, deps, "offload/control/empty.json");
    const now = deps.clock.now();
    const res = await tenantTx(c, deps, async (tx, principal) => {
      const n = await noticeById(tx, id);
      if (!n || n.published_at_ms === null) throw notFound();
      const prior = await ackOf(tx, principal.personId, id);
      if (prior) return { status: 200 as const, ack: ackDto(prior) };
      const p = await personRow(tx, principal.personId);
      if (!p) throw notFound();
      if (!applies(n, p.jurisdiction)) throw conflict("this notice does not apply to your jurisdiction");
      if (n.replaced_at_ms !== null) throw new HttpError(409, "conflict", "a newer notice replaced this one; acknowledge the current notice");
      const { row, created } = await recordAck(tx, deps, principal, n, {
        id: ulid(now), acknowledgedAt: now, jurisdiction: p.jurisdiction, channel: "web",
      });
      return { status: created ? (201 as const) : (200 as const), ack: ackDto(row) };
    });
    return reply(c, deps, res.status, res.ack, ACK);
  });
}
