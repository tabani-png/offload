// s23: a deterministic NEUTRAL week of mixed knowledge work, in the observer's store format (docs/store-contract.md),
// for the time screen's demo. Not the outreach-heavy s09 week (gen.ts stays as it is for the review flow).
// Weekdays: Claude Code sessions in a terminal, VS Code, docs in Notion, a standup in Zoom and a review in Google Meet,
// calendar checks, two spreadsheets updated a few times a day, a little email (inbox and replies), Slack, browsing
// (GitHub, MDN, Stack Overflow, Hacker News, Wikipedia), Finder. Weekend: a little coding, reading and notes.
// Usage: bun run brain/fixtures/gen-neutral.ts --out DIR [--seed 42] [--encrypted] [--start 2026-10-12]
import { createHash } from "node:crypto";
import { IDLE_THRESHOLD_MS } from "../src/sessionize.ts";
import type { DayLabel, OffloadEvent } from "../src/types.ts";
import { mulberry32, writeFixture, type FixtureDay, type FixtureOptions, type Rng } from "./gen.ts";

export type { FixtureDay, FixtureOptions };

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error("pick from an empty list");
  return item;
}
/** Roughly normal: mean ± spread, from the sum of three uniforms. */
const around = (rng: Rng, mean: number, spread: number) => mean + ((rng() + rng() + rng()) / 1.5 - 1) * spread;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function ulid(ts: number, rng: Rng): string {
  let time = "";
  let t = ts;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(rng() * 32)];
  return time + rand;
}

// ---------- the world: a product engineer at a small software team ----------

const ME = "sam@northwind.dev";
const CHROME = "com.google.Chrome";
const TERMINAL = "com.apple.Terminal";
const VSCODE = "com.microsoft.VSCode";
const NOTION = "notion.id";
const SLACK = "com.tinyspeck.slackmacgap";
const ZOOM = "us.zoom.xos";
const FINDER = "com.apple.finder";
const PREVIEW = "com.apple.Preview";
const APP_NAMES: Record<string, string> = {
  [CHROME]: "Google Chrome",
  [TERMINAL]: "Terminal",
  [VSCODE]: "Code",
  [NOTION]: "Notion",
  [SLACK]: "Slack",
  [ZOOM]: "zoom.us",
  [FINDER]: "Finder",
  [PREVIEW]: "Preview",
};

const MAIL_URL = "https://mail.google.com/mail/u/0/";
const METRICS_URL = "https://docs.google.com/spreadsheets/d/1tEaMmEtRiCs7Q4sheetAbCd/edit";
const SPRINT_URL = "https://docs.google.com/spreadsheets/d/1sPrInTtRaCkEr2sheetEfGh/edit";
const TEAM = ["Jordan Lee", "Alex Kim", "Riley Patel", "Casey Morgan"];
const TEAM_MAIL = ["jordan@northwind.dev", "alex@northwind.dev", "riley@northwind.dev", "casey@northwind.dev"];
const CHANNELS = ["eng", "product", "design", "general", "releases"];
const REPO = "atlas";
const FILES = ["router.ts", "billing.ts", "ledger.ts", "sync.ts", "auth.ts", "export.ts", "schema.sql", "README.md"];
const PROMPTS = [
  "fix the failing test in billing.ts",
  "add CSV export to the ledger view",
  "why is the sync job slow on large accounts",
  "write tests for the auth refresh path",
  "refactor the router to use the new middleware",
  "update the README with the new setup steps",
];
const DOCS = ["Atlas API design", "Roadmap draft", "Onboarding guide", "Incident review: sync delay", "Hiring plan", "Pricing page copy", "Data retention policy", "Release checklist", "Team rituals", "Search feature spec", "Customer interview notes", "Architecture decision: queues", "Support macros"];
const THREADS = ["Atlas API review", "Release notes for 2.4", "Design review follow-up", "Invoice for October", "Team offsite plan"];
const PRS = ["Add CSV export", "Fix sync retry", "Router middleware", "Auth refresh tests", "Ledger pagination"];
const MDN = ["Intl.DateTimeFormat"];
const SO = ["Postgres index not used for LIKE query"];
const WIKI = ["Two-phase commit protocol"];

interface Activity {
  start: number;
  end: number;
  kpm: number;
  cpm: number;
}

/** Same shape as gen.ts's builder (that one is private to gen.ts): focus, OCR, work at a key rate, idle, end. */
class DayBuilder {
  readonly events: OffloadEvent[] = [];
  private readonly activities: Activity[] = [];
  t: number;

  constructor(
    private readonly rng: Rng,
    readonly dayStart: number,
  ) {
    this.t = dayStart;
  }

