import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { Handover, JobRole, Person, RoleIdentity, Workflow } from "../api/types.ts";
import { Button, Card, ErrorNote, Field, Row, Section, Sheet } from "../design/components.tsx";
import type { StateRole } from "../design/tokens.ts";
import { timeText } from "../lib/format.ts";
import { Load, useDeps, useList, useKey } from "../app/data.tsx";
import { Page } from "../app/page.tsx";
import { PERSON_STATE } from "./People.tsx";

const HANDOVER_STATE: Record<Handover["state"], { role: StateRole; words: string }> = {
  open: { role: "needsYou", words: "Needs a successor" },
  assigned: { role: "working", words: "Assigned" },
  closed: { role: "done", words: "Closed" },
};

const IN_FLIGHT = {
  pause: "Pause in-flight runs until the successor accepts",
  handover_message: "Send a short hand-over note to open threads",
  stop: "Stop in-flight runs",
} as const;

const INBOX = {
  none: "Nothing to move",
  google_alias: "Google: add the address as an alias of the successor",
  google_migrate: "Google: migrate the mailbox",
  google_archive: "Google: archive the mailbox",
  m365_shared_mailbox: "Microsoft 365: convert to a shared mailbox",
} as const;

export function OffboardingScreen() {
  const handovers = useList<Handover>("/v1/handovers");
  const people = useList<Person>("/v1/people");
  const workflows = useList<Workflow>("/v1/workflows");
  const identities = useList<RoleIdentity>("/v1/role-identities");
  const [open, setOpen] = useState<Handover | null>(null);
  const person = (id: string) => people.data?.find((p) => p.id === id);
  const wfName = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? "Workflow";
  const leavers = people.data?.filter((p) => p.state === "leaving" || p.state === "frozen") ?? [];
  const firstOpen = handovers.data?.find((h) => h.state === "open");
  useKey("Enter", () => firstOpen && setOpen(firstOpen), !!firstOpen && !open);
  const successorText = (h: Handover) => !h.successor ? "No successor yet"
    : h.successor.type === "person" ? `To ${person(h.successor.personId)?.displayName ?? "a person"}`
      : `To ${identities.data?.find((i) => i.id === (h.successor as { roleIdentityId: string }).roleIdentityId)?.label ?? "a role identity"} (role identity)`;

  return (
    <Page title="Offboarding" subtitle="Hand-overs for people who are leaving"
      actions={firstOpen && <Button primary keycap="↩" onClick={() => setOpen(firstOpen)}>Assign the next hand-over</Button>}>
      <p className="t-callout ink2">
        When someone leaves, their runs freeze and personal connections stop. Nothing resumes until each workflow has a
        successor or a role identity. Nothing is ever sent as a person who has left.
      </p>
      <Load q={handovers}>
        {(hs) => (
          <>
            {leavers.map((p) => (
              <Section key={p.id} title={p.displayName} aside={`${PERSON_STATE[p.state].words}${p.leavingOn ? `, last day ${p.leavingOn}` : ""}`}>
                <Card>
                  {hs.filter((h) => h.personId === p.id).map((h) => (
                    <Row key={h.id} state={HANDOVER_STATE[h.state].role} stateLabel={HANDOVER_STATE[h.state].words}
                      title={wfName(h.workflowId)}
                      detail={<>{HANDOVER_STATE[h.state].words} · {successorText(h)}{h.assignedAt ? ` · ${timeText(h.assignedAt)}` : ""}{h.removedConnections.length > 0 ? ` · ${h.removedConnections.length} personal connection removed` : ""}</>}
                      trailing={h.state !== "closed" && <Button onClick={() => setOpen(h)}>{h.state === "open" ? "Assign" : "Change"}</Button>} />
                  ))}
                  {hs.every((h) => h.personId !== p.id) && <p className="t-callout ink3">No workflows to hand over.</p>}
                </Card>
              </Section>
            ))}
            {leavers.length === 0 && <p className="t-body ink2">Nobody is leaving right now.</p>}
          </>
        )}
      </Load>
      {open && <HandoverSheet key={open.id} handover={open} onClose={() => setOpen(null)} workflowName={wfName(open.workflowId)} leaver={person(open.personId)} />}
    </Page>
  );
}

