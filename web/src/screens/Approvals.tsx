import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { canApprove } from "../api/approvers.ts";
import type { ApprovalResponse, Batch, JobRole, RoleIdentity, RolePolicy, Workflow } from "../api/types.ts";
import { Button, Card, Chip, ErrorNote, Row, Sheet, StateTag } from "../design/components.tsx";
import { relativeText, shortHash } from "../lib/format.ts";
import { Load, useDeps, useGet, useList, useKey, useSession } from "../app/data.tsx";
import { Page } from "../app/page.tsx";

const BATCH_STATE: Record<Batch["state"], string> = {
  pending: "Waiting for approval", approved: "Approved", sending: "Sending", done: "Sent", rejected: "Rejected", expired: "Expired",
};

/**
 * Whether I approve a batch under its job role's policy: true, false, or undefined while the policy loads. Only
 * approvers see recipients and bodies and get the approve button (ADR 0111 §6).
 */
function useApprover(batches: Batch[] | undefined, workflows: Workflow[] | undefined) {
  const { api } = useDeps();
  const session = useSession();
  const wf = (b: Batch) => workflows?.find((w) => w.id === b.workflowId);
  const roleIds = [...new Set((batches ?? []).map((b) => wf(b)?.jobRoleId).filter((id): id is string => !!id))];
  const policies = useQueries({
    queries: roleIds.map((id) => ({ queryKey: [`/v1/policies/job-roles/${id}`], queryFn: () => api.get<RolePolicy>(`/v1/policies/job-roles/${id}`) })),
  });
  return (b: Batch): boolean | undefined => {
    const me = session.data?.person;
    const w = wf(b);
    if (!me || !w) return undefined;
    if (!w.jobRoleId) return canApprove(b, me, w, undefined);
    const p = policies[roleIds.indexOf(w.jobRoleId)];
    if (p?.isError) return false;
    return p?.data ? canApprove(b, me, w, p.data) : undefined;
  };
}

export function ApprovalsScreen() {
  const { now } = useDeps();
  const q = useList<Batch>("/v1/batches?state=pending");
  const workflows = useList<Workflow>("/v1/workflows");
  const mine = useApprover(q.data, workflows.data);
  const [open, setOpen] = useState<string | null>(null);
  const name = (id: string) => workflows.data?.find((w) => w.id === id)?.name ?? "Workflow";
  const first = q.data?.find((b) => mine(b) === true);
  useKey("Enter", () => first && setOpen(first.batchHash), !!first && !open);

  return (
    <Page title="Approvals" subtitle="Batches waiting for approval"
      actions={first && <Button primary keycap="↩" onClick={() => setOpen(first.batchHash)}>Review the oldest</Button>}>
      <Card>
        <Load q={q}>
          {(bs) => bs.length === 0 ? <p className="t-body ink2">Nothing is waiting. New batches land here when a run is ready to send.</p> : (
            <div role="list">
              {bs.map((b) => (
                <div role="listitem" key={b.batchHash}>
                  <Row state={mine(b) ? "needsYou" : "neutral"} stateLabel={mine(b) ? "Waiting for you" : "Waiting for its approvers"}
                    title={name(b.workflowId)}
                    detail={<>
                      {mine(b) === false && <>Not yours to approve · </>}
                      {b.items.length} {b.items.length === 1 ? "item" : "items"} · {b.runtime === "cloud" ? "cloud worker" : "Mac"} · expires {relativeText(b.expiresAt, now())}
                      {b.overnightEvaluation && b.overnightEvaluation.result !== "allow" && <> · held for review: {b.overnightEvaluation.reason}</>}
                    </>}
                    trailing={<Button onClick={() => setOpen(b.batchHash)}>Open</Button>} />
                </div>
              ))}
            </div>
          )}
        </Load>
      </Card>
      <p className="t-callout ink3">
        Only the person who ran a batch and the approvers its job role names can see item contents. Opening a batch is recorded in the audit log.
      </p>
      {open && <BatchSheet hash={open} onClose={() => setOpen(null)} workflowName={name} approver={mine} />}
    </Page>
  );
}