  private push(ts: number, e: Omit<OffloadEvent, "id" | "ts">): void {
    this.events.push({ id: ulid(ts, this.rng), ts, ...e });
  }

  focus(app: string, title: string, url = ""): void {
    const host = url === "" ? undefined : new URL(url).host;
    this.push(this.t, { kind: "focus", app, appName: APP_NAMES[app] ?? app, title, ...(url === "" ? {} : { url, host }) });
  }

  ocr(offsetS: number, text: string): void {
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    this.push(this.t + Math.round(offsetS * 1000), { kind: "ocr", text, textHash });
  }

  work(seconds: number, kpm: number, cpm: number): void {
    const ms = Math.max(1000, Math.round(seconds * 1000));
    this.activities.push({ start: this.t, end: this.t + ms, kpm, cpm });
    this.t += ms;
  }

  idle(seconds: number): void {
    const ms = Math.round(seconds * 1000);
    if (ms >= IDLE_THRESHOLD_MS) {
      this.push(this.t + IDLE_THRESHOLD_MS, { kind: "idle_start" });
      this.push(this.t + ms, { kind: "idle_end" });
    }
    this.t += ms;
  }

  end(): OffloadEvent[] {
    this.push(this.t + IDLE_THRESHOLD_MS, { kind: "idle_start" });
    const first = Math.ceil(this.dayStart / 60_000) * 60_000;
    for (let m = first; m <= this.t; m += 60_000) {
      let keys = 0;
      let clicks = 0;
      for (const a of this.activities) {
        const overlap = Math.min(a.end, m) - Math.max(a.start, m - 60_000);
        if (overlap <= 0) continue;
        const f = overlap / 60_000;
        keys += a.kpm * f * (0.8 + this.rng() * 0.4);
        clicks += a.cpm * f * (0.8 + this.rng() * 0.4);
      }
      const k = Math.round(keys);
      const c = Math.round(clicks);
      if (k + c > 0) this.events.push({ id: ulid(m + 500, this.rng), ts: m + 500, kind: "input", keys: k, clicks: c });
    }
    return [...this.events].sort((a, b) => a.ts - b.ts);
  }
}

// ---------- activities ----------

function claudeCode(b: DayBuilder, rng: Rng, minutes: number): void {
  b.focus(TERMINAL, `claude — ~/code/${REPO} — ${int(rng, 120, 160)}×${int(rng, 36, 48)}`);
  b.ocr(2, `> ${pick(rng, PROMPTS)}\nReading src/${pick(rng, FILES)}\nRunning bun test`);
  b.ocr(90, `✓ ${int(rng, 40, 180)} tests passed\n> ${pick(rng, PROMPTS)}`);
  b.work(minutes * 60, 18, 2);
}

function vscode(b: DayBuilder, rng: Rng, minutes: number): void {
  const until = b.t + minutes * 60_000;
  while (b.t < until) {
    b.focus(VSCODE, `${pick(rng, FILES)} — ${REPO}`);
    b.work(Math.min((until - b.t) / 1000, around(rng, 600, 240)), 70, 6);
  }
}

function notion(b: DayBuilder, minutes: number, doc: string): void {
  b.focus(NOTION, doc);
  b.ocr(2, `${doc}\nGoals\nOpen questions\nNext steps`);
  b.work(minutes * 60, 55, 5);
}

function standup(b: DayBuilder, rng: Rng): void {
  b.focus(ZOOM, "Zoom Meeting");
  b.ocr(3, "Zoom Meeting\nParticipants (5)\nMute  Stop Video  Share Screen");
  b.work(around(rng, 15, 2) * 60, 2, 1);
}

function meet(b: DayBuilder, rng: Rng, minutes: number): void {
  const name = pick(rng, ["Design review", "Sprint planning", "Weekly sync with Jordan", "Architecture sync"]);
  b.focus(CHROME, `Meet - ${name}`, `https://meet.google.com/${pick(rng, ["kfr-wpzq-tne", "hzm-qbdt-xao", "pvc-rrnk-ywe"])}`);
  b.work(minutes * 60, 3, 1);
}

function calendar(b: DayBuilder, rng: Rng): void {
  b.focus(CHROME, "Google Calendar - Week of October 12, 2026", "https://calendar.google.com/calendar/u/0/r/week");
  b.work(around(rng, 100, 30), 2, 6);
}

