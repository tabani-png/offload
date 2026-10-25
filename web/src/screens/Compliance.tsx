import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type {
  AuditEvent, ChainVerify, FeatureEnableRequest, FeatureEnablement, LegalBasis, Notice, NoticeAckRow, Person, SensitiveFeature,
} from "../api/types.ts";
import { Button, Card, Chip, ErrorNote, Field, Row, Section, Sheet, StateTag, Table } from "../design/components.tsx";
import { timeText } from "../lib/format.ts";
import { Load, featureState, useDeps, useList, useSession } from "../app/data.tsx";
import { Page, ROLE_WORDS } from "../app/page.tsx";

export const FEATURE_NAMES: Record<SensitiveFeature, string> = {
  per_person_views: "Per-person views",
  working_time: "Working time",
};

const FEATURE_WHAT: Record<SensitiveFeature, string> = {
  per_person_views: "Owners and admins can open one person's own hours saved per workflow. Nobody is ranked.",
  working_time: "Each Mac sends active minutes per day. The dashboard shows team medians only.",
};

const LEGAL_BASIS: Record<LegalBasis, string> = {
  legitimate_interest: "Legitimate interest",
  contract: "Contract",
  consent: "Consent",
  works_agreement: "Works agreement",
  other: "Other",
};

export interface EnableForm {
  jurisdictions: string[];
  legalBasis: LegalBasis;
  completedOn: string;
  documentName: string;
  documentHash: string;
  signerName: string;
  signerTitle: string;
  noticeVersionId: string;
  noticePeriodDays: string;
  worksName: string;
  worksHash: string;
  quebecAck: boolean;
  attest: boolean;
}

const SHA = /^[0-9a-f]{64}$/;
const NOTICE_REQUIRED = ["US-NY", "DE", "US-CT"];

/** Client-side checks that mirror ADR 0108 §2. The server checks again; this only makes the form say why early. */
export function validateEnable(f: EnableForm): Partial<Record<keyof EnableForm, string>> {
  const e: Partial<Record<keyof EnableForm, string>> = {};
  if (f.jurisdictions.length === 0) e.jurisdictions = "Choose at least one place.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.completedOn)) e.completedOn = "Enter the date the DPIA was completed.";
  if (!f.documentName.trim()) e.documentName = "Name the signed DPIA document.";
  if (!SHA.test(f.documentHash)) e.documentHash = "Paste the document's SHA-256: 64 characters, 0-9 and a-f.";
  if (!f.signerName.trim()) e.signerName = "Who signed it?";
  if (!f.signerTitle.trim()) e.signerTitle = "Their title.";
  if (!f.noticeVersionId) e.noticeVersionId = "Choose the notice employees will see.";
  const days = Number(f.noticePeriodDays);
  const min = f.jurisdictions.some((j) => NOTICE_REQUIRED.includes(j)) ? 1 : 0;
  if (!Number.isInteger(days) || days < min || days > 90) e.noticePeriodDays = min === 1 ? "New York, Connecticut and Germany need at least 1 day of notice (90 at most)." : "Between 0 and 90 days.";
  if (f.jurisdictions.includes("DE") && (!f.worksName.trim() || !SHA.test(f.worksHash))) e.worksName = "Germany needs the signed works agreement: its name and SHA-256.";
  if (f.jurisdictions.includes("CA-QC") && !f.quebecAck) e.quebecAck = "Quebec needs the notice to describe how this is turned on (s. 8.1).";
  if (!f.attest) e.attest = "Confirm the attestation.";
  return e;
}

export function toEnableRequest(feature: SensitiveFeature, f: EnableForm): FeatureEnableRequest {
  return {
    feature, jurisdictions: f.jurisdictions, legalBasis: f.legalBasis,
    dpiaAttestation: { completedOn: f.completedOn, documentHash: f.documentHash, documentName: f.documentName.trim(), signerName: f.signerName.trim(), signerTitle: f.signerTitle.trim() },
    noticeVersionId: f.noticeVersionId, noticePeriodDays: Number(f.noticePeriodDays),
    worksAgreementRef: f.jurisdictions.includes("DE") ? { documentHash: f.worksHash, documentName: f.worksName.trim(), allowedViews: [] } : null,
    quebecActivationAck: f.jurisdictions.includes("CA-QC") && f.quebecAck, purposeLock: "process_improvement",
  };
}

