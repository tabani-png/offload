import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Digest, KillSwitch, OvernightPolicy, Person, Workflow } from "../api/types.ts";
import { ApiError } from "../api/client.ts";
import { Button, Card, Chip, ErrorNote, Field, Row, Section, Sheet, StateTag } from "../design/components.tsx";
import { dayText, timeText, usd } from "../lib/format.ts";
import { Load, useDeps, useGet, useList, usePeriod, useSession } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

const OUTCOME = {
  success: { role: "done", words: "Done" }, failed: { role: "needsYou", words: "Failed" }, cancelled: { role: "neutral", words: "Cancelled" },
  rejected: { role: "neutral", words: "Rejected" }, capped: { role: "needsYou", words: "Stopped at budget" },
} as const;

/** Only an owner or admin may set a tenant-wide stop (API.md, S2-07). */
export const canStopAll = (me: Person | undefined) => me?.accessRole === "owner" || me?.accessRole === "admin";

/**
 * Who may clear the tenant stop (API.md "Clearing a kill switch"): an owner always; an admin unless an owner set it.
 * The setter's role comes from the directory; when it cannot be read the button is not offered (the server decides).
 */
export function canClearStopAll(me: Person | undefined, k: KillSwitch, people: Person[] | undefined) {
  if (me?.accessRole === "owner") return true;
  if (me?.accessRole !== "admin") return false;
  const setter = people?.find((p) => p.id === k.setBy);
  return setter !== undefined && setter.accessRole !== "owner";
}

export function DigestScreen() {
  const navigate = useNavigate();
  const period = usePeriod();
  const q = useGet<Digest>(period ? `/v1/me/digest?day=${period.today}` : null);
  const workflows = useList<Workflow>("/v1/workflows");
  const policies = useList<OvernightPolicy>("/v1/overnight-policies");
  const switches = useList<KillSwitch>("/v1/kill-switches");
  const [stopOpen, setStopOpen] = useState(false);
  const name = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? "Workflow";
  const policyName = (id: string) => name(policies.data?.find((p) => p.id === id)?.workflowId ?? "");
  const waiting = q.data?.waiting.length ?? 0;
  const tenantStop = switches.data?.find((k) => k.scope === "tenant" && k.active);
  const me = useSession().data?.person;
  const people = useList<Person>(tenantStop && me?.accessRole === "admin" ? "/v1/people" : null);
  const [clearOpen, setClearOpen] = useState(false);
  const canClear = tenantStop !== undefined && canClearStopAll(me, tenantStop, people.data);

  return (
    <Page title="Morning digest" subtitle={q.data ? dayText(q.data.day) : undefined}
      actions={<>
        {canClear && <Button onClick={() => setClearOpen(true)}>Clear the stop</Button>}
        {canStopAll(me) && !tenantStop && <Button onClick={() => setStopOpen(true)}>Stop all sending</Button>}
        {waiting > 0 && <Button primary keycap="3" onClick={() => void navigate({ to: "/approvals" })}>Review {waiting} waiting</Button>}
      </>}>
      {tenantStop && <StateTag role="needsYou">All sending is stopped since {timeText(tenantStop.setAt)}: {tenantStop.reason}</StateTag>}
      {q.error instanceof ApiError && q.error.code === "not_found" ? (
        // No digest for the day (none compiled yet, or the server does not offer it): calm words, not a fault.
        <Card><p className="t-body ink2" role="note">There is no morning digest for today yet.</p></Card>
      ) : <Load q={q}>
        {(d) => (
          <>
            <div className="grid-3">
              <Card><div className="stat"><span className="stat-value">{d.ran.length}</span><span className="t-callout ink2">runs overnight</span></div></Card>
              <Card><div className="stat"><span className="stat-value">{waiting}</span><span className="t-callout ink2">batches waiting for approval</span></div></Card>
              <Card><div className="stat"><span className="stat-value">{usd(d.totalCostCents)}</span><span className="t-callout ink2">spent on cloud runs</span></div></Card>
            </div>

            <Section title="Waiting for you">
              <Card>
                {d.waiting.length === 0 ? <p className="t-body ink2">Nothing is waiting.</p> : d.waiting.map((w) => (
                  <Row key={w.batchHash} state="needsYou" title={name(w.workflowId)} detail={`${w.items} ${w.items === 1 ? "item" : "items"} drafted, nothing sent yet`} />
                ))}
              </Card>
            </Section>

            <div className="grid-2">
              <Card title="Ran overnight">
                <div>
                  {d.ran.map((r) => (
                    <Row key={r.runId} state={OUTCOME[r.outcome].role} stateLabel={OUTCOME[r.outcome].words}
                      title={name(r.workflowId)} detail={`${OUTCOME[r.outcome].words} · ${r.drafts} drafts`} trailing={<span className="t-callout ink2">{usd(r.costCents)}</span>} />
                  ))}
                </div>
              </Card>
              <Card title="Sent under a policy">
                <div>
                  {d.autoCommitted.length === 0 && <p className="t-callout ink3">Nothing was sent without a person.</p>}
                  {d.autoCommitted.map((a) => (
                    <Row key={a.batchHash} state="done" title={policyName(a.policyId)} detail={`${a.items} items matched the pinned template and recipient list`} />
                  ))}
                  {d.trips.map((t) => (
                    <Row key={t.policyId} state="needsYou" stateLabel="Policy stopped" title={`${policyName(t.policyId)}: policy stopped`} detail={t.reason} />
                  ))}
                </div>
              </Card>
            </div>

            <Section title="Could be next" aside="Estimates, not measurements">
              <Card>
                {d.suggestions.map((s) => (
                  <Row key={s.title} title={s.title} detail={s.class === "commit" ? "Would send or write, so it needs approval" : "Drafts only"}
                    trailing={<Chip>about {s.estimatedMinutes} min a week, {s.label}</Chip>} />
                ))}
              </Card>
            </Section>
          </>
        )}
      </Load>}
      <StopSheet open={stopOpen} onClose={() => setStopOpen(false)} />
      <ClearSheet open={clearOpen} onClose={() => setClearOpen(false)} />
    </Page>
  );
}

function StopSheet(props: { open: boolean; onClose: () => void }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<KillSwitch>("/v1/kill-switches", { scope: "tenant", targetId: null, reason }),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Stop all sending"
      footer={<Button primary type="submit" form="stop-form" disabled={reason.trim() === "" || m.isPending} keycap="↩">Stop now</Button>}>
      <form id="stop-form" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <p className="t-body ink2">
          Every workflow in the company stops before its next send, on Macs and in the cloud. Drafts are kept. An owner
          or admin can clear it later; a stop an owner sets is cleared only by an owner.
        </p>
        <Field label="Reason" hint="Shown to everyone whose workflows stop.">
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}

function ClearSheet(props: { open: boolean; onClose: () => void }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api.delete<KillSwitch>("/v1/kill-switches/tenant/null"),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Clear the stop"
      footer={<Button primary type="submit" form="clear-form" disabled={m.isPending} keycap="↩">Clear now</Button>}>
      <form id="clear-form" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <p className="t-body ink2">Workflows may send again from their next step. Batches still need their approvals.</p>
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}
