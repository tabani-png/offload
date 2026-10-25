// Run with TZ=<zone>: prints what the timeline shows for (a) the fixture week and (b) a hand-written day whose only
// span starts at 09:00 local. Used by tz.test.ts (a separate process, so TZ applies from the first Date).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixture, writeFixture } from "../../fixtures/gen.ts";
import { createBrain } from "../../src/api/server.ts";
import type { TimelineResponse } from "../../src/api/types.ts";
import { StubModel } from "../../src/models/model.ts";

process.env.OFFLOAD_KEYS ??= "file";
const TOKEN = "t".repeat(40);
const hm = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const dayOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function timeline(home: string, day: string, now: number): Promise<TimelineResponse> {
  const brain = createBrain({ home, token: TOKEN, now: () => now, workflows: { model: new StubModel(), env: {} } });
  const r = await brain.handle(new Request(`http://127.0.0.1:4545/timeline?day=${day}`, { headers: { authorization: `Bearer ${TOKEN}` } }));
  if (r.status !== 200) throw new Error(`timeline ${day}: ${r.status} ${await r.text()}`);
  return (await r.json()) as TimelineResponse;
}

const now = new Date(2026, 9, 19, 12, 0).getTime();
const out: Record<string, unknown> = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone };

// (a) fixture week: Wednesday 2026-10-14.
const fx = mkdtempSync(join(tmpdir(), "offload-tz-"));
try {
  const days = generateFixture({ seed: 42, startDay: "2026-10-12" });
  writeFixture(fx, days, { encrypted: false, seed: 42 });
  out.fixtureEventsOffDay = days.reduce((n, d) => n + d.events.filter((e) => dayOf(e.ts) !== d.day).length, 0);
  out.fixtureFirstEvent = days.map((d) => ({ day: d.day, at: hm(d.events[0]!.ts) }));
  const t = await timeline(fx, "2026-10-14", now);
  out.fixtureFirstSpan = hm(t.spans[0]!.start);
  out.fixtureLastSpanEnd = hm(t.spans[t.spans.length - 1]!.end);
  out.fixtureSpansOffDay = t.spans.filter((s) => dayOf(s.start) !== "2026-10-14").length;
} finally {
  rmSync(fx, { recursive: true, force: true });
}

// (b) one span at 09:00 local on 2026-10-14.
const home = mkdtempSync(join(tmpdir(), "offload-tz-"));
try {
  mkdirSync(join(home, "days"), { recursive: true });
  const at = (h: number, m: number, s = 0) => new Date(2026, 9, 14, h, m, s).getTime();
  const ev = [
    { id: "e001", ts: at(9, 0), kind: "focus", app: "com.google.Chrome", appName: "Google Chrome", title: "New Message", host: "mail.google.com", url: "https://mail.google.com/mail/u/0/" },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `e${String(i + 2).padStart(3, "0")}`, ts: at(9, i, 30), kind: "input", keys: 40, clicks: 2 })),
    { id: "e100", ts: at(9, 32), kind: "idle_start" },
  ];
  writeFileSync(join(home, "days", "2026-10-14.jsonl"), ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = await timeline(home, "2026-10-14", now);
  out.handSpan = t.spans.length === 0 ? null : hm(t.spans[0]!.start);
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
