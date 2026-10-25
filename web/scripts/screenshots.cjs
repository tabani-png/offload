// Captures every view of the admin web on the mock API (dark, 1440x900) into web/screenshots/.
// Usage: bun run build && bunx vite preview --port 4173 & node scripts/screenshots.cjs [baseUrl]
// Uses the Playwright that is installed on the machine; it is not a dependency of this package.
const { chromium } = require("playwright");
const path = require("node:path");

const base = process.argv[2] ?? "http://localhost:4173";
const W = "00000000-0000-4000-8000-";
const id = (n) => W + n.toString(16).padStart(12, "0");
const shots = [
  ["01-overview", "/"],
  ["02-department-sales", `/departments/${id(101)}`],
  ["03-department-legal-suppressed", `/departments/${id(105)}`],
  ["04-workflows", "/workflows"],
  ["05-workflow-role", `/workflows/${id(301)}`],
  ["06-workflow-proposed", `/workflows/${id(309)}`],
  ["07-promote-sheet", `/workflows/${id(309)}`, async (p) => { await p.keyboard.press("p"); }],
  ["08-sop-preview", `/workflows/${id(301)}`, async (p) => { await p.keyboard.press("s"); }],
  ["09-evidence", `/workflows/${id(301)}/evidence`],
  ["10-approvals", "/approvals"],
  ["11-batch-sheet", "/approvals", async (p) => { await p.getByRole("button", { name: /Review the oldest/ }).click(); }],
  ["12-digest", "/digest"],
  ["13-workers", "/workers"],
  ["14-worker-runs", `/workers/${id(601)}`],
  ["15-people-gated", "/people"],
  ["16-people-per-person-on", "/people?features=per_person_views"],
  ["17-offboarding", "/offboarding"],
  ["18-handover-sheet", "/offboarding", async (p) => { await p.getByRole("button", { name: /Assign the next/ }).click(); }],
  ["19-compliance", "/compliance"],
  ["20-enable-sheet", "/compliance", async (p) => { await p.getByRole("button", { name: /Turn on/ }).first().click(); }],
  ["21-me", "/me"],
  ["22-overview-light", "/?theme=light"],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark" });
  for (const [name, url, act] of shots) {
    await page.goto(base + url, { waitUntil: "networkidle" });
    await page.waitForSelector("main#main");
    await page.waitForFunction(() => !document.querySelector("[role=status]"));
    if (act) { await act(page); await page.waitForTimeout(400); await page.waitForFunction(() => !document.querySelector("[role=status]")); }
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(__dirname, "..", "screenshots", `${name}.png`), fullPage: !act });
    console.log("shot", name);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
