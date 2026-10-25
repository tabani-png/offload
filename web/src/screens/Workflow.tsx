import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import type { Connection, Department, JobRole, Person, PromoteRequest, Workflow, WorkflowDefinition, WorkflowStep } from "../api/types.ts";
import {
  Button, Card, Chip, ErrorNote, Field, Row, Section, Segmented, Sheet, StateTag,
} from "../design/components.tsx";
import { shortHash, timeText } from "../lib/format.ts";
import { Load, useDeps, useGet, useKey, useText } from "../app/data.tsx";
import { Page } from "../app/page.tsx";
import { WORKFLOW_STATE } from "./Workflows.tsx";

const OWNERSHIP_WORDS = { company: "Company", "personal-allowed": "Personal, allowed", "personal-forbidden": "Personal, not allowed" } as const;
const CLASS_WORDS = { read: "Reads", draft: "Drafts", commit: "Sends or writes" } as const;
const GATE_WORDS = { none: "No gate", approval: "Needs approval", overnight_policy: "Approval or overnight policy" } as const;

/** A commit step bound to a personal LinkedIn can never run (ADR 0104, 0107). */
export const isForbiddenStep = (s: WorkflowStep) => s.class === "commit" && s.connection?.kind === "linkedin_personal";

function Step(props: { n: number; step: WorkflowStep }) {
  const s = props.step;
  return (
    <div className="step">
      <span className="step-n t-label">{props.n}</span>
      <div className="stack" style={{ gap: 4 }}>
        <span className="t-label ink1">{s.title}</span>
        <span className="t-callout ink2">{s.detail}</span>
        <span className="inline t-footnote ink3">
          <span className="mono">{s.capability}</span>
          {s.connection && <span>· {s.connection.label}</span>}
          <span>· {GATE_WORDS[s.gate]}</span>
        </span>
        {isForbiddenStep(s) && (
          <StateTag role="needsYou">A personal LinkedIn can never be automated. This step must be turned off to promote.</StateTag>
        )}
      </div>
      <div className="inline">
        <Chip>{CLASS_WORDS[s.class]}</Chip>
        {s.connection && <Chip tone={s.connection.ownership === "company" ? "neutral" : "needsYou"}>{OWNERSHIP_WORDS[s.connection.ownership]}</Chip>}
      </div>
    </div>
  );
}