export function ComplianceScreen() {
  const { now } = useDeps();
  const session = useSession();
  const features = useList<FeatureEnablement>("/v1/compliance/features");
  const notices = useList<Notice>("/v1/compliance/notices");
  const audit = useList<AuditEvent>("/v1/audit-log");
  const people = useList<Person>("/v1/people");
  const [enabling, setEnabling] = useState<SensitiveFeature | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const isOwner = session.data?.person.accessRole === "owner";
  const name = (id: string | null) => people.data?.find((p) => p.id === id)?.displayName ?? "System";

  return (
    <Page title="Compliance" subtitle="Sensitive features, notices and the audit log">
      <Section title="Sensitive features" aside="Off by default">
        <Card>
          <Load q={features}>
            {(fs) => (
              <div>
                {(["per_person_views", "working_time"] as const).map((f) => {
                  const st = featureState(fs, f, now());
                  return (
                    <Row key={f}
                      state={st.on ? "done" : st.scheduled ? "working" : "neutral"}
                      stateLabel={st.on ? "On" : st.scheduled ? "Scheduled" : "Off"}
                      title={FEATURE_NAMES[f]}
                      detail={<>
                        {st.on && st.rec && <>On for {st.rec.jurisdictions.join(", ")} since {timeText(st.rec.effectiveAt)}. DPIA signed by {st.rec.dpiaAttestation.signerName}. </>}
                        {st.scheduled && st.rec && <>Starts {timeText(st.rec.effectiveAt)}, after a {st.rec.noticePeriodDays}-day notice period. </>}
                        {!st.rec && <>Off. </>}
                        {FEATURE_WHAT[f]}
                      </>}
                      trailing={!st.rec && (
                        <Button onClick={() => setEnabling(f)} disabled={!isOwner} title={isOwner ? undefined : "Only the owner can turn this on"}>Turn on…</Button>
                      )} />
                  );
                })}
                {!isOwner && <p className="t-footnote ink3">Only the owner can turn a sensitive feature on.</p>}
                <p className="t-footnote ink3">Workflow metrics for groups of 5 or more people are always on. Purpose: process improvement, never the sole basis for pay, discipline or dismissal.</p>
              </div>
            )}
          </Load>
        </Card>
      </Section>

      <Section title="Notices">
        <Card>
          <Load q={notices}>
            {(ns) => (
              <Table caption="Notice versions" rows={ns} rowKey={(n) => n.id} onOpen={setNotice}
                columns={[
                  { key: "v", header: "Version", cell: (n) => `v${n.version}` },
                  { key: "title", header: "Title", cell: (n) => <span className="t-label">{n.title}</span> },
                  { key: "state", header: "State", cell: (n) => (n.replacedAt ? <StateTag role="neutral">Replaced</StateTag> : n.publishedAt ? <StateTag role="done">Published</StateTag> : <StateTag role="needsYou">Draft</StateTag>) },
                  { key: "features", header: "Covers", cell: (n) => n.features.map((f) => (f === "workflow_metrics" ? "Workflow metrics" : FEATURE_NAMES[f])).join(", ") },
                  { key: "acks", header: "Acknowledged", align: "end", cell: (n) => (n.publishedAt ? n.acks : "—") },
                ]} />
            )}
          </Load>
        </Card>
      </Section>

      <Section title="Audit log" aside="Append-only, hash-chained">
        <Card aside={<VerifyChain />} title="Recent events">
          <Load q={audit}>
            {(es) => (
              <Table caption="Audit events" rows={es} rowKey={(e) => e.id}
                columns={[
                  { key: "at", header: "When", cell: (e) => timeText(e.at) },
                  { key: "who", header: "Who", cell: (e) => (e.actor.type === "person" ? <>{name(e.actor.id)} <span className="ink3">{e.actor.accessRole ? ROLE_WORDS[e.actor.accessRole] : ""}</span></> : e.actor.type) },
                  { key: "action", header: "Action", cell: (e) => <span className="mono">{e.action}</span> },
                  { key: "subject", header: "About", cell: (e) => (e.subjectPersonId ? name(e.subjectPersonId) : <span className="ink3">—</span>) },
                ]} />
            )}
          </Load>
        </Card>
      </Section>

      {enabling && <EnableSheet feature={enabling} notices={notices.data ?? []} onClose={() => setEnabling(null)} />}
      {notice && <NoticeSheet notice={notice} onClose={() => setNotice(null)} />}
    </Page>
  );
}

