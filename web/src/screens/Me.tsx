import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import type { AuditEvent, Person, SelfView, Workflow } from "../api/types.ts";
import { isSuppressed } from "../api/types.ts";
import { Button, Card, ErrorNote, Field, GradeSplit, Row, Section, Sheet, StatHero, StateTag, Table } from "../design/components.tsx";
import { hoursText, timeText } from "../lib/format.ts";
import { Load, useDeps, useGet, useList, useKey, usePeriod, useSession } from "../app/data.tsx";
import { Page, ROLE_WORDS } from "../app/page.tsx";
import { confidenceChip } from "./Overview.tsx";

const ACTION_WORDS: Record<string, string> = {
  "person.read": "Opened your record",
  "person.list": "Listed people, you included",
  "person.update": "Changed your record",
  "self.export": "Downloaded your data",
  "person.offboard": "Started your offboarding",
  "notice.ack": "Acknowledged a notice",
  "device.enrollment_code": "Made a code to connect a Mac",
  "device.enrolled": "Connected a Mac",
  "device.revoked": "Disconnected a Mac",
  "workflow.proposed": "Shared a workflow with the team",
  "workflow.promoted": "Made your shared workflow a team workflow",
  "batch.propose": "Prepared a batch for your approval",
};

/**
 * Who did it, in words. A member may not list people, so a person the screen cannot name is shown by access role;
 * "System" is only for the system itself.
 */
function actorWords(e: AuditEvent, me: SelfView, name: (id: string) => string | null) {
  if (e.actor.id === me.person.id) return "You";
  if (e.actor.type === "device") return me.devices.some((d) => d.id === e.actor.id) ? "Your Mac" : "A Mac";
  if (e.actor.type === "person") {
    const n = e.actor.id ? name(e.actor.id) : null;
    const role = e.actor.accessRole ? ROLE_WORDS[e.actor.accessRole] : "Someone";
    return n ? <>{n} <span className="ink3">{role}</span></> : role;
  }
  if (e.actor.type === "support") return "Offload support";
  return e.actor.type === "service" ? "A cloud worker" : "System";
}