export function WorkflowScreen() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const navigate = useNavigate();
  const wq = useGet<Workflow>(`/v1/workflows/${id}`);
  const [version, setVersion] = useState<number | null>(null);
  const [sheet, setSheet] = useState<"promote" | "sop" | "decline" | null>(null);
  useEffect(() => {
    if (wq.data && version === null) setVersion(wq.data.latestVersion);
  }, [wq.data, version]);
  const v = version ?? wq.data?.latestVersion ?? null;
  const def = useGet<WorkflowDefinition>(v ? `/v1/workflows/${id}/versions/${v}` : null);
  const roles = useGet<JobRole[]>("/v1/job-roles");
  const people = useGet<Person[]>("/v1/people");
  const personName = (pid: string | null) => people.data?.find((p) => p.id === pid)?.displayName ?? "Someone";
  const w = wq.data;

  const primary = w?.state === "proposed"
    ? <Button primary keycap="P" onClick={() => setSheet("promote")}>Promote to a job role</Button>
    : w?.state === "role"
      ? <Button primary keycap="E" onClick={() => void navigate({ to: "/workflows/$id/evidence", params: { id } })}>See evidence</Button>
      : null;

  useKey("p", () => setSheet("promote"), w?.state === "proposed");
  useKey("e", () => void navigate({ to: "/workflows/$id/evidence", params: { id } }), w?.state === "role");
  useKey("s", () => setSheet("sop"), !!w);

  return (
    <Page title={w?.name ?? "Workflow"} subtitle="Workflow" actions={<>
      {w && <Button keycap="S" onClick={() => setSheet("sop")}>Preview SOP</Button>}
      {w?.state === "proposed" && <Button onClick={() => setSheet("decline")}>Decline</Button>}
      {primary}
    </>}>
      <Load q={wq}>
        {(w) => (
          <>
            <Card>
              <dl className="kv">
                <dt>State</dt><dd><StateTag role={WORKFLOW_STATE[w.state].role}>{WORKFLOW_STATE[w.state].words}</StateTag></dd>
                <dt>Job role</dt><dd>{roles.data?.find((r) => r.id === w.jobRoleId)?.name ?? <span className="ink3">Not assigned</span>}</dd>
                <dt>Proposed by</dt><dd>{personName(w.proposedBy)}</dd>
                {w.promotedAt && <><dt>Promoted</dt><dd>{timeText(w.promotedAt)} by {personName(w.promotedBy)}</dd></>}
                <dt>Baseline</dt><dd>{w.baselineGrade ? `Grade ${w.baselineGrade}` : <span className="ink3">No baseline yet</span>}</dd>
              </dl>
            </Card>

            <Section title="Versions" aside="Each version is immutable">
              <div className="spread">
                <Segmented<string> label="Version" value={String(v)} onChange={(x) => setVersion(Number(x))}
                  options={w.versions.map((x) => ({ value: String(x.version), label: `v${x.version}` }))} />
              </div>
              <Card>
                <div>
                  {[...w.versions].reverse().map((x) => (
                    <Row key={x.version} state={x.version === w.latestVersion ? "done" : "neutral"} stateLabel={x.version === w.latestVersion ? "Latest" : "Earlier"}
                      title={`Version ${x.version}`}
                      detail={<>Created {timeText(x.createdAt)} by {personName(x.createdBy)} · <span className="mono">{shortHash(x.definitionHash)}</span></>} />
                  ))}
                </div>
              </Card>
            </Section>

            <Section title={`Steps in version ${v ?? ""}`}>
              <Card>
                <Load q={def}>
                  {(d) => (
                    <div>
                      <p className="t-body ink2">{d.description}</p>
                      {d.steps.map((s, i) => <Step key={s.id} n={i + 1} step={s} />)}
                      <p className="t-footnote ink3">At most {d.limits.maxItemsPerRun} items per run and {d.limits.maxRunsPerDay} runs a day. No recipients, message content or tokens are stored in a definition.</p>
                    </div>
                  )}
                </Load>
              </Card>
            </Section>
            {w.state === "role" && (
              <p className="t-callout ink3"><Link to="/workflows/$id/evidence" params={{ id: w.id }} className="link">Evidence</Link> lists the baseline samples and every run behind the hours.</p>
            )}
          </>
        )}
      </Load>
      {w && def.data && <PromoteSheet key={def.data.id} open={sheet === "promote"} onClose={() => setSheet(null)} workflow={w} def={def.data} />}
      {w && v && <SopSheet open={sheet === "sop"} onClose={() => setSheet(null)} id={w.id} version={v} />}
      {w && <DeclineSheet open={sheet === "decline"} onClose={() => setSheet(null)} id={w.id} />}
    </Page>
  );
}

function SopSheet(props: { open: boolean; onClose: () => void; id: string; version: number }) {
  const q = useText(props.open ? `/v1/workflows/${props.id}/versions/${props.version}/sop?format=md` : null);
  return (
    <Sheet open={props.open} onClose={props.onClose} title={`SOP preview, version ${props.version}`} wide>
      <Load q={q}>{(md) => <pre className="pre" aria-label="SOP in Markdown">{md}</pre>}</Load>
    </Sheet>
  );
}

