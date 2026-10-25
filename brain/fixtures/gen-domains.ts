// s12: deterministic synthetic weeks for people in different fields, written in the observer's store format plus the
// frame notes a stub Captioner would produce (schemas/frame-note.schema.json), and a ground-truth file per persona.
// gen.ts (the founder week) is not touched; this file has its own small builder so both can change independently.
//
// Personas (each 7 local days, weekdays full, weekend light):
//   recruiter   reads candidate CVs (PDF in Preview) and writes a scorecard in Greenhouse          role Recruiter
//   bookkeeper  reads supplier invoice PDFs and keys each bill into Xero; also reconciles the bank  role Bookkeeper
//   support     triages Zendesk tickets with macro replies, looks some orders up in Shopify       role Support agent
//   salesops    enriches lead rows in a Google Sheet from LinkedIn profiles (and company sites)   role Sales ops
//   mixed       an operations manager doing both invoices into Xero and Zendesk tickets
// Every persona also has noise: meetings (calendar + Zoom), Slack, Gmail inbox reading, web browsing, lunch.
//
// Layout under --out DIR: <persona>/days/<day>.jsonl[.enc], <persona>/keys/<day>.key (encrypted only),
// <persona>/frames/<day>.jsonl[.enc] (frame notes, encrypted with the same day key), <persona>/truth.json.
// Usage: bun run brain/fixtures/gen-domains.ts --out DIR [--seed 7] [--persona NAME|all] [--encrypted] [--start YYYY-MM-DD]
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDLE_THRESHOLD_MS } from "../src/sessionize.ts";
import { encryptLine, KEY_BYTES, NONCE_BYTES } from "../src/store/crypto.ts";
import type { DayLabel, OffloadEvent } from "../src/types.ts";
import type { FrameNote } from "../src/understanding/frames.ts";

export const PERSONAS = ["recruiter", "bookkeeper", "support", "salesops", "mixed"] as const;
export type PersonaId = (typeof PERSONAS)[number];

export interface TruthTask {
  label: string;
  name: string;
  /** Planned share of active time (0..1), accounted exactly like sessionize counts active time. */
  share: number;
  instances: number;
  /** Bundle ids / hosts the task happens in (every one must show up in the insight's surfaces). */
  apps: string[];
}

export interface Truth {
  persona: PersonaId;
  role: string;
  industry: string;
  startDay: DayLabel;
  days: number;
  topTask: TruthTask;
  /** Mixed persona: the other real task; the top two insights are these two, in either order. */
  second?: TruthTask;
  tasks: Record<string, TruthTask>;
  /** Ground-truth task label of every focus event (the event that starts a span). */
  focusLabels: Record<string, string>;
  frameCount: number;
  eventCount: number;
}

export interface PersonaWeek {
  days: Array<{ day: DayLabel; events: OffloadEvent[] }>;
  frames: Map<DayLabel, FrameNote[]>;
  truth: Truth;
}

// ---------- deterministic randomness ----------

type Rng = () => number;

