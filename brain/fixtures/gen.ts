// Deterministic synthetic week for a founder, written in the observer's store format (docs/store-contract.md).
// Weekdays: ~100 investor outreach emails in Gmail (popout compose "New Message", ~3 min each, near-identical text,
// different partners at different funds), ~15 scheduling replies, ~10 CRM sheet updates, Slack, one Zoom call,
// Claude Code in Terminal, LinkedIn, idle gaps and lunch. Weekend: a little coding and browsing.
// Usage: bun run brain/fixtures/gen.ts --out DIR [--seed 42] [--encrypted] [--start 2026-10-12]
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_THRESHOLD_MS } from "../src/sessionize.ts";
import { encryptLine, KEY_BYTES, NONCE_BYTES } from "../src/store/crypto.ts";
import type { DayLabel, OffloadEvent } from "../src/types.ts";

export interface FixtureOptions {
  seed?: number;
  /** First day (YYYY-MM-DD). Default 2026-10-12, a Monday. */
  startDay?: DayLabel;
  days?: number;
}

export interface FixtureDay {
  day: DayLabel;
  events: OffloadEvent[];
}

// ---------- deterministic randomness ----------

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

// ---------- the founder's world ----------

const ME = "sam@acme.io";
const GMAIL = `${ME} - Gmail`;
const CHROME = "com.google.Chrome";
const SLACK = "com.tinyspeck.slackmacgap";
const ZOOM = "us.zoom.xos";
const TERMINAL = "com.apple.Terminal";
const APP_NAMES: Record<string, string> = { [CHROME]: "Google Chrome", [SLACK]: "Slack", [ZOOM]: "zoom.us", [TERMINAL]: "Terminal" };

interface Fund {
  name: string;
  domain: string;
  portfolio: string;
}

const FUNDS: readonly Fund[] = [
  ["Sequoia Capital", "sequoiacap.com", "Stripe"],
  ["Accel", "accel.com", "Atlassian"],
  ["Index Ventures", "indexventures.com", "Plaid"],
  ["Andreessen Horowitz", "a16z.com", "Mercury"],
  ["Benchmark", "benchmark.com", "Discord"],
  ["Greylock", "greylock.com", "Figma"],
  ["Lightspeed", "lsvp.com", "Rippling"],
  ["General Catalyst", "generalcatalyst.com", "Ramp"],
  ["First Round Capital", "firstround.com", "Notion"],
  ["Founders Fund", "foundersfund.com", "Brex"],
  ["Kleiner Perkins", "kleinerperkins.com", "Glean"],
  ["Bessemer Venture Partners", "bvp.com", "Toast"],
  ["Insight Partners", "insightpartners.com", "Pipe"],
  ["GV", "gv.com", "Gusto"],
  ["Balderton Capital", "balderton.com", "Revolut"],
  ["Atomico", "atomico.com", "Pleo"],
  ["Northzone", "northzone.com", "Spotify"],
  ["LocalGlobe", "localglobe.vc", "Wise"],
  ["Point Nine", "pointnine.com", "Zendesk"],
  ["Seedcamp", "seedcamp.com", "Pleo"],
  ["Frontline Ventures", "frontline.vc", "Pitch"],
  ["Creandum", "creandum.com", "Klarna"],
  ["Felix Capital", "felixcap.com", "Deliveroo"],
  ["Hoxton Ventures", "hoxtonventures.com", "Darktrace"],
  ["Notion Capital", "notion.vc", "GoCardless"],
  ["Cherry Ventures", "cherry.vc", "Flixbus"],
  ["Speedinvest", "speedinvest.com", "Wefox"],
  ["Earlybird", "earlybird.com", "N26"],
  ["Plural", "plural.vc", "Tide"],
  ["Mosaic Ventures", "mosaicventures.com", "Paddle"],
  ["Initialized Capital", "initialized.com", "Coinbase"],
  ["Precursor Ventures", "precursorvc.com", "Mercury"],
  ["Hustle Fund", "hustlefund.vc", "Deel"],
  ["Pear VC", "pear.vc", "Gusto"],
  ["Uncork Capital", "uncorkcapital.com", "Fitbit"],
  ["Felicis", "felicis.com", "Shopify"],
  ["Matrix Partners", "matrix.vc", "Zendesk"],
  ["Redpoint", "redpoint.com", "Stripe"],
  ["Emergence Capital", "emcap.com", "Zoom"],
  ["Spark Capital", "sparkcapital.com", "Slack"],
  ["Union Square Ventures", "usv.com", "Twilio"],
  ["CRV", "crv.com", "Airtable"],
  ["Khosla Ventures", "khoslaventures.com", "Square"],
  ["Battery Ventures", "battery.com", "Glassdoor"],
  ["IVP", "ivp.com", "Datadog"],
  ["Menlo Ventures", "menlovc.com", "Anthropic"],
  ["Costanoa", "costanoa.vc", "Alation"],
  ["Boldstart", "boldstart.vc", "Snyk"],
  ["Work-Bench", "work-bench.com", "Cockroach Labs"],
  ["8VC", "8vc.com", "Anduril"],
].map(([name, domain, portfolio]) => ({ name: name!, domain: domain!, portfolio: portfolio! }));

