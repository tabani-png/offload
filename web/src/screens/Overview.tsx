import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import type { AdoptionReport, Batch, HoursSavedReport, HoursValue, Suppressed, Tenant, Workflow, WorkingTimeReport } from "../api/types.ts";
import { isSuppressed } from "../api/types.ts";
import {
  Bars, Button, Card, Chip, GradeSplit, Ring, Row, Section, StatHero, StateTag, SuppressedCell, Table,
} from "../design/components.tsx";
import { hoursText, minutesText, monthName, pct, share } from "../lib/format.ts";
import { Load, periodPath, useDeps, useFeature, useGet, useList, usePeriod } from "../app/data.tsx";
import { Page } from "../app/page.tsx";
import type { Period } from "../lib/period.ts";

/** "Measured" when every second is grade A/B; otherwise say how much is estimated. */
export function confidenceChip(v: HoursValue) {
  const est = share(v.byGrade.C, v.seconds);
  if (v.seconds === 0) return <Chip>No runs yet</Chip>;
  return est === 0 ? <Chip>Measured</Chip> : <Chip>{pct(1 - est)} measured, {pct(est)} estimated</Chip>;
}

export function finalChip(r: HoursSavedReport) {
  return r.final
    ? <StateTag role="done">Final</StateTag>
    : <StateTag role="working">Provisional until the nightly recompute matches</StateTag>;
}

export function HoursCell(props: { value: HoursValue | Suppressed }) {
  return isSuppressed(props.value) ? <SuppressedCell reason={props.value.reason} /> : <span className="t-label ink1">{hoursText(props.value.seconds)}</span>;
}

/** One child row's hours (a department or job role): hidden cells use the words that cover both floor cases. */
export function ChildHoursCell(props: { child: HoursSavedReport["children"][number] }) {
  const { value } = props.child;
  return isSuppressed(value) ? <SuppressedCell reason={value.reason} tree /> : <HoursCell value={value} />;
}

export function GradeCell(props: { value: HoursValue | Suppressed }) {
  return isSuppressed(props.value) ? <span className="ink3">—</span> : <GradeSplit compact byGrade={props.value.byGrade} />;
}

function Trend(props: { period: Period }) {
  const { api } = useDeps();
  const qs = useQueries({
    queries: props.period.trend.map((m) => {
      const path = `/v1/metrics/hours-saved?scope=company&from=${m.from}&to=${m.to}`;
      return { queryKey: [path], queryFn: () => api.get<HoursSavedReport>(path) };
    }),
  });
  if (qs.some((q) => q.isError)) return <div className="t-callout ink3" role="note">The monthly trend could not be loaded. Try again shortly.</div>;
  if (qs.some((q) => q.data === undefined)) return <div className="t-callout ink3" role="status">Loading</div>;
  const data = qs.map((q, i) => {
    const t = q.data!.total;
    // A suppressed month is hidden, not zero (ADR 0005): the bar shows a dash and the label says why.
    return { label: monthName(props.period.trend[i]!.month, true), value: isSuppressed(t) ? null : t.seconds, partial: !q.data!.final };
  });
  const words = (v: number | null) => (v === null ? "hidden, fewer than 5 people" : hoursText(v));
  return (
    <>
      <Bars data={data} label={`Hours saved per month: ${data.map((d) => `${d.label} ${words(d.value)}`).join(", ")}`} />
      {data.some((d) => d.value === null) && (
        <p className="t-callout ink3">A dashed month had fewer than 5 people with data, so its total is not shown.</p>
      )}
    </>
  );
}

