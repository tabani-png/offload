import { Link, useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import type { AdoptionReport, Batch, HoursSavedReport, HoursValue, Suppressed, Tenant } from "../api/types.ts";
import { isSuppressed } from "../api/types.ts";
import {
  Bars, Button, Card, Chip, GradeSplit, Ring, Row, Section, StatHero, StateTag, SuppressedCell, Table,
} from "../design/components.tsx";
import { hoursText, minutesText, monthName, pct, share } from "../lib/format.ts";
import { Load, useDeps, useGet } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

export const PERIOD = { from: "2026-10-01", to: "2026-10-26", label: "October so far" };
export const TREND_MONTHS = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];

const nextMonth = (m: string) => {
  const [y, mo] = m.split("-").map(Number) as [number, number];
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};

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

export function GradeCell(props: { value: HoursValue | Suppressed }) {
  return isSuppressed(props.value) ? <span className="ink3">—</span> : <GradeSplit compact byGrade={props.value.byGrade} />;
}

function Trend() {
  const { api } = useDeps();
  const qs = useQueries({
    queries: TREND_MONTHS.map((m) => {
      const path = `/v1/metrics/hours-saved?scope=company&from=${m}-01&to=${m === "2026-10" ? PERIOD.to : `${nextMonth(m)}-01`}`;
      return { queryKey: [path], queryFn: () => api.get<HoursSavedReport>(path) };
    }),
  });
  if (qs.some((q) => q.data === undefined)) return <div className="t-callout ink3" role="status">Loading</div>;
  const data = qs.map((q, i) => {
    const t = q.data!.total;
    return { label: monthName(TREND_MONTHS[i]!, true), value: isSuppressed(t) ? 0 : t.seconds, partial: !q.data!.final };
  });
  return (
    <Bars data={data} label={`Hours saved per month: ${data.map((d) => `${d.label} ${hoursText(d.value)}`).join(", ")}`} />
  );
}

export function OverviewScreen() {
  const navigate = useNavigate();
  const tenant = useGet<Tenant>("/v1/tenant");
  const report = useGet<HoursSavedReport>(`/v1/metrics/hours-saved?scope=company&from=${PERIOD.from}&to=${PERIOD.to}`);
  const adoptionQ = useGet<AdoptionReport>(`/v1/metrics/adoption?scope=company&from=${PERIOD.from}&to=${PERIOD.to}`);
  const pending = useGet<Batch[]>("/v1/batches?state=pending");
  const waiting = pending.data?.length ?? 0;

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
              <Section title="Hours saved" aside={`${PERIOD.label}, ${r.period.timezone}`}>
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
                <Card title="Trend" aside={<span className="t-callout ink3">Last 6 months · October is partial</span>}>
                  <Trend />
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
                      { key: "hours", header: "Hours saved", align: "end", cell: (c) => <HoursCell value={c.value} /> },
                      { key: "grade", header: "Confidence A · B · C", cell: (c) => <GradeCell value={c.value} /> },
                      { key: "people", header: "People using", align: "end", cell: (c) => (isSuppressed(c.value) ? <span className="ink3">—</span> : c.value.people) },
                      { key: "overnight", header: "Overnight", align: "end", cell: (c) => (isSuppressed(c.value) ? <span className="ink3">—</span> : pct(share(c.value.overnightSeconds, c.value.seconds))) },
                    ]}
                  />
                  {r.children.some((c) => isSuppressed(c.value)) && (
                    <p className="t-callout ink3">
                      Departments with fewer than 5 people are hidden, and so is one more when only one would be, so no
                      small group can be worked out from the total. Their hours still count in the company total.
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
                        title={<Link to="/workflows/$id" params={{ id: w.workflowId }} className="link">{w.name}</Link>}
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
            </>
          );
        }}
      </Load>
    </Page>
  );
}

function Quality(props: { report: HoursSavedReport; adoption?: AdoptionReport }) {
  const a = props.adoption?.value;
  return (
    <Card title="Quality">
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