function BatchSheet(props: { hash: string; onClose: () => void; workflowName: (id: string) => string; approver: (b: Batch) => boolean | undefined }) {
  const { api } = useDeps();
  const qc = useQueryClient();
  const session = useSession();
  const q = useGet<Batch>(`/v1/batches/${props.hash}`);
  const identities = useList<RoleIdentity>("/v1/role-identities");
  const roles = useList<JobRole>("/v1/job-roles");
  const done = () => {
    void qc.invalidateQueries();
    props.onClose();
  };
  const approve = useMutation({
    mutationFn: (b: Batch) => api.post<ApprovalResponse>(`/v1/batches/${b.batchHash}/approve`, { batchHash: b.batchHash, itemKeys: null, edits: [] }),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: (b: Batch) => api.post<Batch>(`/v1/batches/${b.batchHash}/reject`, { reason: "Rejected at review" }),
    onSuccess: done,
  });
  const b = q.data;
  const sender = (b: Batch) => b.identity.type === "role_identity"
    ? identities.data?.find((i) => i.id === b.identity.id)?.address ?? "a role identity"
    : b.identity.id === session.data?.person.id ? "you" : "the runner";
  const role = (b: Batch) => roles.data?.find((r) => r.roleIdentityIds.includes(b.identity.id))?.name;
  const mine = b ? props.approver(b) : undefined;

  if (b && mine === false) {
    return (
      <Sheet open onClose={props.onClose} wide title={props.workflowName(b.workflowId)}>
        <div className="inline">
          <StateTag role="neutral">{BATCH_STATE[b.state]}</StateTag>
          <Chip>{b.items.length} {b.items.length === 1 ? "item" : "items"}</Chip>
          {role(b) && <Chip>{role(b)}</Chip>}
          <Chip>Version {b.version}</Chip>
        </div>
        <p className="t-body ink1">You are not an approver for this batch.</p>
        <p className="t-callout ink3">Only the person who ran it and the approvers its job role names can see its recipients and contents, and approve it.</p>
      </Sheet>
    );
  }

  return (
    <Sheet open onClose={props.onClose} wide title={b ? props.workflowName(b.workflowId) : "Batch"}
      onEnter={() => b && mine && !approve.isPending && approve.mutate(b)}
      footer={b && mine && <>
        <Button onClick={() => reject.mutate(b)} disabled={reject.isPending || approve.isPending}>Reject</Button>
        <Button primary keycap="↩" onClick={() => approve.mutate(b)} disabled={approve.isPending || reject.isPending}>
          Approve {b.items.length} {b.items.length === 1 ? "item" : "items"}
        </Button>
      </>}>
      <Load q={q}>
        {(b) => (
          <>
            <div className="inline">
              <Chip>Sends as {sender(b)}</Chip>
              {role(b) && <Chip>{role(b)}</Chip>}
              <Chip>Version {b.version}</Chip>
              <span className="t-footnote ink3 mono">batch {shortHash(b.batchHash)}</span>
            </div>
            {b.overnightEvaluation && (
              <StateTag role={b.overnightEvaluation.result === "allow" ? "done" : "needsYou"}>
                Overnight policy: {b.overnightEvaluation.result === "allow" ? "would allow" : b.overnightEvaluation.result === "queue" ? "held for review" : "tripped"}
                {b.overnightEvaluation.reason ? `. ${b.overnightEvaluation.reason}` : ""}
              </StateTag>
            )}
            {b.items.map((it, i) => (
              <div key={it.key} className="well">
                <div className="spread" style={{ padding: "4px 8px" }}>
                  <span className="t-caption ink3">Item {i + 1} · <span className="mono">{it.capability}</span></span>
                </div>
                <dl className="kv" style={{ padding: "4px 8px 8px" }}>
                  {it.fields.map(([label, value]) => (
                    <div key={label} style={{ display: "contents" }}>
                      <dt>{label}</dt>
                      <dd className="t-body" style={{ whiteSpace: "pre-wrap" }}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
            <p className="t-footnote ink3">Approving applies to exactly these items (by hash). If anything changed, approval fails and you see the new version.</p>
            {approve.isError && <ErrorNote error={approve.error} />}
            {reject.isError && <ErrorNote error={reject.error} />}
          </>
        )}
      </Load>
    </Sheet>
  );
}