export function OverviewScreen() {
  const navigate = useNavigate();
  const tenant = useGet<Tenant>("/v1/tenant");
  const period = usePeriod();
  const report = useGet<HoursSavedReport>(periodPath("/v1/metrics/hours-saved?scope=company", period));
  const adoptionQ = useGet<AdoptionReport>(periodPath("/v1/metrics/adoption?scope=company", period));
  const pending = useList<Batch>("/v1/batches?state=pending");
  const waiting = pending.data?.length ?? 0;
  // hs-1 reports carry workflow ids; their names live in the registry.
  const workflows = useList<Workflow>("/v1/workflows");
  const wfName = (id: string, fallback: string) => workflows.data?.find((w) => w.id === id)?.name ?? (workflows.isError ? fallback : "…");

  return (
    <Page
      title={tenant.data?.name ?? "Overview"}
      subtitle="Overview"
      actions={waiting > 0 && (
        <Button primary keycap="3" onClick={() => void navigate({ to: "/approvals" })}>
          Review {waiting} waiting {waiting === 1 ? "batch" : "batches"}
        </Button>
      )}
    >
      <Load q={report} label="Loading hours saved">
        {(r) => {
          const t = r.total;
          return (
            <>
              <Section title="Hours saved" aside={`${period!.label}, ${r.period.timezone}`}>
                <Card className="card-hero">
                  {isSuppressed(t) ? (
                    <SuppressedCell reason={t.reason} />
                  ) : (
                    <div className="hero-grid">
                      <StatHero
                        value={hoursText(t.seconds)}
                        chip={confidenceChip(t)}
                        label={`Saved across ${t.people} people and ${t.runs.success} successful runs.`}
                        detail={<span className="inline">{finalChip(r)}<span>Median manual time minus measured review time, successful runs only (hs-1).</span></span>}
                      />
                      <GradeSplit byGrade={t.byGrade} />
                    </div>
                  )}
                </Card>
              </Section>

              <div className="grid-2">
                <Card title="Trend" aside={<span className="t-callout ink3">Last 6 months · {monthName(period!.month)} is partial</span>}>
                  <Trend period={period!} />
                </Card>
                {!isSuppressed(t) && (
                  <Card title="Overnight and cloud" aside={<span className="t-callout ink3">Share of hours saved</span>}>
                    <div className="inline" style={{ gap: 32 }}>
                      <div className="inline">
                        <Ring value={share(t.overnightSeconds, t.seconds)} label={`Overnight share ${pct(share(t.overnightSeconds, t.seconds))}`}
                          center={<span className="t-calloutEmphasis ink1">{pct(share(t.overnightSeconds, t.seconds))}</span>} />
                        <div className="stat"><span className="t-label ink1">Overnight</span><span className="t-callout ink2">{hoursText(t.overnightSeconds)} from runs outside working hours</span></div>
                      </div>
                      <div className="inline">
                        <Ring value={share(t.byRuntime.cloud, t.seconds)} label={`Cloud share ${pct(share(t.byRuntime.cloud, t.seconds))}`}
                          center={<span className="t-calloutEmphasis ink1">{pct(share(t.byRuntime.cloud, t.seconds))}</span>} />
                        <div className="stat"><span className="t-label ink1">Cloud workers</span><span className="t-callout ink2">{hoursText(t.byRuntime.cloud)} cloud, {hoursText(t.byRuntime.mac)} on Macs</span></div>
                      </div>
                    </div>
                  </Card>
                )}
              </div>

              <Section title="By department" aside="Groups under 5 people are not shown">
                <Card>
                  <Table
                    caption="Hours saved by department"
                    rows={r.children}
                    rowKey={(c) => c.scope.id ?? c.label}
                    onOpen={(c) => void navigate({ to: "/departments/$id", params: { id: c.scope.id! } })}
                    columns={[
                      { key: "name", header: "Department", cell: (c) => <span className="t-label ink1">{c.label}</span> },
                      { key: "hours", header: "Hours saved", align: "end", cell: (c) => <ChildHoursCell child={c} /> },
                      { key: "grade", header: "Confidence A · B · C", cell: (c) => <GradeCell value={c.value} /> },
                      { key: "people", header: "People using", align: "end", cell: (c) => (isSuppressed(c.value) ? <span className="ink3">—</span> : c.value.people) },
                      { key: "overnight", header: "Overnight", align: "end", cell: (c) => (isSuppressed(c.value) ? <span className="ink3">—</span> : pct(share(c.value.overnightSeconds, c.value.seconds))) },
                    ]}
                  />
                  {r.children.some((c) => isSuppressed(c.value)) && (
                    <p className="t-callout ink3">
                      Departments where fewer than 5 people have data in this period are hidden, and so is one more when
                      a small group could otherwise be worked out from the total. Their hours still count in the company
                      total.
                    </p>
                  )}
                </Card>
              </Section>

              <div className="grid-2">
                <Card title="Top workflows" aside={<span className="t-callout ink3">Each links to its evidence</span>}>
                  <div>
                    {r.topWorkflows.length === 0 && <p className="t-callout ink3">No workflow has saved time in this period yet.</p>}
                    {r.topWorkflows.map((w) => (
                      <Row key={w.workflowId}
                        title={<Link to="/workflows/$id" params={{ id: w.workflowId }} className="link">{wfName(w.workflowId, w.name)}</Link>}
                        detail={`Grade ${w.grade} · ${w.grade === "C" ? "estimated" : "measured"}`}
                        trailing={<>
                          <span className="t-label ink1">{hoursText(w.seconds)}</span>
                          <Link to="/workflows/$id/evidence" params={{ id: w.workflowId }} className="link t-callout">Evidence</Link>
                        </>}
                      />
                    ))}
                  </div>
                </Card>
                <Quality report={r} adoption={adoptionQ.data} />
              </div>

              <CompanyWorkingTime period={period!} />
            </>
          );
        }}
      </Load>
    </Page>
  );
}