function HandoverSheet(props: { handover: Handover; onClose: () => void; workflowName: string; leaver?: Person }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const workflows = useList<Workflow>("/v1/workflows");
  const roles = useList<JobRole>("/v1/job-roles");
  const people = useList<Person>("/v1/people");
  const identities = useList<RoleIdentity>("/v1/role-identities");
  const wf = workflows.data?.find((w) => w.id === props.handover.workflowId);
  const role = roles.data?.find((r) => r.id === wf?.jobRoleId);
  const candidates = (people.data ?? []).filter((p) => role?.holderPersonIds.includes(p.id) && p.id !== props.handover.personId && p.state === "active");
  const ids = (identities.data ?? []).filter((i) => i.jobRoleId === role?.id);
  const initial = props.handover.successor
    ? props.handover.successor.type === "person" ? `person:${props.handover.successor.personId}` : `identity:${props.handover.successor.roleIdentityId}`
    : "";
  const [succ, setSucc] = useState(initial);
  const [inFlight, setInFlight] = useState<Handover["inFlight"]>(props.handover.inFlight);
  const [inbox, setInbox] = useState<NonNullable<Handover["inboxStep"]>>(props.handover.inboxStep ?? "none");
  const [touched, setTouched] = useState(false);

  const m = useMutation({
    mutationFn: (body: Pick<Handover, "successor" | "inFlight" | "inboxStep">) => api.post<Handover>(`/v1/handovers/${props.handover.id}/assign`, body),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!succ) return;
    const [kind, id] = succ.split(":") as [string, string];
    m.mutate({
      successor: kind === "person" ? { type: "person", personId: id } : { type: "role_identity", roleIdentityId: id },
      inFlight, inboxStep: inbox,
    });
  };

  return (
    <Sheet open onClose={props.onClose} title={`Hand over "${props.workflowName}"`}
      footer={<Button primary type="submit" form="handover-form" disabled={m.isPending} keycap="↩">Assign</Button>}>
      <form id="handover-form" className="stack" onSubmit={submit} noValidate>
        <p className="t-body ink2">From {props.leaver?.displayName ?? "the person leaving"}. A person must hold the job role{role ? ` (${role.name})` : ""} and accept before anything resumes.</p>
        <fieldset className="checks" style={{ flexDirection: "column" }}>
          <legend className="t-label ink1">Successor</legend>
          {ids.map((i) => (
            <label key={i.id} className="check t-body ink2">
              <input type="radio" name="succ" value={`identity:${i.id}`} checked={succ === `identity:${i.id}`} onChange={(e) => setSucc(e.target.value)} />
              {i.label} ({i.address ?? "role identity"}), sends as the team
            </label>
          ))}
          {candidates.map((p) => (
            <label key={p.id} className="check t-body ink2">
              <input type="radio" name="succ" value={`person:${p.id}`} checked={succ === `person:${p.id}`} onChange={(e) => setSucc(e.target.value)} />
              {p.displayName}
            </label>
          ))}
          {ids.length === 0 && candidates.length === 0 && <span className="t-callout ink3">Nobody else holds this job role yet.</span>}
        </fieldset>
        <Field label="Runs already in flight">
          <select className="input" value={inFlight} onChange={(e) => setInFlight(e.target.value as Handover["inFlight"])}>
            {Object.entries(IN_FLIGHT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Mailbox" hint="You do this in Google or Microsoft 365; Offload records what you chose.">
          <select className="input" value={inbox} onChange={(e) => setInbox(e.target.value as NonNullable<Handover["inboxStep"]>)}>
            {Object.entries(INBOX).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        {touched && !succ && <p className="t-callout state-ink-needs-you" role="alert">Choose a successor or a role identity.</p>}
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}