export function MeScreen() {
  const { api } = useDeps();
  const q = useGet<SelfView>("/v1/me/data");
  const period = usePeriod();
  // Members may not list people (API.md): don't ask, the access log then names readers by role.
  const session = useSession();
  const role = session.data?.person.accessRole;
  const people = useList<Person>(role && role !== "member" ? "/v1/people" : null);
  const workflows = useList<Workflow>("/v1/workflows");
  const [correcting, setCorrecting] = useState(false);
  const name = (id: string) => people.data?.find((p) => p.id === id)?.displayName ?? null;
  const wfName = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? "Workflow";
  const exportM = useMutation({
    mutationFn: () => api.get<SelfView>("/v1/me/export"),
    onSuccess: (data) => {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = "offload-my-data.json";
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  useKey("Enter", () => exportM.mutate(), !correcting && !exportM.isPending);

  return (
    <Page title="My data" subtitle="Everything the company side holds about you"
      actions={<>
        <Button onClick={() => setCorrecting(true)}>Ask for a correction</Button>
        <Button primary keycap="↩" onClick={() => exportM.mutate()} disabled={exportM.isPending}>Download my data</Button>
      </>}>
      {exportM.isError && <ErrorNote error={exportM.error} />}
      <Load q={q}>
        {(me) => (
          <>
            <Section title="Who looked at my data" aside="From the audit log; nobody can remove an entry">
              <Card>
                <Table caption="Who viewed my data" rows={[...me.accessLog].reverse()} rowKey={(e) => e.id} empty="Nobody has opened your data."
                  columns={[
                    { key: "when", header: "When", cell: (e) => timeText(e.at) },
                    { key: "who", header: "Who", cell: (e) => actorWords(e, me, name) },
                    { key: "what", header: "What", cell: (e) => ACTION_WORDS[e.action] ?? e.action },
                  ]} />
              </Card>
            </Section>

            <div className="grid-2">
              <Card title="My hours saved" aside={<span className="t-callout ink3">{period?.label}</span>}>
                {isSuppressed(me.hoursSaved.total) ? <span className="ink3">Not available</span> : (
                  <div className="stack">
                    <StatHero value={hoursText(me.hoursSaved.total.seconds)} chip={confidenceChip(me.hoursSaved.total)} label="From the workflows of your job roles." />
                    {me.hoursSaved.total.seconds > 0 && <GradeSplit byGrade={me.hoursSaved.total.byGrade} size={72} />}
                  </div>
                )}
              </Card>
              <Card title="What is on for me">
                <div>
                  <Row state="done" title="Workflow metrics" detail="Group totals of 5 or more people, and your runs' outcomes. No content." />
                  <Row state={me.features.per_person_views ? "working" : "neutral"} stateLabel={me.features.per_person_views ? "On" : "Off"}
                    title="Per-person views" detail={me.features.per_person_views ? "On. Each time someone opens your numbers it shows above." : "Off. Nobody at the company can see your own numbers."} />
                  <Row state={me.features.working_time ? "working" : "neutral"} stateLabel={me.features.working_time ? "On" : "Off"}
                    title="Working time" detail={me.features.working_time ? "On. Active minutes per day are sent." : "Off. No active time is sent."} />
                </div>
              </Card>
            </div>

            <div className="grid-2">
              <Card title="Notices I acknowledged">
                <div>
                  {me.acks.map((a) => <Row key={a.id} state="done" title={`Acknowledged ${timeText(a.acknowledgedAt)}`} detail={`On ${a.channel === "mac_app" ? "the Mac app" : "the web"}, as ${a.jurisdiction}`} />)}
                </div>
              </Card>
              <Card title="Devices and retention">
                <div>
                  {me.devices.map((d) => <Row key={d.id} state={d.state === "active" ? "done" : "neutral"} title={d.name} detail={`App ${d.appVersion} · last sync ${d.lastSyncAt ? timeText(d.lastSyncAt) : "never"}`} />)}
                  <Row title="Kept here" detail={`Your own numbers ${me.retention.perPersonDays} days, working time ${me.retention.workingTimeDays} days. Raw activity stays on your Mac for 7 days and never comes here.`} />
                </div>
              </Card>
            </div>

            <Section title="My recent runs" aside="Outcomes only; drafts and messages stay on your Mac">
              <Card>
                <Table caption="My recent runs" rows={me.runs} rowKey={(r) => r.id}
                  columns={[
                    { key: "when", header: "Ended", cell: (r) => timeText(r.endedAt) },
                    { key: "wf", header: "Workflow", cell: (r) => wfName(r.workflowId) },
                    { key: "outcome", header: "Outcome", cell: (r) => <StateTag role={r.outcome === "success" ? "done" : "needsYou"}>{r.outcome === "success" ? "Succeeded" : "Failed"}</StateTag> },
                    { key: "items", header: "Items sent", align: "end", cell: (r) => r.items.sent },
                  ]} />
              </Card>
            </Section>
          </>
        )}
      </Load>
      {correcting && <CorrectionSheet onClose={() => setCorrecting(false)} />}
    </Page>
  );
}

function CorrectionSheet(props: { onClose: () => void }) {
  const { api } = useDeps();
  const [field, setField] = useState("");
  const [message, setMessage] = useState("");
  const m = useMutation({ mutationFn: () => api.post<{ id: string }>("/v1/me/correction-requests", { field, message }) });
  return (
    <Sheet open onClose={props.onClose} title="Ask for a correction"
      footer={!m.isSuccess && <Button primary type="submit" form="correct-form" disabled={!field.trim() || !message.trim() || m.isPending} keycap="↩">Send</Button>}>
      {m.isSuccess ? <StateTag role="done">Sent. An admin will answer, and the request is in the audit log.</StateTag> : (
        <form id="correct-form" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Field label="What is wrong"><input className="input" value={field} onChange={(e) => setField(e.target.value)} placeholder="For example: department" /></Field>
          <Field label="What it should say"><textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} /></Field>
          {m.isError && <ErrorNote error={m.error} />}
        </form>
      )}
    </Sheet>
  );
}