/**
 * Company working time: team medians only, under the group floor like every aggregate, no list of people (ADR 0108 §6).
 * Absent while the feature is off or still in its notice period; the department page carries the off notice.
 */
function CompanyWorkingTime(props: { period: Period }) {
  const wt = useFeature("working_time");
  const q = useGet<WorkingTimeReport>(wt.on ? periodPath("/v1/metrics/working-time?scope=company", props.period) : null);
  if (!wt.on) return null;
  return (
    <div data-section="working-time">
      <Section title="Working time" aside={`${props.period.label} · team medians only`}>
        <Card>
          <Load q={q}>
            {(w) => isSuppressed(w.value) ? <SuppressedCell reason={w.value.reason} /> : (
              <div className="stack">
                <div className="grid-3">
                  <div className="stat"><span className="stat-value">{minutesText(w.value.medianActiveMinutesPerDay * 60)}</span><span className="t-callout ink2">median active time a day</span></div>
                  <div className="stat"><span className="stat-value">{minutesText(w.value.p25 * 60)} – {minutesText(w.value.p75 * 60)}</span><span className="t-callout ink2">middle half of the company</span></div>
                  <div className="stat"><span className="stat-value">{w.value.people} people</span><span className="t-callout ink2">in the group</span></div>
                </div>
                <p className="t-callout ink3">Nobody is listed or ranked. For process improvement, not for pay or discipline.</p>
              </div>
            )}
          </Load>
        </Card>
      </Section>
    </div>
  );
}

function Quality(props: { report: HoursSavedReport; adoption?: AdoptionReport }) {
  const a = props.adoption?.value;
  return (
    <Card title="Quality">
      {a && isSuppressed(a) && (
        <p className="t-callout ink3">
          <SuppressedCell reason={a.reason} tree />. Success, rejection and review-time figures are shown only when each
          comes from at least 5 people.
        </p>
      )}
      {a && !isSuppressed(a) && (
        <div className="grid-2">
          <div className="stat"><span className="stat-value">{pct(a.successRate)}</span><span className="t-callout ink2">of runs succeed</span></div>
          <div className="stat"><span className="stat-value">{pct(a.rejectionRate)}</span><span className="t-callout ink2">of batches rejected at review</span></div>
          <div className="stat"><span className="stat-value">{minutesText(a.medianResidualSeconds)}</span><span className="t-callout ink2">median review and fix time per run</span></div>
          <div className="stat"><span className="stat-value">{a.peopleWithActiveWorkflow} of {a.peopleTotal}</span><span className="t-callout ink2">people use a workflow</span></div>
        </div>
      )}
      {props.report.anomalies.length > 0 && (
        <div>
          {props.report.anomalies.map((x, i) => (
            <Row key={i} state="needsYou" stateLabel="Needs a look" title={ANOMALY_WORDS[x.code]} detail={x.detail}
              trailing={x.workflowId && <Link to="/workflows/$id/evidence" params={{ id: x.workflowId }} className="link t-callout">Evidence</Link>} />
          ))}
        </div>
      )}
    </Card>
  );
}

export const ANOMALY_WORDS = {
  residual_zero_share: "Review time is almost always zero",
  small_baseline: "Small baseline",
  outcome_disagreement: "Mac and broker disagree on outcomes",
} as const;
