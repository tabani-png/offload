// s18 name policy for a home: the user's own name and whether it may be sent ($OFFLOAD_HOME/privacy.json), plus the
// people the user already deals with (first + last names in every workflow's recipients.csv). Read on the Mac only.
//   privacy.json  { "ownName": "Muhammad Ali", "ownNameToClaude": "mask" | "keep" }   (default "mask")
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRecipients } from "../workflows/scripts/recipients.ts";
import type { NameMapOptions } from "./names.ts";

export const PRIVACY_FILE = "privacy.json";

export interface PrivacySettings {
  ownName: string | null;
  ownNameToClaude: "mask" | "keep";
}

export function readPrivacySettings(home: string): PrivacySettings {
  const out: PrivacySettings = { ownName: null, ownNameToClaude: "mask" };
  const p = join(home, PRIVACY_FILE);
  if (!existsSync(p)) return out;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    if (typeof raw.ownName === "string" && raw.ownName.trim() !== "") out.ownName = raw.ownName.replace(/\s+/g, " ").trim().slice(0, 80);
    if (raw.ownNameToClaude === "keep") out.ownNameToClaude = "keep";
  } catch {
    // A broken file masks (the safe default).
  }
  return out;
}

/** First + last names of every workflow's recipient list. */
export function contactNames(home: string): string[] {
  const dir = join(home, "workflows");
  if (!existsSync(dir)) return [];
  const out = new Set<string>();
  for (const id of readdirSync(dir)) {
    const p = join(dir, id, "recipients.csv");
    if (!existsSync(p)) continue;
    try {
      for (const r of readRecipients(readFileSync(p, "utf8"))) {
        const full = `${r.firstName} ${r.lastName}`.trim();
        if (full !== "") out.add(full);
      }
    } catch {
      // A list without an email column has no contacts to learn.
    }
  }
  return [...out].sort();
}

/** The NameMap options for one run in this home. `extraSelf`: names the run knows are the user's (facts.md sign). */
export function readNamePolicy(home: string, extraSelf: readonly string[] = []): NameMapOptions {
  const s = readPrivacySettings(home);
  const self = [...(s.ownName === null ? [] : [s.ownName]), ...extraSelf.map((x) => x.trim()).filter((x) => x !== "")];
  return { known: contactNames(home), self, keepSelf: s.ownNameToClaude === "keep" };
}

/** The user's own name from a workflow's facts.md ("sign: Muhammad"). */
export function signNames(facts: string): string[] {
  const m = /^\s*-?\s*sign\s*:\s*(.+)$/im.exec(facts);
  return m?.[1] === undefined ? [] : [m[1].trim()];
}
