// s20 review 5 (independent review of 90f83a1): a UI commit (computer use) is a declared action of its own, routed to
// computer use only and never to the app's connector send; a later step (the log) never runs when the primary commit
// did not happen; the most dangerous verb of a phrase wins; broad verbs only map to a catalog commit whose object they
// name; approving a payment is a commit; "log in the call" is not signing in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chainDeps, ChainResolver, result, type MethodProbe } from "../../src/connectors/chain.ts";
import { computerPolicies } from "../../src/connectors/computer/executor.ts";
import { expectedCommit } from "../../src/connectors/computer/actions.ts";
import type { Method } from "../../src/connectors/link.ts";
import { commitCapability, type StepTarget } from "../../src/plan/capabilities.ts";
import { isReadOnlyStep, stepClass } from "../../src/plan/steps.ts";
import { understandingJudge } from "../../src/understanding/labeler.ts";
import { baseVerb } from "../../src/understanding/verbs.ts";
import { TOOL_POLICIES } from "../../src/workflows/allowlist.ts";
import { buildChain } from "../../src/workflows/chain-executor.ts";
import type { ExecJob, ExecResult, Executor } from "../../src/workflows/executor.ts";
import { approveBatch, declaredActions, executeBatch, prepareLiveBatch } from "../../src/workflows/runner.ts";
import { readWorkflow, updateWorkflow } from "../../src/workflows/store.ts";
import type { WorkflowJson } from "../../src/workflows/types.ts";
import { dryRun } from "../../src/workflows/dryrun.ts";
import { NOW, world, writeRecipients, type World } from "../s05-workflows/setup.ts";

// ---------- P2-1: the computer-use commit path ----------

const CRM = { spreadsheetId: "sheet-1", range: "CRM!A1" };
const ROWS = ["anna@northzone.com,Anna,Berg,Northzone,", "leo@hustlefund.vc,Leo,Park,Hustle Fund,"];

let w: World;
beforeEach(async () => {
  w = await world();
  writeRecipients(w.home, w.outreach.id, ROWS);
  const d = await dryRun({ home: w.home, analysis: w.analysis, workflowId: w.outreach.id, model: w.model, limit: 2, now: () => NOW });
  approveBatch(w.home, w.outreach.id, d.batchHash, NOW + 1);
});
afterEach(() => w.cleanup());

/** The mixed plan: delete-style commit in Gmail done on screen, then a Sheets row. */
function asMixedPlan(): WorkflowJson {
  return updateWorkflow(
    w.home,
    w.outreach.id,
    (wf) => {
      wf.steps = [
        { id: "approve", type: "approval_gate", title: "Approve", detail: "", connector: null, sideEffect: false },
        { id: "commit_1", type: "send", title: "Delete the email in Gmail", detail: "", connector: "gmail", sideEffect: true, method: "computer" } as WorkflowJson["steps"][number],
        { id: "commit_2", type: "log", title: "Add the row in Google Sheets", detail: "", connector: "google-sheets", sideEffect: true },
      ];
      wf.inputs.crmSheet = CRM;
    },
    NOW + 2,
  );
}

describe("s20 ROUTE review 5: a UI commit is its own declared action, done only by computer use", () => {
  test("ROUTE: \"delete the email in Gmail\" is declared as a computer-use send (legacy step keeps the target, marked computer)", async () => {
    const { legacySteps } = await import("../../src/plan/build.ts");
    const v = { id: "a", label: "", summary: "", steps: [
      { id: "commit_1", type: "commit", title: "Delete the email in Gmail", detail: "", capability: { need: "delete email in Gmail", target: "gmail", targetName: "Gmail", capability: "ui.commit", role: "send", via: "catalog" }, gated: true, when: null, writesText: false, sourceSteps: [] },
    ] } as unknown as Parameters<typeof legacySteps>[0];
    const send = legacySteps(v).find((s) => s.type === "send")! as WorkflowJson["steps"][number] & { method?: string };
    expect([send.connector, send.method]).toEqual(["gmail", "computer"]);
    const wf = asMixedPlan();
    expect(declaredActions(wf)).toEqual([
      { role: "send", connector: "gmail", method: "computer" },
      { role: "log", connector: "google-sheets" },
    ] as unknown as ReturnType<typeof declaredActions>);
  });

  test("ROUTE: buildChain routes a computer-use send to computer use only, even when the Gmail connector is healthy", async () => {
    const wf = asMixedPlan();
    const probe = (method: Method): MethodProbe => ({ method, probe: async () => result("ok", "ok", null, method === "computer" ? { reads: ["screen.read"], writes: ["mail.send"] } : { reads: ["mail.read"], writes: ["mail.send", "sheet.append"] }, 0) });
    const resolver = new ChainResolver(chainDeps({ home: w.home, env: {}, simulated: false }), new Map((["mcp", "composio", "api", "computer"] as const).map((m) => [m, probe(m)])));
    const fake: Executor = { execute: async () => ({ toolCalls: [], text: "" }) };
    const build = await buildChain({ home: w.home, env: {}, resolver, config: null, actions: declaredActions(wf), mcpExecutor: fake, executors: { mcp: fake, composio: fake, api: fake, computer: fake } });
    expect(build?.methods).toEqual(["computer"]);
    expect(Object.keys(build!.servers)).toEqual(["computer_gmail"]);
    expect(build!.policies.every((p) => p.flavor === "computer")).toBe(true);
  });

  test("ROUTE: end to end (executeBatch, fakes): the Gmail send tool is refused, and the Sheets log runs only after a commit that happened", async () => {
    asMixedPlan();
    const b = await prepareLiveBatch({ home: w.home, workflowId: w.outreach.id, model: w.model, now: () => NOW + 10 });
    const { token } = approveBatch(w.home, w.outreach.id, b.hash, NOW + 11);
    const append = TOOL_POLICIES.find((p) => p.tool === "append_row")!;
    const decisions: string[] = [];
    const exec: Executor = {
      async execute(job: ExecJob): Promise<ExecResult> {
        const [a, l] = job.batch.items;
        const row = (k: typeof a) => append.expected!(k!, { batchHash: job.batch.hash, crmSheet: CRM })!;
        const commit = (k: typeof a) => ({ app: "gmail", ...expectedCommit(k!) });
        const note = (label: string, d: { result: { behavior: string } }) => decisions.push(`${label} ${d.result.behavior}`);
        note("a gmail-send", job.gate.check("mcp__gmail__send_email", { to: a!.to, subject: a!.subject, body: a!.body }));
        note("a log-before-commit", job.gate.check("mcp__sheets__append_row", row(a)));
        const ca = job.gate.check("mcp__computer_gmail__commit", commit(a));
        note("a commit", ca);
        if (ca.result.behavior === "allow") job.onToolResult?.({ tool: "mcp__computer_gmail__commit", input: commit(a), allowed: true, ok: false, itemKey: a!.key, role: "send", error: "the button was not found" });
        note("a log-after-failed-commit", job.gate.check("mcp__sheets__append_row", row(a)));
        const cl = job.gate.check("mcp__computer_gmail__commit", commit(l));
        note("l commit", cl);
        if (cl.result.behavior === "allow") job.onToolResult?.({ tool: "mcp__computer_gmail__commit", input: commit(l), allowed: true, ok: true, itemKey: l!.key, role: "send" });
        note("l log-after-commit", job.gate.check("mcp__sheets__append_row", row(l)));
        return { toolCalls: [], text: "" };
      },
    };
    await executeBatch({ home: w.home, workflowId: w.outreach.id, hash: b.hash, token, executor: exec, servers: { gmail: ["gmail"], sheets: ["google-sheets"], computer_gmail: ["gmail"] }, policies: computerPolicies(["gmail"]), now: () => NOW + 12 });
    expect(decisions).toEqual(["a gmail-send deny", "a log-before-commit deny", "a commit allow", "a log-after-failed-commit deny", "l commit allow", "l log-after-commit allow"]);
    expect(readWorkflow(w.home, w.outreach.id)?.steps.find((s) => s.id === "commit_1")?.title).toBe("Delete the email in Gmail");
  });
});

