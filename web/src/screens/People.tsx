import { Link } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import type { Department, HoursSavedReport, Person } from "../api/types.ts";
import { isSuppressed } from "../api/types.ts";
import { Card, FeatureOffPanel, StateTag, SuppressedCell, Table, type Column } from "../design/components.tsx";
import type { StateRole } from "../design/tokens.ts";
import { hoursText, timeText } from "../lib/format.ts";
import { Load, useDeps, useFeature, useGet } from "../app/data.tsx";
import { Page, ROLE_WORDS } from "../app/page.tsx";
import { PERIOD } from "./Overview.tsx";

export const PERSON_STATE: Record<Person["state"], { role: StateRole; words: string }> = {
  active: { role: "done", words: "Active" },
  leaving: { role: "needsYou", words: "Leaving" },
  frozen: { role: "neutral", words: "Frozen" },
  departed: { role: "neutral", words: "Departed" },
};

/**
 * The directory: name, department, access role, state. A metrics column exists only while per_person_views is on and
 * effective; the rows stay in directory order either way (no ranking, ADR 0108 §6).
 */
export function PeopleScreen() {
  const { api } = useDeps();
  const q = useGet<Person[]>("/v1/people");
  const depts = useGet<Department[]>("/v1/departments");
  const ppv = useFeature("per_person_views");
  const deptName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name ?? "—";
  const metrics = useQueries({
    queries: (ppv.on ? q.data ?? [] : []).map((p) => {
      const path = `/v1/metrics/hours-saved?scope=person:${p.id}&from=${PERIOD.from}&to=${PERIOD.to}`;
      return { queryKey: [path], queryFn: () => api.get<HoursSavedReport>(path) };
    }),
  });
  const byPerson = new Map((ppv.on ? q.data ?? [] : []).map((p, i) => [p.id, metrics[i]?.data]));

  const columns: Column<Person>[] = [
    { key: "name", header: "Name", cell: (p) => <span className="t-label">{p.displayName}</span> },
    { key: "dept", header: "Department", cell: (p) => deptName(p.departmentId) },
    { key: "role", header: "Access role", cell: (p) => ROLE_WORDS[p.accessRole] },
    { key: "state", header: "State", cell: (p) => <StateTag role={PERSON_STATE[p.state].role}>{PERSON_STATE[p.state].words}{p.leavingOn ? `, ${p.leavingOn}` : ""}</StateTag> },
  ];
  if (ppv.on) {
    columns.push({
      key: "hours", header: `Own hours saved, ${PERIOD.label.toLowerCase()}`, align: "end",
      cell: (p) => {
        const r = byPerson.get(p.id);
        if (!r) return <span className="ink3">…</span>;
        return isSuppressed(r.total) ? <SuppressedCell reason={r.total.reason} /> : hoursText(r.total.seconds);
      },
    });
  }

  return (
    <Page title="People" subtitle="Directory">
      {ppv.loaded && !ppv.on && (
        <FeatureOffPanel feature="per_person_views" action={<Link to="/compliance" className="link t-callout">Compliance</Link>} />
      )}
      {ppv.on && ppv.rec && (
        <div className="feature-off" role="note" data-feature-on="per_person_views">
          <StateTag role="working">Per-person views are on</StateTag>
          <span className="t-callout ink2">
            Since {timeText(ppv.rec.effectiveAt)} for {ppv.rec.jurisdictions.join(", ")}. For process improvement only. Each person can see
            every time someone opens their numbers. Rows stay in directory order.
          </span>
        </div>
      )}
      <Card>
        <Load q={q}>
          {(ps) => <Table caption="People in the directory" rows={ps} rowKey={(p) => p.id} columns={columns} />}
        </Load>
      </Card>
    </Page>
  );
}
