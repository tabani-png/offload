import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { HoursSavedEvidence, Workflow } from "../api/types.ts";
import { Card, Chip, GRADE_WORDS, Section, Segmented, StateTag, Table } from "../design/components.tsx";
import { hoursText, minutesText, timeText } from "../lib/format.ts";
import { Load, useGet } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

const SOURCE_WORDS = {
  observed: "Observed on employees' Macs",
  user_estimate: "The owner's own estimate",
  default: "No baseline: this workflow counts 0",
} as const;

const OUTCOME_ROLE = { success: "done", failed: "needsYou", cancelled: "neutral", rejected: "neutral", capped: "needsYou" } as const;
const OUTCOME_WORDS = { success: "Succeeded", failed: "Failed", cancelled: "Cancelled", rejected: "Rejected", capped: "Stopped at budget" } as const;

export function EvidenceScreen() {
  const { id = "" } = useParams({ strict: false }) as { id?: string };
  const wq = useGet<Workflow>(`/v1/workflows/${id}`);
  const [version, setVersion] = useState<number | null>(null);
  useEffect(() => {
    if (wq.data && version === null) setVersion(wq.data.latestVersion);
  }, [wq.data, version]);
  const ev = useGet<HoursSavedEvidence>(version ? `/v1/metrics/hours-saved/evidence?workflowId=${id}&version=${version}` : null);
  const w = wq.data;

  return (
    <Page title={w ? `Evidence: ${w.name}` : "Evidence"} subtitle="How the hours were worked out">
      {w && (
        <div className="spread">
          <Segmented<string> label="Version" value={String(version)} onChange={(x) => setVersion(Number(x))}
            options={w.versions.map((x) => ({ value: String(x.version), label: `v${x.version}` }))} />
          <Link to="/workflows/$id" params={{ id }} className="link t-callout">Workflow details</Link>
        </div>
      )}
      <Load q={ev} label="Loading evidence">
        {(e) => {
          const b = e.baseline;
          const success = e.runs.filter((r) => r.outcome === "success");
          const saved = e.runs.reduce((a, r) => a + r.savedSeconds, 0);
          return (
            <>
              <Section title="Baseline" aside={`Computation ${e.computation}`}>
                <Card>
                  <div className="spread">
                    <div className="stat">
                      <span className="stat-value">{minutesText(b.medianSeconds)} per item</span>
                      <span className="t-callout ink2">{SOURCE_WORDS[b.source]}{b.n > 0 ? `, ${b.n} samples` : ""}</span>
                    </div>
                    {b.grade ? <Chip>Grade {b.grade} · {b.grade === "C" ? "estimated" : "measured"}</Chip> : <Chip>No grade</Chip>}
                  </div>
                  {b.grade && <p className="t-callout ink3">{GRADE_WORDS[b.grade]}.{b.n > 0 && ` Middle half of samples: ${minutesText(b.q1)} to ${minutesText(b.q3)}.`}</p>}
                  {b.samples.length > 0 && (
                    <Table caption="Baseline samples" rows={b.samples} rowKey={(s) => s.instanceRef}
                      columns={[
                        { key: "ref", header: "Instance", cell: (s) => <span className="mono">{s.instanceRef}</span> },
                        { key: "day", header: "Day", cell: (s) => s.day },
                        { key: "active", header: "Active time", align: "end", cell: (s) => minutesText(s.activeSeconds) },
                      ]} />
                  )}
                  <p className="t-footnote ink3">Instance references resolve to the actual work only on the employee's own Mac. No content reaches the company.</p>
                </Card>
              </Section>

              <Section title="Runs" aside={`${success.length} successful of ${e.runs.length} · ${hoursText(saved)} saved in this list`}>
                <Card>
                  <p className="t-callout ink2">Saved per run = baseline × items sent − review and fix time, never below 0. Runs without a review count 0 until reviewed.</p>
                  <Table caption="Runs behind the hours" rows={e.runs} rowKey={(r) => r.runId}
                    columns={[
                      { key: "ended", header: "Ended", cell: (r) => timeText(r.endedAt) },
                      { key: "outcome", header: "Outcome", cell: (r) => <StateTag role={OUTCOME_ROLE[r.outcome]}>{OUTCOME_WORDS[r.outcome]}</StateTag> },
                      { key: "items", header: "Items sent", align: "end", cell: (r) => r.itemsSucceeded },
                      { key: "baseline", header: "Baseline", align: "end", cell: (r) => minutesText(r.baselineSeconds) },
                      { key: "residual", header: "Review time", align: "end", cell: (r) => (r.outcome !== "success" ? <span className="ink3">—</span> : r.residualSeconds === null ? <span className="ink3">Not reviewed yet</span> : minutesText(r.residualSeconds)) },
                      { key: "saved", header: "Saved", align: "end", cell: (r) => <span className="t-label ink1">{minutesText(r.savedSeconds)}</span> },
                      { key: "note", header: "Note", cell: (r) => (r.outcome !== "success" ? "Counts 0: not a successful run" : r.note === "policy_committed" ? "Sent under an overnight policy" : r.note === "not_reviewed_yet" ? "Counts 0 for now" : "") },
                    ]} />
                </Card>
              </Section>
            </>
          );
        }}
      </Load>
    </Page>
  );
}