function sheetUpdate(b: DayBuilder, rng: Rng, which: "metrics" | "sprint"): void {
  if (which === "metrics") {
    b.focus(CHROME, "Team metrics - Google Sheets", METRICS_URL);
    b.ocr(1.5, `Week | Signups | Active | Churn\n${int(rng, 40, 44)} | ${int(rng, 300, 400)} | ${int(rng, 2000, 2600)} | ${int(rng, 1, 4)}`);
    b.work(Math.max(150, around(rng, 330, 60)), 50, 10);
  } else {
    b.focus(CHROME, "Sprint tracker - Google Sheets", SPRINT_URL);
    b.ocr(1.5, `Ticket | Owner | Status | Points\nATL-${int(rng, 100, 400)} | ${pick(rng, TEAM)} | In review | ${int(rng, 1, 5)}`);
    b.work(Math.max(120, around(rng, 260, 50)), 45, 12);
  }
}

function inbox(b: DayBuilder, rng: Rng, seconds: number): void {
  b.focus(CHROME, `Inbox (${int(rng, 2, 14)}) - ${ME} - Gmail`, `${MAIL_URL}#inbox`);
  b.ocr(1.5, `Inbox\n${pick(rng, TEAM)}  ${pick(rng, THREADS)}\n${pick(rng, TEAM)}  ${pick(rng, THREADS)}`);
  b.work(seconds, 3, 9);
}

function reply(b: DayBuilder, rng: Rng): void {
  const i = int(rng, 0, TEAM.length - 1);
  const thread = pick(rng, THREADS);
  b.focus(CHROME, `Re: ${thread} - ${ME} - Gmail`, `${MAIL_URL}#inbox/FMfcgz${int(rng, 100000, 999999)}`);
  b.ocr(2, `${TEAM[i]} <${TEAM_MAIL[i]}>\n${thread}\n\nThanks, looks good to me. One note on the second point below.`);
  b.work(Math.max(60, around(rng, 150, 40)), 90, 5);
}

function slack(b: DayBuilder, rng: Rng): void {
  const dm = rng() < 0.4;
  const who = pick(rng, TEAM);
  b.focus(SLACK, dm ? `${who} (DM) - Northwind - Slack` : `${pick(rng, CHANNELS)} (Channel) - Northwind - Slack`);
  b.ocr(1.5, `${who}: ${pick(rng, ["deploy is green", "can you look at the PR when you have a minute", "standup notes are in Notion", "the sync fix is out"])}`);
  b.work(around(rng, 90, 40), 40, 6);
}

function github(b: DayBuilder, rng: Rng, minutes: number): void {
  const until = b.t + minutes * 60_000;
  while (b.t < until) {
    const n = int(rng, 200, 320);
    b.focus(CHROME, `${pick(rng, PRS)} by ${pick(rng, ["jlee", "akim", "rpatel"])} · Pull Request #${n} · northwind/${REPO}`, `https://github.com/northwind/${REPO}/pull/${n}/files`);
    b.work(Math.min((until - b.t) / 1000, around(rng, 300, 120)), 12, 10);
  }
}

function reading(b: DayBuilder, rng: Rng, minutes: number): void {
  const until = b.t + minutes * 60_000;
  while (b.t < until) {
    const r = rng();
    if (r < 0.35) {
      const t = pick(rng, MDN);
      b.focus(CHROME, `${t} - JavaScript | MDN`, `https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/${t.replace(/[^A-Za-z]+/g, "_")}`);
    } else if (r < 0.6) {
      const t = pick(rng, SO);
      b.focus(CHROME, `${t} - Stack Overflow`, `https://stackoverflow.com/questions/${int(rng, 70000000, 79000000)}/${t.toLowerCase().replace(/[^a-z]+/g, "-")}`);
    } else if (r < 0.85) {
      b.focus(CHROME, "Hacker News", "https://news.ycombinator.com/");
    } else {
      const t = pick(rng, WIKI);
      b.focus(CHROME, `${t} - Wikipedia`, `https://en.wikipedia.org/wiki/${t.replace(/ /g, "_")}`);
    }
    b.work(Math.min((until - b.t) / 1000, around(rng, 180, 90)), 4, 6);
  }
}

function finder(b: DayBuilder, rng: Rng): void {
  if (rng() < 0.5) b.focus(FINDER, pick(rng, ["Downloads", "Documents", "Screenshots"]));
  else b.focus(PREVIEW, pick(rng, ["architecture.pdf", "receipt-october.pdf", "mockup-v3.png"]));
  b.work(around(rng, 120, 40), 2, 12);
}