const FIRST = ["Jane", "Omar", "Priya", "Lucas", "Mei", "Daniel", "Sara", "Tom", "Aisha", "Ben", "Chloe", "Ravi", "Elena", "Marco", "Nina", "Felix", "Hana", "Kofi", "Laura", "Sven"];
const LAST = ["Doe", "Haddad", "Raman", "Silva", "Chen", "Park", "Okafor", "Berg", "Khan", "Novak", "Rossi", "Ito", "Meyer", "Adeyemi", "Larsen"];
const HOOKS = [
  (f: Fund) => `${f.name}'s investment in ${f.portfolio} is why I'm writing to you first.`,
  (f: Fund) => `Your team's bet on ${f.portfolio} is close to what we are building.`,
  (f: Fund) => `Given ${f.name} backed ${f.portfolio}, I think we fit your thesis.`,
];
const CHANNELS = ["general", "eng", "sales", "product", "random"];
const TEAM = ["Jordan Lee", "Alex Kim", "Riley Patel"];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TIMES = ["9:30am", "11am", "2pm", "3:30pm", "4pm"];

interface Contact {
  fund: Fund;
  first: string;
  last: string;
  email: string;
}

function contact(rng: Rng): Contact {
  const fund = pick(rng, FUNDS);
  const first = pick(rng, FIRST);
  const last = pick(rng, LAST);
  const email = rng() < 0.5 ? `${first.toLowerCase()}@${fund.domain}` : `${first.toLowerCase()}.${last.toLowerCase()}@${fund.domain}`;
  return { fund, first, last, email };
}

const subjectFor = (f: Fund) => `Acme seed round: ${f.name}`;

function outreachText(c: Contact, hook: number, stage: 1 | 2 | 3): string {
  const head = `To: ${c.email}\nSubject: ${subjectFor(c.fund)}\n\nHi ${c.first},`;
  if (stage === 1) return `New Message\nTo: ${c.email}\nSubject: ${subjectFor(c.fund)}`;
  const body =
    `\n\nI'm Sam, founder of Acme. We help finance teams close the books in two days instead of ten.\n` +
    `${HOOKS[hook]!(c.fund)}\n\n` +
    `We are raising a $3M seed round. Traction: $40k MRR, growing 18% month over month, 31 paying customers.\n\n` +
    `Would you be open to a 20 minute call next week? Deck attached.`;
  return stage === 2 ? head + body.slice(0, 120) : `${head}${body}\n\nBest,\nSam\nAcme | acme.io`;
}

// ---------- day builder ----------