function mulberry32(seed: number): Rng {
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

// ---------- apps ----------

const CHROME = "com.google.Chrome";
const PREVIEW = "com.apple.Preview";
const SLACK = "com.tinyspeck.slackmacgap";
const ZOOM = "us.zoom.xos";
const APP_NAMES: Record<string, string> = { [CHROME]: "Google Chrome", [PREVIEW]: "Preview", [SLACK]: "Slack", [ZOOM]: "zoom.us" };

type FrameFields = Omit<FrameNote, "id" | "ts" | "kind" | "frameId" | "model" | "app" | "host" | "phash">;

/** One step of a stub-captioner script: wording varies the way a real model's would, the facts do not. */
interface FrameSpec {
  activity: readonly string[];
  verb: readonly string[];
  object: readonly string[];
  surface: string;
  step: string;
  counterpart?: string;
  inputs?: string[];
  outputs?: string[];
  identifiers?: string[];
}

// ---------- day builder ----------

class DayBuilder {
  readonly events: OffloadEvent[] = [];
  readonly frames: FrameNote[] = [];
  readonly focusLabels: Record<string, string> = {};
  readonly activeMs = new Map<string, number>();
  readonly instances = new Map<string, number>();
  private readonly activities: Array<{ start: number; end: number; kpm: number; cpm: number }> = [];
  private label = "";
  private app = "";
  private host: string | undefined;
  readonly dayStart: number;

  constructor(
    private readonly rng: Rng,
    public t: number,
  ) {
    this.dayStart = t;
  }

  private push(ts: number, e: Omit<OffloadEvent, "id" | "ts">): string {
    const id = ulid(ts, this.rng);
    this.events.push({ id, ts, ...e } as OffloadEvent);
    return id;
  }

  /** Starts one occurrence of a ground-truth task. */
  instance(label: string): void {
    this.instances.set(label, (this.instances.get(label) ?? 0) + 1);
  }

  focus(label: string, app: string, title: string, url = ""): void {
    const host = url === "" ? undefined : new URL(url).host;
    const id = this.push(this.t, { kind: "focus", app, appName: APP_NAMES[app] ?? app, title, ...(url === "" ? {} : { url, host }) });
    this.focusLabels[id] = label;
    this.label = label;
    this.app = app;
    this.host = host;
  }

  ocr(offsetS: number, text: string): void {
    const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    this.push(this.t + Math.round(offsetS * 1000), { kind: "ocr", text, textHash });
  }

  /** A stub-captioner frame note `offsetS` seconds from now. ~5% of frames are low-confidence and vague. */
  frame(offsetS: number, spec: FrameSpec): void {
    const ts = this.t + Math.round(offsetS * 1000);
    const vague = this.rng() < 0.05;
    const canonical = (list: readonly string[]) => (this.rng() < 0.85 ? list[0]! : pick(this.rng, list));
    const fields: FrameFields = vague
      ? { activity: "Looking at the screen", verb: "view", surface: spec.surface, confidence: 0.3 }
      : {
          activity: pick(this.rng, spec.activity),
          verb: canonical(spec.verb),
          object: canonical(spec.object),
          surface: spec.surface,
          step: spec.step,
          ...(spec.counterpart === undefined ? {} : { counterpart: spec.counterpart }),
          ...(spec.inputs === undefined ? {} : { inputs: spec.inputs }),
          ...(spec.outputs === undefined ? {} : { outputs: spec.outputs }),
          ...(spec.identifiers === undefined || spec.identifiers.length === 0 ? {} : { identifiers: spec.identifiers }),
          confidence: Math.round((0.75 + this.rng() * 0.2) * 100) / 100,
        };
    const id = ulid(ts, this.rng);
    const phash = Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(this.rng() * 16)]).join("");
    this.frames.push({ id, ts, kind: "frame", frameId: `kf_${id.toLowerCase()}`, phash, app: this.app, ...(this.host === undefined ? {} : { host: this.host }), model: "stub", ...fields });
  }

  private credit(ms: number): void {
    this.activeMs.set(this.label, (this.activeMs.get(this.label) ?? 0) + ms);
  }

  work(seconds: number, kpm: number, cpm: number): void {
    const ms = Math.max(1000, Math.round(seconds * 1000));
    this.activities.push({ start: this.t, end: this.t + ms, kpm, cpm });
    this.credit(ms);
    this.t += ms;
  }

  /** No input. At or above the observer threshold this is idle (not active); below it the time stays active. */
  idle(seconds: number): void {
    const ms = Math.round(seconds * 1000);
    if (ms >= IDLE_THRESHOLD_MS) {
      this.push(this.t + IDLE_THRESHOLD_MS, { kind: "idle_start" });
      this.push(this.t + ms, { kind: "idle_end" });
    } else this.credit(ms);
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
    return [...this.events].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
  }
}

// ---------- shared world ----------

const FIRST = ["Amara", "Bilal", "Chen", "Dara", "Elif", "Farah", "Goran", "Hana", "Ivan", "Jonas", "Keiko", "Lena", "Mateo", "Nia", "Omar", "Priya", "Quinn", "Rosa", "Sven", "Tariq", "Uma", "Viktor", "Wen", "Yara", "Zane"];
const LAST = ["Okafor", "Haddad", "Novak", "Silva", "Lindqvist", "Mensah", "Petrov", "Tanaka", "Moreau", "Kowalski", "Ibrahim", "Fischer", "Rossi", "Nakamura", "Osei", "Varga", "Dubois", "Kaya", "Larsen", "Reyes"];
const COMPANIES = [
  ["Northwind Logistics", "northwind-logistics.com"],
  ["Bluefin Analytics", "bluefin.io"],
  ["Cedar Health", "cedarhealth.com"],
  ["Harbor Freight Labs", "harborlabs.co"],
  ["Lumen Retail", "lumenretail.com"],
  ["Quarry Software", "quarry.dev"],
  ["Tidewater Foods", "tidewaterfoods.com"],
  ["Orbit Payments", "orbitpay.com"],
  ["Granite Insurance", "graniteins.com"],
  ["Vela Robotics", "velarobotics.ai"],
  ["Summit Legal", "summitlegal.com"],
  ["Pinecone Travel", "pinecone.travel"],
] as const;
const SUPPLIERS = ["Acme Office Supply", "Brightline Couriers", "Metro Cleaning Co", "Delta Packaging", "Evergreen Utilities", "Falcon IT Services", "Gold Coast Catering", "Hilltop Print"];
const TEAM = ["Sam", "Ana", "Kofi", "Lea", "Raj"];

const person = (rng: Rng) => ({ first: pick(rng, FIRST), last: pick(rng, LAST) });