// ---------- P2-2, P2-3, P3 ----------

describe("s20 TYPER review 5: the most dangerous verb wins; broad verbs need their object", () => {
  test("TYPER: irreversible beats action beats other writes; open and close stays a read", () => {
    expect(["reply and delete", "update the sheet and pay the invoice", "add the row and publish", "open and close", "reading and replying"].map(baseVerb)).toEqual(["delete", "pay", "publish", "open", "reply"]);
    const risk = (verb: string) =>
      understandingJudge.judge({ profile: { app: "x", appName: "X", host: "", urlPattern: "", understanding: { steps: [{ verb: baseVerb(verb), object: "invoice", activeMs: 1000, surface: "X", category: "other" }], counterparts: [], sources: { frames: 3 } } }, sameness: 0.5 } as unknown as Parameters<typeof understandingJudge.judge>[0]).risk;
    expect(risk("update the sheet and pay the invoice")).toBe(0.5);
  });

  test("ROUTE: a broad verb (add, create, record, update, log, enter) maps to a catalog commit only when the object is that commit's object", () => {
    const at = (id: string, verb: string, object: string) => commitCapability({ target: id, targetName: id, via: "catalog", connectorId: id } as StepTarget, verb, object);
    expect([
      at("salesforce", "create", "lead"),
      at("hubspot", "add", "contact"),
      at("attio", "add", "contact"),
      at("xero", "create", "contact"),
      at("xero", "record", "payment"),
      at("quickbooks", "record", "payment"),
    ]).toEqual(["ui.commit", "ui.commit", "ui.commit", "ui.commit", "ui.commit", "ui.commit"]);
    expect([at("xero", "create", "invoice"), at("quickbooks", "enter", "bill"), at("salesforce", "create", "task"), at("hubspot", "add", "note"), at("google-sheets", "add", "row"), at("gmail", "send", "email"), at("greenhouse", "move", "candidate")]).toEqual(["accounting.bill", "accounting.bill", "crm.task", "crm.note", "sheet.append", "mail.send", "ats.move_stage"]);
  });

  test("TYPER: approving a payment, expense, invoice or refund is an irreversible commit, not a judgement read", () => {
    for (const o of ["payment", "expense", "invoice", "refund"]) {
      expect(`${o} ${stepClass({ verb: "approve", object: o })} ${isReadOnlyStep({ verb: "approve", object: o })}`).toBe(`${o} record false`);
      const j = understandingJudge.judge({ profile: { app: "x", appName: "X", host: "", urlPattern: "", understanding: { steps: [{ verb: "approve", object: o, activeMs: 1000, surface: "X", category: "other" }], counterparts: [], sources: { frames: 3 } } }, sameness: 0.5 } as unknown as Parameters<typeof understandingJudge.judge>[0]);
      expect(`${o} ${j.risk}`).toBe(`${o} 0.5`);
    }
    expect(stepClass({ verb: "approve", object: "candidate" })).toBe("judge");
  });

  test("TYPER: \"log in the call\" logs the call; \"log in\" and \"log in to the portal\" sign in", () => {
    expect(["log in the call", "logging in the notes", "log in", "logging in", "log in to the portal"].map(baseVerb)).toEqual(["log", "log", "log in", "log in", "log in"]);
  });
});