function DeclineSheet(props: { open: boolean; onClose: () => void; id: string }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post<Workflow>(`/v1/workflows/${props.id}/decline`, { reason }),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  return (
    <Sheet open={props.open} onClose={props.onClose} title="Decline this proposal"
      footer={<Button primary type="submit" form="decline-form" disabled={reason.trim() === "" || m.isPending} keycap="↩">Decline</Button>}>
      <form id="decline-form" className="stack" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
        <Field label="Reason" hint="The person who shared it sees this.">
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}

interface Binding { connectionId: string | null; disable: boolean }

export function PromoteSheet(props: { open: boolean; onClose: () => void; workflow: Workflow; def: WorkflowDefinition }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const roles = useGet<JobRole[]>("/v1/job-roles");
  const depts = useGet<Department[]>("/v1/departments");
  const conns = useGet<Connection[]>("/v1/connections");
  const company = conns.data?.filter((c) => c.ownership === "company") ?? [];
  const bound = props.def.steps.filter((s) => s.connection !== null);
  const [jobRoleId, setJobRoleId] = useState("");
  const [bindings, setBindings] = useState<Record<string, Binding>>(() =>
    Object.fromEntries(bound.map((s) => [s.id, {
      connectionId: s.connection!.ownership === "company" ? s.connection!.connectionId : null,
      disable: isForbiddenStep(s),
    }])),
  );
  const [touched, setTouched] = useState(false);
  const role = roles.data?.find((r) => r.id === jobRoleId);
  const unresolved = bound.filter((s) => !bindings[s.id]?.disable && !bindings[s.id]?.connectionId);
  const problem = !jobRoleId ? "Choose the job role that will own this workflow." : unresolved.length > 0
    ? `Bind ${unresolved.map((s) => `"${s.title}"`).join(", ")} to a company connection, or turn it off.` : null;

  const m = useMutation({
    mutationFn: (body: PromoteRequest) => api.post<Workflow>(`/v1/workflows/${props.workflow.id}/promote`, body),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (problem || !role) return;
    m.mutate({
      jobRoleId: role.id, departmentId: role.departmentId, fromVersion: props.def.version ?? props.workflow.latestVersion,
      bindings: bound.map((s) => ({ stepId: s.id, connectionId: bindings[s.id]!.disable ? null : bindings[s.id]!.connectionId, disable: bindings[s.id]!.disable })),
    });
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title={`Promote "${props.workflow.name}"`} wide
      footer={<Button primary type="submit" form="promote-form" disabled={m.isPending} keycap="↩">Promote as a new version</Button>}>
      <form id="promote-form" className="stack" onSubmit={submit} noValidate>
        <p className="t-body ink2">
          Promoting makes a new, immutable version owned by a job role. Personal data in the definition is stripped, and every
          step that uses a connection must use a company connection or be turned off.
        </p>
        <Field label="Job role">
          <select className="input" value={jobRoleId} onChange={(e) => setJobRoleId(e.target.value)} required>
            <option value="">Choose a job role</option>
            {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        {role && <p className="t-callout ink3">Department: {depts.data?.find((d) => d.id === role.departmentId)?.name}</p>}
        <fieldset className="checks" style={{ flexDirection: "column" }}>
          <legend className="t-label ink1">Connections</legend>
          {bound.map((s) => {
            const b = bindings[s.id]!;
            const forbidden = isForbiddenStep(s);
            return (
              <div key={s.id} className="well stack" style={{ gap: 8 }}>
                <div className="spread">
                  <span className="t-label ink1">{s.title}</span>
                  <Chip tone={s.connection!.ownership === "company" ? "neutral" : "needsYou"}>{s.connection!.label}, {OWNERSHIP_WORDS[s.connection!.ownership].toLowerCase()}</Chip>
                </div>
                {forbidden ? (
                  <span className="t-callout ink2">Turned off. A personal LinkedIn can never be automated, on a Mac or in the cloud.</span>
                ) : (
                  <div className="inline">
                    <select className="input" aria-label={`Connection for ${s.title}`} disabled={b.disable} value={b.connectionId ?? ""}
                      onChange={(e) => setBindings({ ...bindings, [s.id]: { ...b, connectionId: e.target.value || null } })}>
                      <option value="">Choose a company connection</option>
                      {company.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <label className="check t-callout ink2">
                      <input type="checkbox" checked={b.disable} onChange={(e) => setBindings({ ...bindings, [s.id]: { ...b, disable: e.target.checked } })} />
                      Turn this step off
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </fieldset>
        {touched && problem && <p className="t-callout state-ink-needs-you" role="alert">{problem}</p>}
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}