function VerifyChain() {
  const { api } = useDeps();
  const m = useMutation({ mutationFn: () => api.get<ChainVerify>("/v1/audit-log/verify") });
  if (m.data) return m.data.ok ? <StateTag role="done">Chain intact</StateTag> : <StateTag role="needsYou">Chain broken at {m.data.brokenAt}</StateTag>;
  if (m.isError) return <ErrorNote error={m.error} />;
  return <Button onClick={() => m.mutate()} disabled={m.isPending}>Verify chain</Button>;
}

function NoticeSheet(props: { notice: Notice; onClose: () => void }) {
  const acks = useList<NoticeAckRow>(props.notice.publishedAt ? `/v1/compliance/notices/${props.notice.id}/acks` : null);
  const n = props.notice;
  return (
    <Sheet open onClose={props.onClose} wide title={`${n.title}, v${n.version}`}>
      <div className="inline">
        <Chip>{n.publishedAt ? `Published ${timeText(n.publishedAt)}` : "Draft"}</Chip>
        <Chip>{n.jurisdictions.join(", ")}</Chip>
        {n.publishedAt && <Chip>{acks.data ? `${acks.data.length} acknowledged` : "…"}</Chip>}
      </div>
      <pre className="pre" aria-label="Notice text">{n.markdown}</pre>
    </Sheet>
  );
}

const PLACES = ["CA-ON", "CA-QC", "CA-BC", "US-NY", "US-CA", "GB", "DE"];

