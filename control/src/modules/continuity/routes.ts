import type { Context } from "hono";
import type { App, AppEnv, Deps, Principal } from "../../app.ts";
import { actorOf, body, reply, tenantTx } from "../../app.ts";
import type { Tx } from "../../db/pool.ts";
import { isUuid } from "../../db/tenant.ts";
import { lockOwners, personById } from "../../db/people.ts";
import { conflict, forbidden, invalid, notFound, page, pageParams } from "../../schema/http.ts";
import {
  HANDOVER_COLUMNS, handoverDto, tenantToday, type Continuity, type HandoverRow, type InboxStep, type InFlight,
  type OffboardReason, type Successor,
} from "./continuity.ts";
import { ACCEPT, ASSIGN, EMPTY, HANDOVER, HANDOVER_LIST, OFFBOARD, PERSON, readLocal, replyLocal } from "./schemas.ts";
import { canTransition, type PersonState } from "./states.ts";

const STATES = new Set(["open", "assigned", "closed"]);

function idParam(c: Context<AppEnv>, name = "id"): string {
  const id = c.req.param(name) ?? "";
  // Not a uuid: it cannot exist (and must not reach Postgres as a cast error).
  if (!isUuid(id)) throw notFound();
  return id;
}

/** A hand-over in the caller's scope (Dp: the workflow's department is one they lead); otherwise 404. */
async function scopedHandover(c: Context<AppEnv>, tx: Tx, p: Principal, id: string, cont: Continuity): Promise<HandoverRow> {
  const h = await cont.lockHandover(tx, id);
  if (!h) throw notFound();
  if (c.get("scope") === "Dp" && !p.departmentScope.includes(h.department_id)) throw notFound();
  return h;
}

export function continuityRoutes(app: App, deps: Deps, get: () => Continuity): void {
  app.post("/v1/people/:id/offboard", async (c) => {
    const id = idParam(c);
    const input = await body<{ effectiveOn: string; reason: OffboardReason; note: string }>(c, deps, OFFBOARD);
    const out = await tenantTx(c, deps, async (tx, p) => {
      // First in S2-10's lock order: one offboarding per tenant at a time, so two owners offboarding each other cannot
      // both see the other as the remaining owner (the check below reads committed rows only).
      await lockOwners(tx);
      const [t] = await tx`select access_role, state from people where id = ${id} for update`;
      if (!t) throw notFound();
      if (id === p.personId) throw conflict("you cannot offboard yourself");
      if (t.access_role === "owner") {
        if (p.accessRole !== "owner") throw forbidden("only an owner offboards an owner");
        const [other] = await tx`select 1 from people where access_role = 'owner' and state in ('active', 'leaving') and id <> ${id} limit 1`;
        if (!other) throw conflict("the last owner cannot be offboarded");
      }
      const state = t.state as PersonState;
      const now = deps.clock.now();
      const freezeNow = input.reason === "directory_deactivated" || input.effectiveOn <= (await tenantToday(tx, now));
      const actor = actorOf(p);
      const req = { reason: input.reason, actor, requestedBy: p.personId, note: input.note, effectiveOn: input.effectiveOn };
      if (freezeNow) {
        if (!canTransition(state, "freeze")) throw conflict(`a ${state} person cannot be frozen`);
        await get().freezeWith(tx, id, { ...req, source: input.reason === "directory_deactivated" ? "directory" : "admin" });
      } else {
        await get().markLeaving(tx, id, req);
      }
      const person = await personById(tx, id);
      await deps.ports.audit.write(tx, {
        actor,
        action: "person.offboard",
        subjectPersonId: id,
        resource: { type: "person", id },
        // The note stays on the offboarding row; the audit log keeps only what was decided.
        detail: { reason: input.reason, effectiveOn: input.effectiveOn, state: person!.state, from: state },
      });
      return person;
    });
    return reply(c, deps, 200, out, PERSON);
  });

  app.get("/v1/handovers", async (c) => {
    const { limit, cursor } = pageParams(c);
    const after = typeof cursor?.id === "string" && isUuid(cursor.id) ? cursor.id : null;
    if (cursor !== null && after === null) throw invalid("bad cursor");
    const state = c.req.query("state") || null;
    if (state !== null && !STATES.has(state)) throw invalid("state must be open, assigned or closed");
    const out = await tenantTx(c, deps, async (tx, p) => {
      const dp = c.get("scope") === "Dp";
      const rows = (await tx`select ${tx.unsafe(HANDOVER_COLUMNS)} from handovers
        where (${after}::uuid is null or id > ${after}::uuid) and (${state}::text is null or state = ${state}::text)
          and (${dp} = false or department_id in (select jsonb_array_elements_text(${p.departmentScope}::jsonb)::uuid))
        order by id limit ${limit + 1}`) as HandoverRow[];
      return page(rows.map(handoverDto), limit, (l) => ({ id: l.id }));
    });
    return replyLocal(c, deps, 200, out, HANDOVER_LIST);
  });

  app.post("/v1/handovers/:id/assign", async (c) => {
    const id = idParam(c);
    const input = await readLocal<{ successor: Successor; inFlight?: InFlight; inboxStep?: InboxStep | null }>(c, ASSIGN);
    const out = await tenantTx(c, deps, async (tx, p) =>
      get().assign(tx, await scopedHandover(c, tx, p, id, get()), { personId: p.personId, actor: actorOf(p) }, input),
    );
    return reply(c, deps, 200, out, HANDOVER);
  });

  app.post("/v1/handovers/:id/accept", async (c) => {
    const id = idParam(c);
    const input = await readLocal<{ reviewedHandoverMessage?: boolean }>(c, ACCEPT);
    const out = await tenantTx(c, deps, async (tx, p) => {
      const h = await get().lockHandover(tx, id);
      // Only the named person successor may accept (any access role: S in every person column); to anyone else the hand-over does not exist (S scope).
      if (!h || h.successor_type !== "person" || h.successor_person_id !== p.personId) throw notFound();
      return get().accept(tx, h, { personId: p.personId, actor: actorOf(p) }, input);
    });
    return reply(c, deps, 200, out, HANDOVER);
  });

  app.post("/v1/handovers/:id/close", async (c) => {
    const id = idParam(c);
    await readLocal(c, EMPTY);
    const out = await tenantTx(c, deps, async (tx, p) =>
      get().close(tx, await scopedHandover(c, tx, p, id, get()), { personId: p.personId, actor: actorOf(p) }),
    );
    return reply(c, deps, 200, out, HANDOVER);
  });
}
