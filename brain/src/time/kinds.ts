// s23: the kind of work a span is, from its app bundle id, host and URL path only (ADR 0003: metadata, never content;
// ADR 0005: deterministic, no model). The list and its order are fixed.
import type { Span } from "../types.ts";

export const WORK_KINDS = ["code", "docs", "meeting", "sheet", "email", "chat", "browse", "other"] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_KIND_NAMES: Readonly<Record<WorkKind, string>> = {
  code: "Coding",
  docs: "Docs",
  meeting: "Meetings",
  sheet: "Spreadsheets",
  email: "Email",
  chat: "Chat",
  browse: "Browsing",
  other: "Other",
};

const BROWSERS = new Set(["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "org.mozilla.firefox", "com.microsoft.edgemac", "com.brave.Browser"]);

const APP_KIND: Readonly<Record<string, WorkKind>> = {
  // Coding: terminals, editors and IDEs (a coding agent runs in the terminal).
  "com.apple.Terminal": "code",
  "com.googlecode.iterm2": "code",
  "com.mitchellh.ghostty": "code",
  "dev.warp.Warp-Stable": "code",
  "com.microsoft.VSCode": "code",
  "com.todesktop.230313mzl4w4u92": "code", // Cursor
  "dev.zed.Zed": "code",
  "com.apple.dt.Xcode": "code",
  // Docs
  "notion.id": "docs",
  "com.apple.iWork.Pages": "docs",
  "com.microsoft.Word": "docs",
  // Spreadsheets
  "com.microsoft.Excel": "sheet",
  "com.apple.iWork.Numbers": "sheet",
  // Meetings
  "us.zoom.xos": "meeting",
  "com.microsoft.teams": "meeting",
  "com.microsoft.teams2": "meeting",
  "com.apple.iCal": "meeting",
  "com.apple.FaceTime": "meeting",
  // Email
  "com.apple.mail": "email",
  "com.microsoft.Outlook": "email",
  "com.superhuman.electron": "email",
  // Chat
  "com.tinyspeck.slackmacgap": "chat",
  "com.apple.MobileSMS": "chat",
  "com.hnc.Discord": "chat",
};

const HOST_KIND: Readonly<Record<string, WorkKind>> = {
  "www.notion.so": "docs",
  "notion.so": "docs",
  "meet.google.com": "meeting",
  "zoom.us": "meeting",
  "app.zoom.us": "meeting",
  "teams.microsoft.com": "meeting",
  "calendar.google.com": "meeting",
  "mail.google.com": "email",
  "outlook.office.com": "email",
  "outlook.live.com": "email",
  "app.superhuman.com": "email",
  "app.slack.com": "chat",
  "discord.com": "chat",
};

function pathOf(url: string): string {
  if (url === "") return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** The kind of work of one span, one of WORK_KINDS (typed as string so callers can compare it with any id). Same span,
 * same kind. */
export function kindOfSpan(span: Pick<Span, "app" | "host" | "url">): string {
  const byApp = APP_KIND[span.app];
  if (byApp !== undefined) return byApp;
  const host = span.host.toLowerCase();
  if (host === "docs.google.com") {
    const path = pathOf(span.url);
    if (path.startsWith("/spreadsheets")) return "sheet";
    if (path.startsWith("/document")) return "docs";
    return "browse";
  }
  const byHost = HOST_KIND[host];
  if (byHost !== undefined) return byHost;
  if (host !== "" || BROWSERS.has(span.app)) return "browse";
  return "other";
}