function EnableSheet(props: { feature: SensitiveFeature; notices: Notice[]; onClose: () => void }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const covering = props.notices.filter((n) => n.features.includes(props.feature));
  const [f, setF] = useState<EnableForm>({
    jurisdictions: [], legalBasis: "legitimate_interest", completedOn: "", documentName: "", documentHash: "", signerName: "",
    signerTitle: "", noticeVersionId: covering[0]?.id ?? "", noticePeriodDays: "14", worksName: "", worksHash: "", quebecAck: false, attest: false,
  });
  const [touched, setTouched] = useState(false);
  const errors = touched ? validateEnable(f) : {};
  const set = <K extends keyof EnableForm>(k: K, v: EnableForm[K]) => setF({ ...f, [k]: v });
  const m = useMutation({
    mutationFn: (body: FeatureEnableRequest) => api.post<FeatureEnablement>(`/v1/compliance/features/${props.feature}/enable`, body),
    onSuccess: () => {
      void qc.invalidateQueries();
      props.onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.keys(validateEnable(f)).length > 0) return;
    m.mutate(toEnableRequest(props.feature, f));
  };

  return (
    <Sheet open onClose={props.onClose} wide title={`Turn on ${FEATURE_NAMES[props.feature].toLowerCase()}`}
      footer={<Button primary type="submit" form="enable-form" disabled={m.isPending} keycap="↩">Turn on after the notice period</Button>}>
      <form id="enable-form" className="stack" onSubmit={submit} noValidate>
        <p className="t-body ink2">
          {FEATURE_WHAT[props.feature]} It starts only after the notice period, and only where you choose. Employees see this
          attestation and every view of their data.
        </p>
        <fieldset className="checks">
          <legend className="t-label ink1">Where</legend>
          {PLACES.map((j) => (
            <label key={j} className="check t-body ink2">
              <input type="checkbox" checked={f.jurisdictions.includes(j)}
                onChange={(e) => set("jurisdictions", e.target.checked ? [...f.jurisdictions, j] : f.jurisdictions.filter((x) => x !== j))} />
              {j}
            </label>
          ))}
        </fieldset>
        {errors.jurisdictions && <p className="t-footnote state-ink-needs-you" role="alert">{errors.jurisdictions}</p>}
        <div className="grid-2">
          <Field label="Legal basis">
            <select className="input" value={f.legalBasis} onChange={(e) => set("legalBasis", e.target.value as LegalBasis)}>
              {Object.entries(LEGAL_BASIS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="DPIA completed on" error={errors.completedOn}>
            <input className="input" type="date" value={f.completedOn} onChange={(e) => set("completedOn", e.target.value)} />
          </Field>
          <Field label="DPIA document" error={errors.documentName}>
            <input className="input" value={f.documentName} onChange={(e) => set("documentName", e.target.value)} placeholder="DPIA 2026-10.pdf" />
          </Field>
          <Field label="Document SHA-256" error={errors.documentHash} hint="Proves which document was signed; the file stays with you.">
            <input className="input mono" value={f.documentHash} onChange={(e) => set("documentHash", e.target.value.trim().toLowerCase())} spellCheck={false} />
          </Field>
          <Field label="Signed by" error={errors.signerName}>
            <input className="input" value={f.signerName} onChange={(e) => set("signerName", e.target.value)} />
          </Field>
          <Field label="Title" error={errors.signerTitle}>
            <input className="input" value={f.signerTitle} onChange={(e) => set("signerTitle", e.target.value)} />
          </Field>
          <Field label="Notice" error={errors.noticeVersionId} hint="Employees must acknowledge it again.">
            <select className="input" value={f.noticeVersionId} onChange={(e) => set("noticeVersionId", e.target.value)}>
              <option value="">Choose a notice</option>
              {covering.map((n) => <option key={n.id} value={n.id}>v{n.version}: {n.title}{n.publishedAt ? "" : " (draft)"}</option>)}
            </select>
          </Field>
          <Field label="Notice period, days" error={errors.noticePeriodDays}>
            <input className="input" type="number" min={0} max={90} value={f.noticePeriodDays} onChange={(e) => set("noticePeriodDays", e.target.value)} />
          </Field>
        </div>
        {f.jurisdictions.includes("DE") && (
          <div className="grid-2">
            <Field label="Works agreement" error={errors.worksName}>
              <input className="input" value={f.worksName} onChange={(e) => set("worksName", e.target.value)} />
            </Field>
            <Field label="Works agreement SHA-256">
              <input className="input mono" value={f.worksHash} onChange={(e) => set("worksHash", e.target.value.trim().toLowerCase())} spellCheck={false} />
            </Field>
          </div>
        )}
        {f.jurisdictions.includes("CA-QC") && (
          <label className="check t-body ink2">
            <input type="checkbox" checked={f.quebecAck} onChange={(e) => set("quebecAck", e.target.checked)} />
            The notice describes how this feature is turned on (Quebec, s. 8.1).
          </label>
        )}
        {errors.quebecAck && <p className="t-footnote state-ink-needs-you" role="alert">{errors.quebecAck}</p>}
        <div className="well t-callout ink2" style={{ padding: 12 }}>
          Purpose: process improvement. These numbers must not be the sole basis for pay, discipline or dismissal.
        </div>
        <label className="check t-body ink1">
          <input type="checkbox" checked={f.attest} onChange={(e) => set("attest", e.target.checked)} />
          I attest that the DPIA above is complete and signed, and that this is my decision as owner.
        </label>
        {errors.attest && <p className="t-footnote state-ink-needs-you" role="alert">{errors.attest}</p>}
        {m.isError && <ErrorNote error={m.error} />}
      </form>
    </Sheet>
  );
}
