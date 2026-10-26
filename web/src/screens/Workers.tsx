import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { JobRole, Worker, WorkerRun, Workflow } from "../api/types.ts";
import { Card, Section, StateTag, Table } from "../design/components.tsx";
import type { StateRole } from "../design/tokens.ts";
import { relativeText, shortHash, timeText, usd } from "../lib/format.ts";
import { Load, useDeps, useGet, useList } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

const WORKER_STATE: Record<Worker["state"], { role: StateRole; words: string }> = {
  provisioning: { role: "working", words: "Setting up" },
  ready: { role: "done", words: "Ready" },
  paused: { role: "neutral", words: "Paused" },
  failed: { role: "needsYou", words: "Failed" },
  retired: { role: "neutral", words: "Retired" },
};

const RUN_STATE: Record<WorkerRun["state"], { role: StateRole; words: string }> = {
  running: { role: "working", words: "Running" },
  waiting_approval: { role: "needsYou", words: "Waiting for approval" },
  idle: { role: "neutral", words: "Idle" },
  done: { role: "done", words: "Done" },
  failed: { role: "needsYou", words: "Failed" },
  capped: { role: "needsYou", words: "Stopped at budget" },
  interrupted: { role: "needsYou", words: "Interrupted" },
};

const STOP_WORDS = { end_turn: "Finished", requires_action: "Needs approval", budget_reached: "Budget reached", error: "Error" } as const;

function useNames() {
  const workflows = useList<Workflow>("/v1/workflows");
  const roles = useList<JobRole>("/v1/job-roles");
  return {
    workflow: (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? "Workflow",
    role: (id: string) => roles.data?.find((r) => r.id === id)?.name ?? "—",
  };
}

export function WorkersScreen() {
  const navigate = useNavigate();
  const { now } = useDeps();
  const q = useList<Worker>("/v1/workers");
  const n = useNames();
  return (
    <Page title="Cloud workers" subtitle="Role workflows that run in the cloud">
      <Card>
        <Load q={q}>
          {(ws) => (
            <Table caption="Cloud workers" rows={ws} rowKey={(w) => w.id}
              onOpen={(w) => void navigate({ to: "/workers/$id", params: { id: w.id } })}
              columns={[
                { key: "wf", header: "Workflow", cell: (w) => <span className="t-label">{n.workflow(w.workflowId)} <span className="ink3">v{w.version}</span></span> },
                { key: "role", header: "Job role", cell: (w) => n.role(w.jobRoleId) },
                { key: "state", header: "State", cell: (w) => <StateTag role={WORKER_STATE[w.state].role}>{WORKER_STATE[w.state].words}</StateTag> },
                { key: "schedule", header: "Schedule", cell: (w) => (w.schedule ? <><span className="mono">{w.schedule.cron}</span>{w.schedule.nextRunAt && <span className="ink3"> · next {relativeText(w.schedule.nextRunAt, now())}</span>}</> : <span className="ink3">Manual only</span>) },
                { key: "budget", header: "Budget a session", align: "end", cell: (w) => usd(w.sessionBudgetCents) },
              ]} />
          )}
        </Load>
      </Card>
      <p className="t-callout ink3">Workers read and draft. They cannot send: every send goes through approval or a pinned overnight policy.</p>
    </Page>
  );
}

export function WorkerScreen() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const navigate = useNavigate();
  const workers = useList<Worker>("/v1/workers");
  const runs = useList<WorkerRun>(`/v1/workers/${id}/runs`);
  const n = useNames();
  const w = workers.data?.find((x) => x.id === id);
  return (
    <Page title={w ? n.workflow(w.workflowId) : "Worker"} subtitle="Cloud worker">
      {w && (
        <Card>
          <dl className="kv">
            <dt>State</dt><dd><StateTag role={WORKER_STATE[w.state].role}>{WORKER_STATE[w.state].words}</StateTag></dd>
            <dt>Job role</dt><dd>{n.role(w.jobRoleId)}</dd>
            <dt>Version</dt><dd>{w.version}</dd>
            <dt>Schedule</dt><dd>{w.schedule ? <><span className="mono">{w.schedule.cron}</span> ({w.schedule.timezone})</> : "Manual only"}</dd>
            <dt>Budget a session</dt><dd>{usd(w.sessionBudgetCents)}</dd>
          </dl>
        </Card>
      )}
      <Section title="Runs">
        <Card>
          <Load q={runs}>
            {(rs) => (
              <Table caption="Runs of this worker" rows={rs} rowKey={(r) => r.id}
                onOpen={(r) => void navigate({ to: "/worker-runs/$id", params: { id: r.id } })}
                columns={[
                  { key: "started", header: "Started", cell: (r) => timeText(r.startedAt) },
                  { key: "state", header: "State", cell: (r) => <StateTag role={RUN_STATE[r.state].role}>{RUN_STATE[r.state].words}</StateTag> },
                  { key: "trigger", header: "Trigger", cell: (r) => (r.trigger === "manual" ? "Manual" : "Schedule") },
                  { key: "cost", header: "Cost", align: "end", cell: (r) => usd(r.costCents) },
                ]} />
            )}
          </Load>
        </Card>
      </Section>
    </Page>
  );
}

export function WorkerRunScreen() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const q = useGet<WorkerRun>(`/v1/worker-runs/${id}`);
  return (
    <Page title="Run" subtitle="Cloud worker run">
      <Load q={q}>
        {(r) => (
          <Card>
            <dl className="kv">
              <dt>State</dt><dd><StateTag role={RUN_STATE[r.state].role}>{RUN_STATE[r.state].words}</StateTag></dd>
              <dt>Summary</dt><dd>{r.summary ?? <span className="ink3">No summary</span>}</dd>
              <dt>Started</dt><dd>{timeText(r.startedAt)} · {r.trigger === "manual" ? "started by hand" : "on schedule"}</dd>
              <dt>Ended</dt><dd>{r.endedAt ? timeText(r.endedAt) : <span className="ink3">Still open</span>}</dd>
              <dt>Stopped because</dt><dd>{r.stopReason ? STOP_WORDS[r.stopReason] : "—"}</dd>
              <dt>Cost</dt><dd>{usd(r.costCents)}</dd>
              <dt>Batches</dt><dd>{r.batchHashes.length === 0 ? <span className="ink3">None</span> : r.batchHashes.map((h) => <span key={h} className="mono">{shortHash(h)} </span>)}</dd>
              <dt>Worker</dt><dd><Link to="/workers/$id" params={{ id: r.workerId }} className="link">Open the worker</Link></dd>
            </dl>
          </Card>
        )}
      </Load>
    </Page>
  );
}