function weekday(b: DayBuilder, rng: Rng, dayIndex: number): void {
  const doc = (k: number) => DOCS[(dayIndex * 3 + k) % DOCS.length]!;
  b.t += int(rng, 0, 15) * 60_000;
  slack(b, rng);
  inbox(b, rng, around(rng, 360, 60));
  calendar(b, rng);
  slack(b, rng);
  b.idle(around(rng, 240, 60));
  standup(b, rng);
  sheetUpdate(b, rng, "sprint");
  claudeCode(b, rng, int(rng, 36, 44));
  slack(b, rng);
  vscode(b, rng, int(rng, 40, 50));
  sheetUpdate(b, rng, "metrics");
  b.idle(around(rng, 300, 60));
  notion(b, int(rng, 30, 38), doc(0));
  reply(b, rng);
  reply(b, rng);
  b.idle(int(rng, 40, 55) * 60); // lunch
  slack(b, rng);
  calendar(b, rng);
  meet(b, rng, dayIndex % 2 === 0 ? int(rng, 45, 55) : int(rng, 28, 35));
  sheetUpdate(b, rng, "sprint");
  claudeCode(b, rng, int(rng, 32, 40));
  github(b, rng, int(rng, 24, 32));
  slack(b, rng);
  b.idle(around(rng, 240, 60));
  reading(b, rng, int(rng, 24, 32));
  sheetUpdate(b, rng, "metrics");
  reply(b, rng);
  notion(b, int(rng, 18, 24), doc(1));
  slack(b, rng);
  sheetUpdate(b, rng, "metrics");
  finder(b, rng);
  inbox(b, rng, around(rng, 300, 60));
  reply(b, rng);
  reply(b, rng);
  notion(b, int(rng, 12, 16), doc(2));
  slack(b, rng);
  reading(b, rng, int(rng, 10, 14));
}

function weekend(b: DayBuilder, rng: Rng, saturday: boolean): void {
  b.t += int(rng, 10, 11) * 3_600_000;
  if (saturday) {
    claudeCode(b, rng, int(rng, 35, 45));
    b.idle(around(rng, 600, 120));
    reading(b, rng, int(rng, 25, 32));
    slack(b, rng);
  } else {
    reading(b, rng, int(rng, 20, 26));
    notion(b, int(rng, 12, 16), "Reading list");
  }
}

// ---------- public API ----------

/** Local days, like the observer: `start` is local midnight and `at(h)` a local wall-clock time that day. */
function addDays(day: DayLabel, n: number): { label: DayLabel; start: number; weekday: number; at: (hours: number) => number } {
  const [y, m, d] = day.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`bad day ${day}`);
  const date = new Date(y, m - 1, d + n);
  const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const at = (hours: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(hours), Math.round((hours % 1) * 60)).getTime();
  return { label, start: date.getTime(), weekday: date.getDay(), at };
}

/** The neutral week: deterministic per seed, default 7 days from Mon 2026-10-12. */
export function generateNeutralWeek(opts: FixtureOptions = {}): FixtureDay[] {
  const seed = opts.seed ?? 42;
  const startDay = opts.startDay ?? "2026-10-12";
  const out: FixtureDay[] = [];
  for (let i = 0; i < (opts.days ?? 7); i++) {
    const { label, start, weekday: wd, at } = addDays(startDay, i);
    const rng = mulberry32(seed * 1000 + 500 + i);
    const b = new DayBuilder(rng, at(8.75));
    if (wd === 0 || wd === 6) {
      b.t = start;
      weekend(b, rng, wd === 6);
    } else weekday(b, rng, i);
    out.push({ day: label, events: b.end() });
  }
  return out;
}

function parseArgs(argv: readonly string[]): { out: string; seed: number; encrypted: boolean; start: DayLabel } {
  let out = "";
  let seed = 42;
  let encrypted = false;
  // Default: the 7 days ending yesterday, so the reader's 7-day rule keeps every generated day.
  const t = new Date(Date.now() - 7 * 86_400_000);
  let start = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--encrypted") encrypted = true;
    else if (a === "--start") start = argv[++i] ?? "";
    else throw new Error(`unknown argument ${a}`);
  }
  if (out === "") throw new Error("--out DIR is required");
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("--start must be YYYY-MM-DD");
  return { out, seed, encrypted, start };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const days = generateNeutralWeek({ seed: args.seed, startDay: args.start });
    writeFixture(args.out, days, { encrypted: args.encrypted, seed: args.seed });
    const n = days.reduce((s, d) => s + d.events.length, 0);
    console.log(`wrote ${days.length} days, ${n} events, ${args.encrypted ? "encrypted" : "plain"}, to ${args.out}`);
  } catch (err) {
    console.error(`gen-neutral: ${err instanceof Error ? err.message : String(err)}`);
    console.error("usage: bun run brain/fixtures/gen-neutral.ts --out DIR [--seed 42] [--encrypted] [--start YYYY-MM-DD]");
    process.exit(2);
  }
}