interface Activity {
  start: number;
  end: number;
  kpm: number;
  cpm: number;
}

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

  /** OCR snapshot `offsetS` seconds from now (the observer OCRs on focus change and on text change). */
  ocr(offsetS: number, text: string): void {
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    this.push(this.t + Math.round(offsetS * 1000), { kind: "ocr", text, textHash });
  }

  /** Spend `seconds` on the current focus at the given keys and clicks per minute. */
  work(seconds: number, kpm: number, cpm: number): void {
    const ms = Math.max(1000, Math.round(seconds * 1000));
    this.activities.push({ start: this.t, end: this.t + ms, kpm, cpm });
    this.t += ms;
  }

  /**
   * No input for `seconds`. Like the observer, idle_start is stamped when idle is DETECTED (IDLE_THRESHOLD_MS after the
   * last input), and nothing is written for a pause shorter than the threshold (that time stays active).
   */
  idle(seconds: number): void {
    const ms = Math.round(seconds * 1000);
    if (ms >= IDLE_THRESHOLD_MS) {
      this.push(this.t + IDLE_THRESHOLD_MS, { kind: "idle_start" });
      this.push(this.t + ms, { kind: "idle_end" });
    }
    this.t += ms;
  }

  end(): FixtureDay["events"] {
    this.push(this.t + IDLE_THRESHOLD_MS, { kind: "idle_start" });
    // One input event per minute with counts only, at the minute mark (+0.5 s so it never ties a focus change).
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

const MAIL_URL = "https://mail.google.com/mail/u/0/";
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1xQ9pipeLineSheet42AbCdEf/edit";

function inbox(b: DayBuilder, rng: Rng, seconds: number): void {
  b.focus(CHROME, `Inbox (${int(rng, 3, 40)}) - ${GMAIL}`, `${MAIL_URL}#inbox`);
  const lines = Array.from({ length: 4 }, () => {
    const c = contact(rng);
    return `${c.first} ${c.last}  Re: ${subjectFor(c.fund)}  Thanks Sam, ${pick(rng, ["happy to chat", "passing for now", "looping in my partner", "send the deck"])}`;
  });
  b.ocr(1.5, `Inbox\n${lines.join("\n")}`);
  b.work(seconds, 2, 8);
}

function slackVisit(b: DayBuilder, rng: Rng): void {
  const dm = rng() < 0.4;
  const who = pick(rng, TEAM);
  b.focus(SLACK, dm ? `${who} (DM) - Acme - Slack` : `${pick(rng, CHANNELS)} (Channel) - Acme - Slack`);
  b.ocr(1.5, `${who}: ${pick(rng, ["shipped the billing fix", "customer call notes are in the doc", "new signup from a logistics company", "standup moved to the afternoon"])}`);
  b.work(around(rng, 75, 35), 45, 6);
}

function outreachEmail(b: DayBuilder, rng: Rng): void {
  const c = contact(rng);
  const hook = int(rng, 0, HOOKS.length - 1);
  const total = Math.min(240, Math.max(140, around(rng, 180, 25)));
  b.focus(CHROME, "New Message", MAIL_URL);
  b.ocr(2, outreachText(c, hook, 1));
  b.ocr(40, outreachText(c, hook, 2));
  if (rng() < 0.08) {
    // Interrupted mid-email by a Slack DM, then back to the same draft.
    const first = around(rng, 85, 10);
    b.work(first, 160, 3);
    b.focus(SLACK, `${pick(rng, TEAM)} (DM) - Acme - Slack`);
    b.ocr(1.5, `${pick(rng, TEAM)}: quick one, can you approve the invoice?`);
    b.work(around(rng, 25, 4), 30, 2);
    b.focus(CHROME, "New Message", MAIL_URL);
    b.ocr(1.5, outreachText(c, hook, 3));
    b.work(total - first, 160, 3);
  } else {
    b.ocr(120, outreachText(c, hook, 3));
    b.work(total, 160, 3);
  }
  inbox(b, rng, around(rng, 18, 5));
}

function schedulingReply(b: DayBuilder, rng: Rng): void {
  const c = contact(rng);
  b.focus(CHROME, `Re: ${subjectFor(c.fund)} - ${GMAIL}`, `${MAIL_URL}#inbox/FMfcgz${int(rng, 100000, 999999)}`);
  const [d1, d2] = [pick(rng, WEEKDAYS), pick(rng, WEEKDAYS)];
  b.ocr(
    2,
    `${c.first} ${c.last} <${c.email}>\nThanks Sam, happy to find a time.\n\n` +
      `Thanks ${c.first}! Does ${d1} at ${pick(rng, TIMES)} or ${d2} at ${pick(rng, TIMES)} work for you? I'll send a calendar invite with a Zoom link.`,
  );
  b.work(Math.max(70, around(rng, 125, 30)), 110, 6);
}

function crmUpdate(b: DayBuilder, rng: Rng): void {
  const c = contact(rng);
  b.focus(CHROME, "Investor pipeline - Google Sheets", SHEET_URL);
  b.ocr(1.5, `Fund | Partner | Stage | Next step\n${c.fund.name} | ${c.first} ${c.last} | Call booked | Send deck`);
  b.work(Math.max(35, around(rng, 60, 15)), 55, 10);
}

function zoomCall(b: DayBuilder, rng: Rng, minutes: number): void {
  b.focus(CHROME, "Google Calendar - Week of October 12, 2026", "https://calendar.google.com/calendar/u/0/r/week");
  b.work(around(rng, 20, 5), 0, 3);
  b.focus(ZOOM, "Zoom Meeting");
  b.ocr(3, "Zoom Meeting\nParticipants (3)\nMute  Stop Video  Share Screen  Record");
  b.work(minutes * 60, 4, 1);
}

function claudeCode(b: DayBuilder, rng: Rng, minutes: number): void {
  b.focus(TERMINAL, `claude — ~/builds/acme-app — ${int(rng, 120, 160)}×${int(rng, 36, 48)}`);
  b.ocr(2, `> ${pick(rng, ["fix the failing test in billing.ts", "add CSV export to the ledger view", "why is the sync job slow"])}\nReading src/billing.ts\nRunning bun test`);
  b.work(minutes * 60, 22, 2);
}

function linkedin(b: DayBuilder, rng: Rng, minutes: number): void {
  const until = b.t + minutes * 60_000;
  while (b.t < until) {
    if (rng() < 0.5) b.focus(CHROME, `${rng() < 0.3 ? `(${int(rng, 1, 9)}) ` : ""}Feed | LinkedIn`, "https://www.linkedin.com/feed/");
    else {
      const c = contact(rng);
      b.focus(CHROME, `${c.first} ${c.last} | LinkedIn`, `https://www.linkedin.com/in/${c.first.toLowerCase()}-${c.last.toLowerCase()}/`);
    }
    b.work(around(rng, 60, 30), 3, 5);
  }
}

function outreachBlock(b: DayBuilder, rng: Rng, emails: number, schedulingEvery: number, quota: { sched: number; crm: number }): void {
  for (let i = 1; i <= emails; i++) {
    outreachEmail(b, rng);
    if (i % schedulingEvery === 0 && quota.sched > 0) {
      schedulingReply(b, rng);
      quota.sched--;
      if (quota.crm > 0 && rng() < 0.75) {
        crmUpdate(b, rng);
        quota.crm--;
      }
    }
  }
}

function weekday(b: DayBuilder, rng: Rng): void {
  b.t += int(rng, 0, 10) * 60_000;
  for (let i = 0; i < 4; i++) slackVisit(b, rng);
  inbox(b, rng, around(rng, 280, 40));
  const quota = { sched: 15, crm: 10 };
  outreachBlock(b, rng, int(rng, 33, 36), 8, quota);
  b.idle(around(rng, 200, 60));
  zoomCall(b, rng, int(rng, 25, 35));
  outreachBlock(b, rng, int(rng, 29, 32), 7, quota);
  b.idle(int(rng, 40, 55) * 60); // lunch
  for (let i = 0; i < 3; i++) slackVisit(b, rng);
  outreachBlock(b, rng, int(rng, 33, 36), 8, quota);
  b.idle(around(rng, 180, 60));
  claudeCode(b, rng, int(rng, 17, 23));
  while (quota.sched > 0) {
    schedulingReply(b, rng);
    quota.sched--;
  }
  while (quota.crm > 0) {
    crmUpdate(b, rng);
    quota.crm--;
  }
  linkedin(b, rng, int(rng, 6, 10));
  for (let i = 0; i < 2; i++) slackVisit(b, rng);
}

function weekend(b: DayBuilder, rng: Rng, saturday: boolean): void {
  b.t += int(rng, 9, 11) * 3_600_000;
  if (saturday) {
    claudeCode(b, rng, int(rng, 35, 45));
    b.idle(around(rng, 300, 60));
  }
  linkedin(b, rng, int(rng, 8, 12));
  slackVisit(b, rng);
}

// ---------- public API ----------

/** Local days, like the observer (s09b): `start` is LOCAL midnight and `label` the local date. Before s09b this used
 * Date.UTC, so the fixture's 08:30 morning was 08:30 UTC (04:30 in Toronto, 13:30 in Karachi) and the timeline showed
 * the week shifted by the zone's offset. `at(h)` is a local wall-clock time on that day (DST-safe). */
function addDays(day: DayLabel, n: number): { label: DayLabel; start: number; weekday: number; at: (hours: number) => number } {
  const [y, m, d] = day.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`bad day ${day}`);
  const date = new Date(y, m - 1, d + n);
  const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const at = (hours: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(hours), Math.round((hours % 1) * 60)).getTime();
  return { label, start: date.getTime(), weekday: date.getDay(), at };
}

