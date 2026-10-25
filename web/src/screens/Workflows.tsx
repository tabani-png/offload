import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { Department, JobRole, Workflow } from "../api/types.ts";
import { Card, Segmented, StateTag, Table } from "../design/components.tsx";
import type { StateRole } from "../design/tokens.ts";
import { Load, useGet } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

export const WORKFLOW_STATE: Record<Workflow["state"], { role: StateRole; words: string }> = {
  proposed: { role: "needsYou", words: "Proposed, needs review" },
  role: { role: "done", words: "Role workflow" },
  retired: { role: "neutral", words: "Retired" },
  declined: { role: "neutral", words: "Declined" },
};

type Filter = "all" | Workflow["state"];

export function WorkflowsScreen() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("all");
  const q = useGet<Workflow[]>(filter === "all" ? "/v1/workflows" : `/v1/workflows?state=${filter}`);
  const roles = useGet<JobRole[]>("/v1/job-roles");
  const depts = useGet<Department[]>("/v1/departments");
  const roleName = (id: string | null) => roles.data?.find((r) => r.id === id)?.name ?? "—";
  const deptName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name ?? "—";

  return (
    <Page title="Workflows" subtitle="Registry">
      <div className="spread">
        <Segmented<Filter> label="Show" value={filter} onChange={setFilter} options={[
          { value: "all", label: "All" }, { value: "proposed", label: "Proposed" }, { value: "role", label: "Role" },
          { value: "retired", label: "Retired" }, { value: "declined", label: "Declined" },
        ]} />
        <span className="t-callout ink3">Proposals arrive when someone shares a workflow from their Mac.</span>
      </div>
      <Card>
        <Load q={q}>
          {(ws) => (
            <Table
              caption="Workflows in the registry"
              rows={ws}
              rowKey={(w) => w.id}
              onOpen={(w) => void navigate({ to: "/workflows/$id", params: { id: w.id } })}
              empty="No workflows in this state."
              columns={[
                { key: "name", header: "Workflow", cell: (w) => <span className="t-label">{w.name}</span> },
                { key: "state", header: "State", cell: (w) => <StateTag role={WORKFLOW_STATE[w.state].role}>{WORKFLOW_STATE[w.state].words}</StateTag> },
                { key: "role", header: "Job role", cell: (w) => roleName(w.jobRoleId) },
                { key: "dept", header: "Department", cell: (w) => deptName(w.departmentId) },
                { key: "version", header: "Version", align: "end", cell: (w) => w.latestVersion },
                { key: "grade", header: "Baseline", align: "end", cell: (w) => (w.baselineGrade ? `Grade ${w.baselineGrade}` : <span className="ink3">None yet</span>) },
              ]}
            />
          )}
        </Load>
      </Card>
    </Page>
  );
}
