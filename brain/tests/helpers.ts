import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventKind, OffloadEvent, TaskProfile } from "../src/types.ts";

/** Builds events with readable sequential ids (e001, e002, ...) at offsets in seconds from a fixed base. */
export class EventBuilder {
  static readonly BASE = Date.UTC(2026, 9, 12, 9, 0, 0);
  private n = 0;
  readonly events: OffloadEvent[] = [];

  at(seconds: number, kind: EventKind, fields: Partial<Omit<OffloadEvent, "id" | "ts" | "kind">> = {}): string {
    this.n += 1;
    const id = `e${String(this.n).padStart(3, "0")}`;
    this.events.push({ id, ts: EventBuilder.BASE + seconds * 1000, kind, ...fields });
    return id;
  }

  focus(seconds: number, title: string, app = "com.google.Chrome", host = "mail.google.com"): string {
    return this.at(seconds, "focus", { app, appName: appNameFor(app), title, host, url: host ? `https://${host}/mail/u/0/` : "" });
  }
}

function appNameFor(app: string): string {
  if (app === "com.google.Chrome") return "Google Chrome";
  if (app === "com.tinyspeck.slackmacgap") return "Slack";
  if (app === "us.zoom.xos") return "zoom.us";
  if (app === "com.apple.Terminal") return "Terminal";
  return app;
}

export function tempHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "offload-brain-"));
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** A Gmail compose task profile; override any field. */
export function profile(over: Partial<TaskProfile> = {}): TaskProfile {
  return {
    taskId: "t_x",
    signature: "sig",
    app: "com.google.Chrome",
    appName: "Google Chrome",
    host: "mail.google.com",
    urlPattern: "/mail/u/<n>/",
    template: "New Message",
    category: "email",
    exampleTitles: ["New Message"],
    ocrKeywords: [],
    identifiers: { counterparties: [], domains: [] },
    instanceCount: 10,
    keysPerMinute: 100,
    schedulingShare: 0,
    ...over,
  };
}

