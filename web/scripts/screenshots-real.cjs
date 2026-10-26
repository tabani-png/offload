// Captures the key S2-11 views on the REAL control plane serving the production build (dark, 1440x900) into
// web/screenshots/real/. Fails if the browser reports a CSP violation or a console error.
// Usage: bunx vite build && node scripts/screenshots-real.cjs   (needs the control Postgres: docker compose up -d --wait)
// Starts control/tests/S2-11/fixture-server.ts (seeded tenant); the browser clock is pinned to the server's clock.
// Uses the Playwright installed on the machine; it is not a dependency of this package.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const OUT = path.join(__dirname, "../screenshots/real");
const CONTROL = path.join(__dirname, "../../control");

function startFixture() {
  return new Promise((resolve, reject) => {
    const p = spawn("bun", ["tests/S2-11/fixture-server.ts"], { cwd: CONTROL, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      const line = buf.split("\n").find((l) => l.startsWith("S2-11-READY "));
      if (line) resolve({ proc: p, state: JSON.parse(line.slice(12)) });
    });
    p.on("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
}

async function ctl(state, p, body) {
  const r = await fetch(state.ctl + p, body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function api(state, who, method, p, body) {
  const { cookie, csrf } = await ctl(state, "/session", { who });
  const r = await fetch(state.api + p, { method, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { proc, state } = await startFixture();
  const browser = await chromium.launch();
  const problems = [];
  try {
    const shoot = async (name, who, route, act) => {
      const { cookie } = await ctl(state, "/session", { who });
      const now = (await ctl(state, "/state")).now;
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
      // The session cookie /auth/callback would have set. Chromium will not take a __Host- cookie on plain http, so the
      // page's requests to the control plane are re-sent with it (route.fetch) and answered with the real response.
      await ctx.route(`${state.api}/**`, async (r) => r.fulfill({ response: await r.fetch({ headers: { ...r.request().headers(), cookie } }) }));
      const page = await ctx.newPage();
      await page.clock.install({ time: now });
      // Expected 4xx answers (422 group_floor) are logged by the browser as "Failed to load resource"; anything else fails.
      page.on("console", (m) => {
        const t = m.text();
        if (/Content Security Policy|Refused to/.test(t) || (m.type() === "error" && !/status of 4\d\d/.test(t))) problems.push(`${name}: ${t}`);
      });
      page.on("pageerror", (e) => problems.push(`${name}: ${e.message}`));
      if (process.env.DEBUG_NET) page.on("response", (r) => console.log(r.status(), r.url()));
      const res = await page.goto(state.api + route);
      if (name === "01-overview") console.log("CSP:", res.headers()["content-security-policy"]);
      await page.waitForSelector("main#main");
      await page.waitForFunction(() => !document.querySelector("[role=status]"), null, { timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: path.join(OUT, `${name}-STUCK.png`) }); console.error(await page.evaluate(() => document.querySelector("main")?.innerText)); throw e; });
      if (act) await act(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
      await ctx.close();
    };
    const { depts, workflows } = state;
    await shoot("01-overview", "owner", "/");
    await shoot("02-department-sales", "owner", `/departments/${depts.sales}`);
    await shoot("03-department-legal-floor", "owner", `/departments/${depts.legal}`);
    await shoot("04-evidence-lead-follow-up", "owner", `/workflows/${workflows.sales}/evidence`);
    await shoot("05-evidence-legal-floor", "owner", `/workflows/${workflows.legal}/evidence`);
    await shoot("06-people-gated-off", "owner", "/people");
    await shoot("07-workflows", "admin", "/workflows");
    await shoot("08-approvals-runner", "member", "/approvals");
    await shoot("09-compliance", "owner", "/compliance");
    await shoot("10-me", "member", "/me");
    await shoot("11-enable-sheet", "owner", "/compliance", (p) => p.getByRole("button", { name: /Turn on/ }).first().click());

    // Turn both features on (3-day / 1-day notice), let them become effective, then show the gated views.
    const n = await api(state, "owner", "POST", "/v1/compliance/notices", {
      template: "ontario-esa-policy", title: "Monitoring policy v2", markdown: "# Policy", jurisdictions: [],
      features: ["workflow_metrics", "per_person_views", "working_time"],
    });
    await api(state, "owner", "POST", `/v1/compliance/notices/${n.id}/publish`);
    const enable = (feature, days) => api(state, "owner", "POST", `/v1/compliance/features/${feature}/enable`, {
      feature, jurisdictions: ["CA-ON"], legalBasis: "legitimate_interest",
      dpiaAttestation: { completedOn: "2026-10-01", documentHash: "a".repeat(64), documentName: "dpia-2026.pdf", signerName: "Pia Owner", signerTitle: "COO" },
      noticeVersionId: n.id, noticePeriodDays: days, worksAgreementRef: null, quebecActivationAck: false, purposeLock: "process_improvement",
    });
    await enable("per_person_views", 3);
    await enable("working_time", 1);
    await ctl(state, "/ack", { noticeId: n.id, features: ["workflow_metrics", "per_person_views", "working_time"] });
    await shoot("12-compliance-scheduled", "owner", "/compliance");
    const t0 = (await ctl(state, "/state")).now;
    await ctl(state, "/clock", { t: t0 + 2 * 86_400_000 });
    const day = new Date(t0 + 86_400_000 + 3600_000).toISOString().slice(0, 10);
    await ctl(state, "/working-time", { noticeId: n.id, days: [day] });
    await ctl(state, "/clock", { t: t0 + 3 * 86_400_000 + 3600_000 });
    await shoot("13-people-per-person-on", "owner", "/people", (p) => p.getByRole("button", { name: "Show hours for member", exact: true }).click());
    await shoot("14-department-sales-working-time", "owner", `/departments/${depts.sales}`);
    await shoot("15-overview-working-time", "owner", "/");
    await shoot("16-me-access-log", "member", "/me");
  } finally {
    await browser.close();
    proc.stdin.end();
  }
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`screenshots in ${OUT}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