export function generateFixture(opts: FixtureOptions = {}): FixtureDay[] {
  const seed = opts.seed ?? 42;
  const startDay = opts.startDay ?? "2026-10-12";
  const out: FixtureDay[] = [];
  for (let i = 0; i < (opts.days ?? 7); i++) {
    const { label, start, weekday: wd, at } = addDays(startDay, i);
    const rng = mulberry32(seed * 1000 + i);
    const b = new DayBuilder(rng, at(8.5));
    if (wd === 0 || wd === 6) {
      b.t = start;
      weekend(b, rng, wd === 6);
    } else weekday(b, rng);
    out.push({ day: label, events: b.end() });
  }
  return out;
}

/** Writes days into `$home/days` (and `$home/keys` when encrypted). Keys and nonces come from the seed: fixtures only. */
export function writeFixture(home: string, days: readonly FixtureDay[], opts: { encrypted: boolean; seed: number }): void {
  mkdirSync(join(home, "days"), { recursive: true });
  if (opts.encrypted) mkdirSync(join(home, "keys"), { recursive: true });
  days.forEach((d, i) => {
    const plainPath = join(home, "days", `${d.day}.jsonl`);
    const encPath = join(home, "days", `${d.day}.jsonl.enc`);
    if (!opts.encrypted) {
      if (existsSync(encPath)) rmSync(encPath);
      writeFileSync(plainPath, d.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      return;
    }
    if (existsSync(plainPath)) rmSync(plainPath);
    const rng = mulberry32(opts.seed * 7919 + i);
    const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(rng() * 256)));
    const key = bytes(KEY_BYTES);
    const keyPath = join(home, "keys", `${d.day}.key`);
    writeFileSync(keyPath, key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(encPath, d.events.map((e) => encryptLine(key, JSON.stringify(e), bytes(NONCE_BYTES))).join("\n") + "\n");
  });
}

function parseArgs(argv: readonly string[]): { out: string; seed: number; encrypted: boolean; start: DayLabel } {
  let out = "";
  let seed = 42;
  let encrypted = false;
  // Default: the 7 days ending yesterday, so the reader's 7-day rule keeps every generated day (REVIEW-1 M4).
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
    const days = generateFixture({ seed: args.seed, startDay: args.start });
    writeFixture(args.out, days, { encrypted: args.encrypted, seed: args.seed });
    const n = days.reduce((s, d) => s + d.events.length, 0);
    console.log(`wrote ${days.length} days, ${n} events, ${args.encrypted ? "encrypted" : "plain"}, to ${args.out}`);
  } catch (err) {
    console.error(`gen: ${err instanceof Error ? err.message : String(err)}`);
    console.error("usage: bun run brain/fixtures/gen.ts --out DIR [--seed 42] [--encrypted] [--start YYYY-MM-DD]");
    process.exit(2);
  }
}
