import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { errorWords } from "../api/client.ts";
import type { Department, HoursSavedReport, Person, PersonListItem } from "../api/types.ts";
import { isFullPerson, isSuppressed } from "../api/types.ts";
import { Button, Card, FeatureOffPanel, StateTag, SuppressedCell, Table, type Column } from "../design/components.tsx";
import type { StateRole } from "../design/tokens.ts";
import { hoursText, timeText } from "../lib/format.ts";
import { Load, periodPath, useFeature, useGet, useList, usePeriod } from "../app/data.tsx";
import { Page, ROLE_WORDS } from "../app/page.tsx";
import type { Period } from "../lib/period.ts";

export const PERSON_STATE: Record<Person["state"], { role: StateRole; words: string }> = {
  active: { role: "done", words: "Active" },
  leaving: { role: "needsYou", words: "Leaving" },
  frozen: { role: "neutral", words: "Frozen" },
  departed: { role: "neutral", words: "Departed" },
};

/** One person's own hours, read only once someone asks for them: each read is an audit event the person can see. */
function PersonHours(props: { person: PersonListItem; period: Period | null }) {
  const [open, setOpen] = useState(false);
  const r = useGet<HoursSavedReport>(open ? periodPath(`/v1/metrics/hours-saved?scope=person:${props.person.id}`, props.period) : null);
  if (!open) {
    return <Button quiet onClick={() => setOpen(true)} aria-label={`Show hours for ${props.person.displayName}`}>Show hours</Button>;
  }
  if (r.isError) return <span className="t-callout ink2" role="alert">{errorWords(r.error)}</span>;
  if (!r.data) return <span className="t-callout ink3">Loading</span>;
  return isSuppressed(r.data.total) ? <SuppressedCell reason={r.data.total.reason} /> : <>{hoursText(r.data.total.seconds)}</>;
}

/**
 * The directory: name, department, access role, state. A metrics column exists only while per_person_views is on and
 * effective, and a person's numbers are read only on an explicit open, only where the feature covers their
 * jurisdiction (ADR 0111 §5). The rows stay in directory order either way (no ranking, ADR 0108 §6).
 */
export function PeopleScreen() {
  const q = useList<PersonListItem>("/v1/people");
  const period = usePeriod();
  const depts = useList<Department>("/v1/departments");
  const ppv = useFeature("per_person_views");
  const deptName = (id: string | null) => depts.data?.find((d) => d.id === id)?.name ?? "—";

  // A dept lead gets summaries (no access role, jurisdiction or leaving date): those cells say nothing rather than guess.
  const columns: Column<PersonListItem>[] = [
    { key: "name", header: "Name", cell: (p) => <span className="t-label">{p.displayName}</span> },
    { key: "dept", header: "Department", cell: (p) => deptName(p.departmentId) },
    { key: "role", header: "Access role", cell: (p) => (isFullPerson(p) ? ROLE_WORDS[p.accessRole] : <span className="ink3">—</span>) },
    { key: "state", header: "State", cell: (p) => <StateTag role={PERSON_STATE[p.state].role}>{PERSON_STATE[p.state].words}{isFullPerson(p) && p.leavingOn ? `, ${p.leavingOn}` : ""}</StateTag> },
  ];
  if (ppv.on) {
    columns.push({
      key: "hours", header: `Own hours saved, ${(period?.label ?? "this month").toLowerCase()}`, align: "end",
      // Without a jurisdiction (summary) the server's gate decides for the subject (ADR 0111 §5).
      cell: (p) => !isFullPerson(p) || ppv.rec?.jurisdictions.includes(p.jurisdiction)
        ? <PersonHours person={p} period={period} />
        : <span className="suppressed t-callout ink3" data-suppressed="jurisdiction">Off in {p.jurisdiction}</span>,
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
            every time someone opens their numbers, so numbers load only when you open one person. Rows stay in directory order.
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