function slackVisit(b: DayBuilder, rng: Rng, org: string): void {
  b.instance("slack");
  const ch = pick(rng, ["#general", "#team", "#random", "#ops"]);
  b.focus("slack", SLACK, `${ch} (Channel) - ${org} - Slack`);
  b.ocr(1.5, `${pick(rng, TEAM)}: ${pick(rng, ["standup moved to 2pm", "lunch order is in", "who has the projector", "new hire starts monday", "reminder: timesheets due friday"])}`);
  b.frame(2, {
    activity: ["Reading and replying to team messages in Slack", "Catching up on a Slack channel", "Chatting with the team in Slack"],
    verb: ["read", "chat"],
    object: ["team message", "message"],
    surface: "Slack channel",
    step: "catching up on the channel",
  });
  b.work(Math.max(20, around(rng, 80, 35)), 40, 6);
}

function inboxRead(b: DayBuilder, rng: Rng, me: string): void {
  b.instance("mail");
  b.focus("mail", CHROME, `Inbox (${int(rng, 2, 30)}) - ${me} - Gmail`, "https://mail.google.com/mail/u/0/#inbox");
  b.ocr(1.5, `Inbox\n${pick(rng, SUPPLIERS)}  Your statement is ready\n${pick(rng, TEAM)}  Re: plan for next week`);
  b.frame(2, {
    activity: ["Reading new mail in the Gmail inbox", "Skimming the inbox", "Checking email in Gmail"],
    verb: ["read", "skim"],
    object: ["email", "inbox"],
    surface: "Gmail inbox",
    step: "reading new mail",
  });
  b.work(Math.max(25, around(rng, 90, 40)), 6, 10);
}

function meeting(b: DayBuilder, rng: Rng, minutes: number): void {
  b.instance("meeting");
  b.focus("meeting", CHROME, "Google Calendar - Week", "https://calendar.google.com/calendar/u/0/r/week");
  b.frame(2, { activity: ["Checking the calendar before a meeting"], verb: ["check"], object: ["calendar"], surface: "Google Calendar week view", step: "finding the next meeting" });
  b.work(Math.max(15, around(rng, 20, 5)), 0, 3);
  b.focus("meeting", ZOOM, "Zoom Meeting");
  b.ocr(3, "Zoom Meeting\nParticipants (4)\nMute  Stop Video  Share Screen");
  b.frame(5, { activity: ["In a video call with colleagues", "Attending a team meeting on Zoom"], verb: ["attend"], object: ["meeting"], surface: "Zoom meeting window", step: "in the call" });
  b.frame(minutes * 30, { activity: ["In a video call with colleagues"], verb: ["attend"], object: ["meeting"], surface: "Zoom meeting window", step: "in the call" });
  b.work(minutes * 60, 3, 1);
}

const NEWS = [
  ["https://www.theguardian.com/world/2026/oct/14/markets-steady", "Markets steady as rates hold | The Guardian"],
  ["https://www.bbc.com/news/business-71234567", "Retail sales rise in September - BBC News"],
  ["https://news.ycombinator.com/item?id=41234567", "Show HN: a tiny database | Hacker News"],
] as const;

function browse(b: DayBuilder, rng: Rng): void {
  b.instance("browse");
  const [url, title] = pick(rng, NEWS);
  b.focus("browse", CHROME, `${title} - Google Chrome`, url);
  b.frame(2, { activity: ["Reading a news article", "Browsing the news"], verb: ["read", "browse"], object: ["news article", "article"], surface: "news website", step: "reading" });
  b.work(Math.max(30, around(rng, 150, 60)), 4, 8);
}

function noiseBreak(b: DayBuilder, rng: Rng, org: string, me: string): void {
  const r = rng();
  if (r < 0.45) slackVisit(b, rng, org);
  else if (r < 0.75) inboxRead(b, rng, me);
  else browse(b, rng);
}

// ---------- recruiter ----------

function cvScreen(b: DayBuilder, rng: Rng, org: string): void {
  b.instance("screen");
  const p = person(rng);
  const id = int(rng, 10000, 99999);
  const file = `CV - ${p.first} ${p.last}.pdf`;
  const job = pick(rng, ["Senior Backend Engineer", "Product Designer", "Data Analyst", "Account Executive"]);
  const ids = [file.toLowerCase()];
  b.focus("screen", PREVIEW, file);
  b.ocr(1.5, `${p.first} ${p.last}\nExperience\n${pick(rng, ["Stripe", "Shopify", "Monzo", "Atlassian"])} 2021-2025\nSkills: ${pick(rng, ["Go, Postgres", "Figma, research", "SQL, dbt", "SaaS sales"])}`);
  const read: FrameSpec = {
    activity: ["Reading a candidate CV against the job spec", "Reviewing a candidate's resume", "Screening a CV for the open role"],
    verb: ["review", "read", "screen"],
    object: ["CV", "resume"],
    counterpart: "candidate",
    surface: "Preview PDF viewer",
    step: "reading work history and skills",
    inputs: [`job spec: ${job}`],
    identifiers: ids,
  };
  b.frame(2, read);
  b.frame(30, read);
  b.work(Math.max(45, around(rng, 95, 30)), 2, 9);
  if (rng() < 0.1) slackVisit(b, rng, org);
  b.focus("screen", CHROME, `${p.first} ${p.last} - ${job} - Greenhouse`, `https://app.greenhouse.io/people/${id}/applications/${id + 3}`);
  b.ocr(1.5, `${p.first} ${p.last}\nApplication: ${job}\nResume: ${file}\nScorecard  Move stage`);
  const write: FrameSpec = {
    activity: ["Writing a scorecard and moving the candidate to the next stage in Greenhouse", "Updating the candidate in the ATS", "Filling in the Greenhouse scorecard"],
    verb: ["update", "fill in"],
    object: ["candidate record", "scorecard"],
    counterpart: "candidate",
    surface: "Greenhouse candidate page",
    step: "writing the scorecard and moving the stage",
    outputs: ["scorecard", "stage change"],
    identifiers: [...ids, `greenhouse ${id}`],
  };
  b.frame(2, write);
  b.frame(20, write);
  b.work(Math.max(30, around(rng, 65, 20)), 110, 10);
}

