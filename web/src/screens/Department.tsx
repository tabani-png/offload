import { Link, useParams } from "@tanstack/react-router";
import type { AdoptionReport, Department, HoursSavedReport, Person, Workflow, WorkingTimeReport } from "../api/types.ts";
import { isSuppressed } from "../api/types.ts";
import { Card, FeatureOffPanel, GradeSplit, Row, Section, StatHero, SuppressedCell, Table } from "../design/components.tsx";
import { hoursText, minutesText, pct } from "../lib/format.ts";
import { Load, useFeature, useGet } from "../app/data.tsx";
import { Page } from "../app/page.tsx";
import { GradeCell, HoursCell, PERIOD, confidenceChip, finalChip } from "./Overview.tsx";

export function DepartmentScreen() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const depts = useGet<Department[]>("/v1/departments");
  const dept = depts.data?.find((d) => d.id === id);
  const report = useGet<HoursSavedReport>(`/v1/metrics/hours-saved?scope=department:${id}&from=${PERIOD.from}&to=${PERIOD.to}`);
  const adoption = useGet<AdoptionReport>(`/v1/metrics/adoption?scope=department:${id}&from=${PERIOD.from}&to=${PERIOD.to}`);
  const workflows = useGet<Workflow[]>(`/v1/workflows?departmentId=${id}`);
  const people = useGet<Person[]>("/v1/people");
  const headcount = people.data?.filter((p) => p.departmentId === id && p.state !== "departed").length;
  // Under the floor, run-level evidence would describe fewer than 5 people, so the link is not offered here.
  const floor = report.data !== undefined && isSuppressed(report.data.total);
  const wt = useFeature("working_time");
  const wtReport = useGet<WorkingTimeReport>(wt.on ? `/v1/metrics/working-time?scope=department:${id}&from=${PERIOD.from}&to=${PERIOD.to}` : null);

  return (
    <Page title={dept?.name ?? "Department"} subtitle="Department">
      <Load q={report} label="Loading hours saved">
        {(r) => (
          <Section title="Hours saved" aside={`${PERIOD.label}${headcount !== undefined ? ` · ${headcount} people` : ""}`}>
            <Card className="card-hero">
              {isSuppressed(r.total) ? (
                <div className="stack">
                  <SuppressedCell reason={r.total.reason} />
                  <p className="t-body ink2">
                    Fewer than 5 people work in {dept?.name ?? "this department"}, so its numbers are not shown on their own.
                    Its hours still count in the company total.
                  </p>
                </div>
              ) : (
                <div className="hero-grid">
                  <StatHero value={hoursText(r.total.seconds)} chip={confidenceChip(r.total)}
                    label={`${r.total.runs.success} successful runs by ${r.total.people} people.`} detail={finalChip(r)} />
                  <GradeSplit byGrade={r.total.byGrade} />
                </div>
              )}
            </Card>
          </Section>
        )}
      </Load>

      {report.data && !isSuppressed(report.data.total) && (
        <Section title="By job role" aside="Groups under 5 people are not shown">
          <Card>
            <Table
              caption="Hours saved by job role"
              rows={report.data.children}
              rowKey={(c) => c.scope.id ?? c.label}
              columns={[
                { key: "role", header: "Job role", cell: (c) => <span className="t-label ink1">{c.label}</span> },
                { key: "hours", header: "Hours saved", align: "end", cell: (c) => <HoursCell value={c.value} /> },
                { key: "grade", header: "Confidence A · B · C", cell: (c) => <GradeCell value={c.value} /> },
                { key: "runs", header: "Successful runs", align: "end", cell: (c) => (isSuppressed(c.value) ? <span className="ink3">—</span> : c.value.runs.success) },
              ]}
            />
          </Card>
        </Section>
      )}

      <div className="grid-2">
        <Card title="Workflows">
          <Load q={workflows}>
            {(ws) => (
              <div>
                {ws.length === 0 && <p className="t-callout ink3">No workflows belong to this department yet.</p>}
                {ws.map((w) => (
                  <Row key={w.id} state={w.state === "role" ? "done" : "neutral"} stateLabel={w.state === "role" ? "In use" : "Not in use"}
                    title={<Link to="/workflows/$id" params={{ id: w.id }} className="link">{w.name}</Link>}
                    detail={`Version ${w.latestVersion}${w.baselineGrade ? ` · grade ${w.baselineGrade}` : ""}`}
                    trailing={w.state === "role" && !floor && <Link to="/workflows/$id/evidence" params={{ id: w.id }} className="link t-callout">Evidence</Link>} />
                ))}
              </div>
            )}
          </Load>
        </Card>
        <Card title="Adoption">
          <Load q={adoption}>
            {(a) => isSuppressed(a.value) ? <SuppressedCell reason={a.value.reason} /> : (
              <div className="grid-2">
                <div className="stat"><span className="stat-value">{a.value.peopleWithActiveWorkflow} of {a.value.peopleTotal}</span><span className="t-callout ink2">people use a workflow</span></div>
                <div className="stat"><span className="stat-value">{pct(a.value.successRate)}</span><span className="t-callout ink2">of runs succeed</span></div>
                <div className="stat"><span className="stat-value">{a.value.runsPerWeek}</span><span className="t-callout ink2">runs a week</span></div>
                <div className="stat"><span className="stat-value">{minutesText(a.value.medianResidualSeconds)}</span><span className="t-callout ink2">median review time</span></div>
              </div>
            )}
          </Load>
        </Card>
      </div>

      <Section title="Working time">
        {!wt.on ? (
          <FeatureOffPanel feature="working_time" action={<Link to="/compliance" className="link t-callout">Compliance</Link>} />
        ) : (
          <Card>
            <Load q={wtReport}>
              {(w) => isSuppressed(w.value) ? <SuppressedCell reason={w.value.reason} /> : (
                <div className="stack">
                  <div className="grid-3">
                    <div className="stat"><span className="stat-value">{minutesText(w.value.medianActiveMinutesPerDay * 60)}</span><span className="t-callout ink2">median active time a day</span></div>
                    <div className="stat"><span className="stat-value">{minutesText(w.value.p25 * 60)} – {minutesText(w.value.p75 * 60)}</span><span className="t-callout ink2">middle half of the team</span></div>
                    <div className="stat"><span className="stat-value">{w.value.people}</span><span className="t-callout ink2">people in the group</span></div>
                  </div>
                  <p className="t-callout ink3">Team medians only. Nobody is listed or ranked. For process improvement, not for pay or discipline.</p>
                </div>
              )}
            </Load>
          </Card>
        )}
      </Section>
    </Page>
  );
}
