// BIAS: each outreach/email default that leaked into non-messaging tasks is neutralised, and email tasks keep their
// behaviour. One test per change (the PR lists them).
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePersona, writePersona } from "../../fixtures/gen-domains.ts";
import { REPORT_START, reportNow } from "../../fixtures/domains-report.ts";
import { analyzeHome } from "../../src/analyze.ts";
import { StubModel, type ModelRole } from "../../src/models/model.ts";
import { capabilityFamily } from "../../src/plan/tools.ts";
import { understandingJudge } from "../../src/understanding/labeler.ts";
import { draftGeneralWorkflow } from "../../src/workflows/drafter.ts";
import { keptFiles } from "../../src/workflows/service.ts";
import { workflowDir } from "../../src/workflows/store.ts";
import { buildFixture, LINKEDIN_IMAGE } from "./fixtures.ts";
import { tmp } from "./setup.ts";

const commit = (target: string, role = "send") => ({ type: "commit", capability: { target, capability: "ui.commit", via: "computer_use", role } });
const read = (target: string, need?: string) => ({ type: "read", capability: { target, capability: "screen.read", via: "computer_use", role: "read", ...(need === undefined ? {} : { need }) } });
const ask = (role: ModelRole, prompt = "<facts>\n</facts>") => new StubModel().complete({ role, model: "stub", system: "", prompt });

describe("s22 bias audit: no email or outreach default outside messaging", () => {
  test("BIAS: tools.ts: a text output is a Slack message only in a chat app (a LinkedIn post or an editor is not)", () => {
    expect(capabilityFamily(commit("linkedin"), "message", 5)).toBeNull();
    expect(capabilityFamily(commit("app-cursor"), "message", 5)).toBeNull();
    expect(capabilityFamily(commit("slack"), "message", 5)).toBe("chat.message");
    expect(capabilityFamily(commit("gmail"), "email", 5)).toBe("email.send");
  });

  test("BIAS: tools.ts: reading LinkedIn is a person lookup only when a person is what is read", () => {
    expect(capabilityFamily(read("linkedin", "read the post feed on LinkedIn"), "message", 5)).toBeNull();
    expect(capabilityFamily(read("linkedin", "look up lead profile on LinkedIn"), "rows", 5)).toBe("enrich.person");
    // Unchanged when the step carries no need text.
    expect(capabilityFamily(read("linkedin"), "rows", 5)).toBe("enrich.person");
  });

  test("BIAS: tools.ts: a second commit is a CRM log only in a CRM or a sheet", () => {
    expect(capabilityFamily(commit("xero", "log"), "record", 5)).toBeNull();
    expect(capabilityFamily(commit("app-terminal", "log"), "record", 5)).toBeNull();
    expect(capabilityFamily(commit("hubspot", "log"), "record", 5)).toBe("crm.log");
    expect(capabilityFamily(commit("google-sheets", "log"), "record", 5)).toBe("crm.log");
  });

  test("BIAS: model.ts stub: only the draft role writes the email-shaped text; label, refine and explain get no investor email", async () => {
    for (const role of ["label", "refine", "explain"] as const) {
      const t = await ask(role);
      expect(t).toBe("");
      expect(t).not.toMatch(/Muhammad|short call|raise|traction/);
    }
    expect(await ask("draft", '<recipient>\n{"firstName":"Ana"}\n</recipient>\n<facts>\n- company: Acme\n</facts>')).toMatch(/^Hi Ana,/);
  });

  test("BIAS: model.ts stub step: a post or a prompt is a neutral draft, not a recruiter scorecard; scorecards and replies keep theirs", async () => {
    const src = (what: string) => `<source untrusted="true">\nLaunch week recap\n</source>\n\nWrite the ${what} now.`;
    const post = await ask("step", src("post"));
    expect(post).toBe("Post: Launch week recap\n\n[missing: your post]");
    expect(post).not.toMatch(/What stands out|Recommendation|Thanks for getting in touch/);
    expect(await ask("step", src("scorecard"))).toContain("What stands out");
    expect(await ask("step", src("reply"))).toContain("Thanks for getting in touch");
  });

  test("BIAS: labeler.ts judge: writing for someone (a post) is not 'replies to'; a reply still is", () => {
    const f = buildFixture(LINKEDIN_IMAGE);
    const p = f.subject.profile;
    const u = { ...p.understanding!, counterparts: ["your followers"] };
    const write = understandingJudge.judge({ profile: { ...p, understanding: u }, sameness: 0.5 });
    expect(write.reasons.join(" | ")).toContain("writes for your followers");
    expect(write.reasons.join(" | ")).not.toContain("replies to");
    const replyU = { ...u, steps: u.steps.map((s, i) => (i === 0 ? { ...s, verb: "reply" } : s)) };
    expect(understandingJudge.judge({ profile: { ...p, understanding: replyU }, sameness: 0.5 }).reasons.join(" | ")).toContain("replies to your followers");
  });

  test("BIAS: service.ts kept files: a general workflow's list and log are items and a done log, not recipients and emails", async () => {
    const home = tmp();
    writePersona(home, generatePersona("bookkeeper", { seed: 7, startDay: REPORT_START }), { encrypted: false, seed: 7 });
    const a = await analyzeHome(home, { now: reportNow, understanding: "v2" });
    const { workflow } = await draftGeneralWorkflow({ home, analysis: a, insightId: a.insights[0]!.id, model: new StubModel(), now: reportNow });
    const dir = workflowDir(home, workflow.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, workflow.inputs.list), "id\n1\n");
    writeFileSync(join(dir, workflow.inputs.crmLog), "id\n1\n");
    const notes = keptFiles(home).filter((k) => k.workflowId === workflow.id);
    expect(notes.find((k) => k.kind === "recipients")?.note).toMatch(/^Your item list/);
    expect(notes.find((k) => k.kind === "send_log")?.note).toMatch(/what was already done/);
    for (const k of notes) expect(k.note).not.toMatch(/recipient|emailed/);
  });
});