function recruiterDay(b: DayBuilder, rng: Rng, weekday: boolean): void {
  const org = "Talentry";
  const me = "jo@talentry.co";
  if (!weekday) {
    slackVisit(b, rng, org);
    browse(b, rng);
    return;
  }
  inboxRead(b, rng, me);
  for (let i = 0; i < 2; i++) slackVisit(b, rng, org);
  for (let block = 0; block < 4; block++) {
    const n = int(rng, 9, 11);
    for (let i = 0; i < n; i++) {
      cvScreen(b, rng, org);
      if (rng() < 0.15) noiseBreak(b, rng, org, me);
      if (rng() < 0.2) b.idle(around(rng, 40, 15));
    }
    if (block === 1) {
      b.idle(around(rng, 2700, 300));
      meeting(b, rng, 30);
    } else if (block === 2) meeting(b, rng, int(rng, 20, 30));
    else noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
  browse(b, rng);
}

// ---------- bookkeeper ----------

function invoiceEntry(b: DayBuilder, rng: Rng, org: string, me: string): void {
  b.instance("invoice");
  const supplier = pick(rng, SUPPLIERS);
  const inv = `INV-${int(rng, 10000, 99999)}`;
  const amount = (int(rng, 4000, 250000) / 100).toFixed(2);
  const ids = [inv.toLowerCase(), supplier.toLowerCase()];
  b.focus("invoice", PREVIEW, `${inv} ${supplier}.pdf`);
  b.ocr(1.5, `${supplier}\nInvoice ${inv}\nAmount due ${amount}\nDue in 30 days`);
  const read: FrameSpec = {
    activity: ["Reading a supplier invoice PDF", "Checking the amount and due date on an invoice", "Looking over a supplier invoice"],
    verb: ["read", "check"],
    object: ["supplier invoice", "invoice"],
    counterpart: supplier,
    surface: "Preview PDF viewer",
    step: "reading supplier, amount and due date",
    inputs: ["invoice number", "amount", "due date"],
    identifiers: ids,
  };
  b.frame(2, read);
  b.work(Math.max(25, around(rng, 45, 15)), 1, 6);
  if (rng() < 0.08) slackVisit(b, rng, org);
  b.focus("invoice", CHROME, "New Bill | Xero", "https://go.xero.com/AccountsPayable/Edit.aspx");
  b.ocr(1.5, `New Bill\nFrom ${supplier}\nReference ${inv}\nTotal ${amount}`);
  const enter: FrameSpec = {
    activity: ["Keying a supplier bill into Xero", "Entering an invoice as a bill in Xero", "Copying invoice details into the Xero bill form"],
    verb: ["enter", "key in"],
    object: ["bill", "supplier bill"],
    counterpart: supplier,
    surface: "Xero new bill form",
    step: "copying amount and due date from the PDF into the form",
    outputs: ["draft bill"],
    identifiers: ids,
  };
  b.frame(2, enter);
  b.frame(40, enter);
  b.work(Math.max(50, around(rng, 105, 30)), 130, 14);
  void me;
}

function reconcile(b: DayBuilder, rng: Rng): void {
  b.instance("reconcile");
  b.focus("reconcile", CHROME, "Reconcile Business Account | Xero", "https://go.xero.com/Bank/BankRec.aspx");
  b.ocr(1.5, "Reconcile\nStatement lines  Match  Create  Transfer\nOK");
  const spec: FrameSpec = {
    activity: ["Matching bank statement lines to transactions in Xero", "Reconciling the bank feed in Xero"],
    verb: ["match", "reconcile"],
    object: ["bank transaction", "statement line"],
    surface: "Xero bank reconciliation",
    step: "matching statement lines",
  };
  b.frame(2, spec);
  b.frame(100, spec);
  b.work(Math.max(120, around(rng, 300, 60)), 20, 30);
}

function bookkeeperDay(b: DayBuilder, rng: Rng, weekday: boolean): void {
  const org = "Ledgerly";
  const me = "pat@ledgerly.co";
  if (!weekday) {
    inboxRead(b, rng, me);
    browse(b, rng);
    return;
  }
  inboxRead(b, rng, me);
  slackVisit(b, rng, org);
  for (let block = 0; block < 4; block++) {
    const n = int(rng, 6, 8);
    for (let i = 0; i < n; i++) {
      invoiceEntry(b, rng, org, me);
      if (rng() < 0.15) noiseBreak(b, rng, org, me);
      if (rng() < 0.2) b.idle(around(rng, 40, 15));
    }
    if (block === 0 || block === 2) for (let r = 0; r < 2; r++) reconcile(b, rng);
    if (block === 1) {
      b.idle(around(rng, 2700, 300));
      meeting(b, rng, 30);
    } else noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
}

// ---------- support ----------

const TICKET_SUBJECTS = ["Where is my order?", "Refund request", "Wrong size delivered", "Change shipping address", "Discount code not working", "Item arrived damaged"];

function ticket(b: DayBuilder, rng: Rng, org: string): void {
  b.instance("ticket");
  const id = int(rng, 100000, 999999);
  const subject = pick(rng, TICKET_SUBJECTS);
  const order = rng() < 0.35 ? int(rng, 1000, 9999) : null;
  const ids = [`ticket #${id}`, ...(order === null ? [] : [`order #${order}`])];
  const title = `Ticket #${id}: ${subject} - Acme Support - Zendesk`;
  const url = `https://acme.zendesk.com/agent/tickets/${id}`;
  b.focus("ticket", CHROME, title, url);
  b.ocr(1.5, `${subject}\nCustomer: Hi, ${pick(rng, ["my order has not arrived", "I want my money back", "the shirt is too small", "please send to my new address"])}${order === null ? "" : ` (order #${order})`}`);
  b.frame(2, {
    activity: ["Reading a customer ticket in Zendesk", "Triaging a new support ticket", "Reading the customer's message"],
    verb: ["read", "triage"],
    object: ["support ticket", "ticket"],
    counterpart: "customer",
    surface: "Zendesk ticket view",
    step: "reading the customer's message",
    identifiers: ids,
  });
  const reply: FrameSpec = {
    activity: ["Applying a macro reply to the ticket and editing it", "Answering the ticket with a macro", "Sending a templated reply to the customer"],
    verb: ["reply", "answer"],
    object: ["support ticket", "ticket"],
    counterpart: "customer",
    surface: "Zendesk ticket view",
    step: "applying the macro and editing the reply",
    outputs: ["public reply", "ticket solved"],
    identifiers: ids,
  };
  if (order === null) {
    b.frame(35, reply);
    b.work(Math.max(40, around(rng, 85, 25)), 75, 12);
    return;
  }
  b.work(Math.max(15, around(rng, 30, 8)), 10, 6);
  b.focus("ticket", CHROME, `Order #${order} · Acme · Shopify`, `https://admin.shopify.com/store/acme/orders/${order}`);
  b.frame(2, {
    activity: ["Looking up the customer's order in Shopify", "Checking the order status in Shopify admin"],
    verb: ["look up", "check"],
    object: ["order", "customer order"],
    counterpart: "customer",
    surface: "Shopify order page",
    step: "checking order status and tracking",
    identifiers: [`order #${order}`],
  });
  b.work(Math.max(20, around(rng, 35, 10)), 4, 8);
  b.focus("ticket", CHROME, title, url);
  b.frame(2, reply);
  b.work(Math.max(30, around(rng, 60, 20)), 85, 10);
  void org;
}

function supportDay(b: DayBuilder, rng: Rng, weekday: boolean): void {
  const org = "Acme";
  const me = "kim@acme-shop.com";
  if (!weekday) {
    slackVisit(b, rng, org);
    browse(b, rng);
    return;
  }
  slackVisit(b, rng, org);
  inboxRead(b, rng, me);
  for (let block = 0; block < 4; block++) {
    const n = int(rng, 10, 13);
    for (let i = 0; i < n; i++) {
      ticket(b, rng, org);
      if (rng() < 0.18) noiseBreak(b, rng, org, me);
      if (rng() < 0.2) b.idle(around(rng, 40, 15));
    }
    if (block === 1) {
      b.idle(around(rng, 2700, 300));
      meeting(b, rng, 25);
    } else noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
}

// ---------- sales ops ----------

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1LeadsQ4xYzAbCdEf0123/edit";

interface Lead {
  row: number;
  company: string;
  domain: string;
  first: string;
  last: string;
}

function leadIds(l: Lead): string[] {
  return [l.company.toLowerCase(), `row ${l.row}`];
}

/** One lead: the sheet span types the previous lead's result and reads this row; LinkedIn (and sometimes the
 * company site) is looked up. The sheet span belongs to this lead's instance in the ground truth. */
function enrichLead(b: DayBuilder, rng: Rng, prev: Lead | null, lead: Lead): void {
  b.instance("enrich");
  b.focus("enrich", CHROME, "Leads Q4 - Google Sheets", SHEET_URL);
  if (prev !== null) {
    b.frame(2, {
      activity: ["Typing a job title and email into a lead row", "Filling in the enriched fields for a lead", "Updating a lead row in the sheet"],
      verb: ["update", "fill in"],
      object: ["lead row", "row"],
      counterpart: prev.company,
      surface: "Google Sheets lead list",
      step: "typing title and email into the row",
      outputs: ["job title", "work email"],
      identifiers: leadIds(prev),
    });
    b.work(Math.max(12, around(rng, 25, 8)), 130, 6);
  }
  b.frame(1, {
    activity: ["Reading the next lead row in the sheet", "Picking the next lead to enrich", "Looking at the next row of leads"],
    verb: ["read", "check"],
    object: ["lead row", "row"],
    counterpart: lead.company,
    surface: "Google Sheets lead list",
    step: "reading the next row",
    inputs: ["company", "name"],
    identifiers: leadIds(lead),
  });
  b.work(Math.max(12, around(rng, 16, 4)), 10, 6);
  const slug = `${lead.first}-${lead.last}-${int(rng, 100, 999)}`.toLowerCase();
  b.focus("enrich", CHROME, `${lead.first} ${lead.last} | LinkedIn`, `https://www.linkedin.com/in/${slug}/`);
  b.ocr(1.5, `${lead.first} ${lead.last}\n${pick(rng, ["Head of Operations", "VP Finance", "IT Director", "Procurement Manager"])} at ${lead.company}`);
  b.frame(2, {
    activity: ["Looking up the lead's profile on LinkedIn", "Finding the lead's current job title on LinkedIn", "Checking a lead on LinkedIn"],
    verb: ["look up", "find"],
    object: ["lead profile", "profile"],
    counterpart: lead.company,
    surface: "LinkedIn profile page",
    step: "copying the current job title",
    identifiers: [lead.company.toLowerCase()],
  });
  b.work(Math.max(20, around(rng, 42, 12)), 4, 7);
  if (rng() < 0.25) {
    b.focus("enrich", CHROME, `${lead.company} - About`, `https://www.${lead.domain}/about`);
    b.frame(2, {
      activity: ["Checking the company website for the lead", "Looking at the lead's company website"],
      verb: ["check"],
      object: ["company website"],
      counterpart: lead.company,
      surface: "company website",
      step: "finding the email pattern",
      identifiers: [lead.company.toLowerCase()],
    });
    b.work(Math.max(12, around(rng, 22, 6)), 2, 5);
  }
}

function linkedinFeed(b: DayBuilder, rng: Rng): void {
  b.instance("feed");
  b.focus("feed", CHROME, "Feed | LinkedIn", "https://www.linkedin.com/feed/");
  b.frame(2, { activity: ["Scrolling the LinkedIn feed", "Reading posts on LinkedIn"], verb: ["browse", "read"], object: ["feed", "posts"], surface: "LinkedIn feed", step: "scrolling" });
  b.work(Math.max(40, around(rng, 140, 50)), 3, 10);
}

function salesopsDay(b: DayBuilder, rng: Rng, weekday: boolean, rowStart: { n: number }): void {
  const org = "Quotient";
  const me = "ari@quotient.app";
  if (!weekday) {
    linkedinFeed(b, rng);
    slackVisit(b, rng, org);
    return;
  }
  slackVisit(b, rng, org);
  inboxRead(b, rng, me);
  for (let block = 0; block < 4; block++) {
    const n = int(rng, 12, 15);
    let prev: Lead | null = null;
    for (let i = 0; i < n; i++) {
      const [company, domain] = pick(rng, COMPANIES);
      const p = person(rng);
      const lead: Lead = { row: rowStart.n++, company, domain, first: p.first, last: p.last };
      enrichLead(b, rng, prev, lead);
      prev = lead;
      if (rng() < 0.12) {
        noiseBreak(b, rng, org, me);
        prev = null;
        // Back to the sheet to type the lead it was on: the next lead's sheet span does that.
      }
    }
    if (block === 1) {
      b.idle(around(rng, 2700, 300));
      meeting(b, rng, 30);
    } else if (block === 2) linkedinFeed(b, rng);
    else noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
}

// ---------- mixed ----------

function mixedDay(b: DayBuilder, rng: Rng, weekday: boolean): void {
  const org = "Brightmart";
  const me = "lou@brightmart.shop";
  if (!weekday) {
    inboxRead(b, rng, me);
    browse(b, rng);
    return;
  }
  inboxRead(b, rng, me);
  slackVisit(b, rng, org);
  // Morning: invoices. Afternoon: tickets. A meeting at noon.
  for (let block = 0; block < 2; block++) {
    const n = int(rng, 7, 9);
    for (let i = 0; i < n; i++) {
      invoiceEntry(b, rng, org, me);
      if (rng() < 0.15) noiseBreak(b, rng, org, me);
    }
    noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
  b.idle(around(rng, 2700, 300));
  meeting(b, rng, 30);
  for (let block = 0; block < 2; block++) {
    const n = int(rng, 10, 12);
    for (let i = 0; i < n; i++) {
      ticket(b, rng, org);
      if (rng() < 0.15) noiseBreak(b, rng, org, me);
    }
    noiseBreak(b, rng, org, me);
    b.idle(around(rng, 300, 60));
  }
}

// ---------- personas ----------

interface PersonaDef {
  role: string;
  industry: string;
  top: { label: string; name: string; apps: string[] };
  second?: { label: string; name: string; apps: string[] };
  names: Record<string, string>;
  apps: Record<string, string[]>;
}

const NOISE_NAMES: Record<string, string> = { slack: "Slack chat", mail: "Reading mail", meeting: "Meetings", browse: "News browsing", feed: "LinkedIn feed" };
const NOISE_APPS: Record<string, string[]> = { slack: [SLACK], mail: ["mail.google.com"], meeting: [ZOOM, "calendar.google.com"], browse: [], feed: ["www.linkedin.com"] };
const INVOICE = { label: "invoice", name: "Keying supplier invoices into Xero", apps: [PREVIEW, "go.xero.com"] };
const TICKETS = { label: "ticket", name: "Answering support tickets with macros", apps: ["acme.zendesk.com", "admin.shopify.com"] };

const DEFS: Record<PersonaId, PersonaDef> = {
  recruiter: {
    role: "Recruiter",
    industry: "Staffing",
    top: { label: "screen", name: "Screening CVs into Greenhouse", apps: [PREVIEW, "app.greenhouse.io"] },
    names: { screen: "Screening CVs into Greenhouse" },
    apps: { screen: [PREVIEW, "app.greenhouse.io"] },
  },
  bookkeeper: {
    role: "Bookkeeper",
    industry: "Accounting",
    top: INVOICE,
    names: { invoice: INVOICE.name, reconcile: "Bank reconciliation in Xero" },
    apps: { invoice: INVOICE.apps, reconcile: ["go.xero.com"] },
  },
  support: {
    role: "Customer support agent",
    industry: "E-commerce",
    top: TICKETS,
    names: { ticket: TICKETS.name },
    apps: { ticket: TICKETS.apps },
  },
  salesops: {
    role: "Sales operations",
    industry: "B2B SaaS",
    top: { label: "enrich", name: "Enriching lead rows from LinkedIn", apps: ["docs.google.com", "www.linkedin.com"] },
    names: { enrich: "Enriching lead rows from LinkedIn" },
    apps: { enrich: ["docs.google.com", "www.linkedin.com"] },
  },
  mixed: {
    role: "Operations manager",
    industry: "Retail",
    top: INVOICE,
    second: TICKETS,
    names: { invoice: INVOICE.name, ticket: TICKETS.name },
    apps: { invoice: INVOICE.apps, ticket: TICKETS.apps },
  },
};

function addDays(day: DayLabel, n: number): { label: DayLabel; weekday: number; at: (hours: number) => number } {
  const [y, m, d] = day.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error(`bad day ${day}`);
  const date = new Date(y, m - 1, d + n);
  const label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const at = (hours: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(hours), Math.round((hours % 1) * 60)).getTime();
  return { label, weekday: date.getDay(), at };
}

const PERSONA_SALT: Record<PersonaId, number> = { recruiter: 11, bookkeeper: 23, support: 37, salesops: 41, mixed: 53 };

export function generatePersona(id: PersonaId, opts: { seed?: number; startDay?: DayLabel; days?: number } = {}): PersonaWeek {
  const seed = opts.seed ?? 7;
  const startDay = opts.startDay ?? "2026-10-12";
  const nDays = opts.days ?? 7;
  const def = DEFS[id];
  const days: PersonaWeek["days"] = [];
  const frames = new Map<DayLabel, FrameNote[]>();
  const focusLabels: Record<string, string> = {};
  const activeMs = new Map<string, number>();
  const instances = new Map<string, number>();
  const rows = { n: 2 };
  for (let i = 0; i < nDays; i++) {
    const { label, weekday, at } = addDays(startDay, i);
    const rng = mulberry32(seed * 100_003 + PERSONA_SALT[id] * 1000 + i);
    const isWeekday = weekday !== 0 && weekday !== 6;
    const b = new DayBuilder(rng, at(isWeekday ? 8.5 : 10 + rng()));
    if (id === "recruiter") recruiterDay(b, rng, isWeekday);
    else if (id === "bookkeeper") bookkeeperDay(b, rng, isWeekday);
    else if (id === "support") supportDay(b, rng, isWeekday);
    else if (id === "salesops") salesopsDay(b, rng, isWeekday, rows);
    else mixedDay(b, rng, isWeekday);
    days.push({ day: label, events: b.end() });
    frames.set(label, [...b.frames].sort((x, y) => x.ts - y.ts || (x.id < y.id ? -1 : 1)));
    Object.assign(focusLabels, b.focusLabels);
    for (const [k, v] of b.activeMs) activeMs.set(k, (activeMs.get(k) ?? 0) + v);
    for (const [k, v] of b.instances) instances.set(k, (instances.get(k) ?? 0) + v);
  }
  const total = [...activeMs.values()].reduce((a, v) => a + v, 0);
  const tasks: Record<string, TruthTask> = {};
  for (const [label, ms] of [...activeMs.entries()].sort((a, b) => b[1] - a[1])) {
    tasks[label] = { label, name: def.names[label] ?? NOISE_NAMES[label] ?? label, share: ms / total, instances: instances.get(label) ?? 0, apps: def.apps[label] ?? NOISE_APPS[label] ?? [] };
  }
  const truthOf = (t: { label: string }) => tasks[t.label] ?? (() => { throw new Error(`no truth for ${t.label}`); })();
  const truth: Truth = {
    persona: id,
    role: def.role,
    industry: def.industry,
    startDay,
    days: nDays,
    topTask: truthOf(def.top),
    ...(def.second === undefined ? {} : { second: truthOf(def.second) }),
    tasks,
    focusLabels,
    frameCount: [...frames.values()].reduce((n, f) => n + f.length, 0),
    eventCount: days.reduce((n, d) => n + d.events.length, 0),
  };
  return { days, frames, truth };
}

/** Writes one persona under `home` (days, keys when encrypted, frames sidecar, truth.json). Fixture keys come from the seed. */
export function writePersona(home: string, week: PersonaWeek, opts: { encrypted: boolean; seed: number }): void {
  mkdirSync(join(home, "days"), { recursive: true });
  mkdirSync(join(home, "frames"), { recursive: true });
  if (opts.encrypted) mkdirSync(join(home, "keys"), { recursive: true });
  week.days.forEach((d, i) => {
    const frames = week.frames.get(d.day) ?? [];
    const paths = { plain: join(home, "days", `${d.day}.jsonl`), enc: join(home, "days", `${d.day}.jsonl.enc`), fplain: join(home, "frames", `${d.day}.jsonl`), fenc: join(home, "frames", `${d.day}.jsonl.enc`) };
    if (!opts.encrypted) {
      for (const p of [paths.enc, paths.fenc]) if (existsSync(p)) rmSync(p);
      writeFileSync(paths.plain, d.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(paths.fplain, frames.map((f) => JSON.stringify(f)).join("\n") + (frames.length > 0 ? "\n" : ""));
      return;
    }
    for (const p of [paths.plain, paths.fplain]) if (existsSync(p)) rmSync(p);
    const rng = mulberry32(opts.seed * 7919 + PERSONA_SALT[week.truth.persona] * 31 + i);
    const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(rng() * 256)));
    const key = bytes(KEY_BYTES);
    const keyPath = join(home, "keys", `${d.day}.key`);
    writeFileSync(keyPath, key, { mode: 0o600 });
    chmodSync(keyPath, 0o600);
    writeFileSync(paths.enc, d.events.map((e) => encryptLine(key, JSON.stringify(e), bytes(NONCE_BYTES))).join("\n") + "\n");
    writeFileSync(paths.fenc, frames.map((f) => encryptLine(key, JSON.stringify(f), bytes(NONCE_BYTES))).join("\n") + (frames.length > 0 ? "\n" : ""));
  });
  writeFileSync(join(home, "truth.json"), JSON.stringify(week.truth, null, 2) + "\n");
}

function parseArgs(argv: readonly string[]): { out: string; seed: number; encrypted: boolean; start: DayLabel; personas: PersonaId[] } {
  let out = "";
  let seed = 7;
  let encrypted = false;
  let personas: PersonaId[] = [...PERSONAS];
  const t = new Date(Date.now() - 7 * 86_400_000);
  let start = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out = argv[++i] ?? "";
    else if (a === "--seed") seed = Number(argv[++i]);
    else if (a === "--encrypted") encrypted = true;
    else if (a === "--start") start = argv[++i] ?? "";
    else if (a === "--persona") {
      const v = argv[++i] ?? "";
      if (v === "all") personas = [...PERSONAS];
      else if ((PERSONAS as readonly string[]).includes(v)) personas = [v as PersonaId];
      else throw new Error(`--persona must be one of ${PERSONAS.join(", ")} or all`);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (out === "") throw new Error("--out DIR is required");
  if (!Number.isSafeInteger(seed)) throw new Error("--seed must be an integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new Error("--start must be YYYY-MM-DD");
  return { out, seed, encrypted, start, personas };
}

if (import.meta.main) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const p of args.personas) {
      const week = generatePersona(p, { seed: args.seed, startDay: args.start });
      writePersona(join(args.out, p), week, { encrypted: args.encrypted, seed: args.seed });
      const top = week.truth.topTask;
      console.log(`${p}: ${week.days.length} days, ${week.truth.eventCount} events, ${week.truth.frameCount} frames, top "${top.name}" ${(top.share * 100).toFixed(1)}% x${top.instances} -> ${join(args.out, p)}`);
    }
  } catch (err) {
    console.error(`gen-domains: ${err instanceof Error ? err.message : String(err)}`);
    console.error("usage: bun run brain/fixtures/gen-domains.ts --out DIR [--seed 7] [--persona NAME|all] [--encrypted] [--start YYYY-MM-DD]");
    process.exit(2);
  }
}
