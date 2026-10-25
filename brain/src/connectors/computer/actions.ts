// s13: deterministic classification of every computer-use action before it reaches the gate. Four classes:
//   read   screenshot, cursor_position, mouse_move, scroll, wait, zoom, read_ui: no change to anything;
//   input  a local, reversible edit: focus a field, type into the focused text element, a click on a control with no
//          commit verb, navigation keys. Needs an approved batch, never uses up an item;
//   commit a click on a control whose AX title / description / identifier has a commit verb, any Return / Enter,
//          Cmd+S, Delete outside a text element. One approved item, one use: the gate compares the canonical hash of
//          { app, verb, fields } (the form as AX shows it at that moment) with the approved item's;
//   deny   anything else: unknown members, drag, mouse down/up, hold_key, paste, modifier shortcuts outside a short
//          list, a click where AX cannot say what is under the pointer, typing into a non-text element, a newline into a
//          one-line field.
import { normaliseAddress } from "../../workflows/allowlist.ts";
import type { BatchItem } from "../../workflows/batch.ts";
import type { AxElement, FormField } from "./driver.ts";

export type ActionClass = { kind: "read" } | { kind: "input" } | { kind: "commit"; verb: string; control: string } | { kind: "deny"; reason: string };

export const COMPUTER_MEMBERS = [
  "screenshot",
  "zoom",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "cursor_position",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
] as const;
export type ComputerMember = (typeof COMPUTER_MEMBERS)[number];

export const READ_MEMBERS: ReadonlySet<string> = new Set(["screenshot", "zoom", "cursor_position", "mouse_move", "scroll", "wait", "read_ui"]);
export const CLICK_MEMBERS: ReadonlySet<string> = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click"]);
/** Members the toolset request switches off and the executor refuses anyway. */
export const DENIED_MEMBERS: ReadonlySet<string> = new Set(["left_click_drag", "left_mouse_down", "left_mouse_up", "hold_key"]);

/** Commit words -> the canonical verb. Order matters: the first word found in the control's text wins. */
export const COMMIT_VERBS: ReadonlyArray<[RegExp, string]> = [
  [/\bschedul(?:e|ed|ing)\b|\bbook\b/, "schedule"],
  [/\bsend\b|\bsending\b/, "send"],
  [/\bsubmit\b/, "submit"],
  [/\bsave\b/, "save"],
  [/\bpay\b|\bpurchase\b|\bbuy\b|\border\b|\bcheckout\b|\bcheck out\b|\bplace\b/, "pay"],
  [/\bdelete\b|\bremove\b|\btrash\b|\bdiscard\b/, "delete"],
  [/\bpost\b|\bpublish\b|\bshare\b|\btweet\b/, "post"],
  [/\binvite\b/, "invite"],
  [/\breply\b/, "reply"],
  [/\bforward\b/, "forward"],
  [/\bupload\b/, "upload"],
  [/\btransfer\b/, "transfer"],
  [/\bsign\b/, "sign"],
  [/\bcreate\b|\badd\b/, "create"],
  [/\bconfirm\b|\bok\b|\byes\b|\baccept\b|\bapprove\b|\bapply\b|\bdone\b|\bfinish\b|\bcontinue\b/, "confirm"],
];

/** The commit verb of a control, or null. Looks at its title, description and identifier. */
export function commitVerbOf(el: Pick<AxElement, "title" | "description" | "identifier">): string | null {
  const text = [el.title, el.description ?? "", (el.identifier ?? "").replace(/[_-]+/g, " ")].join(" ").toLowerCase();
  let best: { at: number; verb: string } | null = null;
  for (const [re, verb] of COMMIT_VERBS) {
    const m = re.exec(text);
    if (m !== null && (best === null || m.index < best.at)) best = { at: m.index, verb };
  }
  return best?.verb ?? null;
}

const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField"]);
const isText = (el: AxElement | null) => el !== null && (el.editable || TEXT_ROLES.has(el.role));

/** Keys that only move around. */
const NAV_KEYS = new Set(["tab", "up", "down", "left", "right", "escape", "esc", "home", "end", "page_up", "page_down", "pageup", "pagedown"]);
/** Modifier shortcuts that only edit or select text in a focused text element. */
const TEXT_SHORTCUTS = new Set(["a", "z", "c", "x", "left", "right", "up", "down", "backspace"]);
const MODS = new Set(["cmd", "command", "super", "meta", "ctrl", "control", "alt", "option", "opt", "shift", "fn"]);

export function parseCombo(combo: string): { mods: string[]; key: string } {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase()).filter((p) => p !== "");
  const key = parts.pop() ?? "";
  return { mods: parts.map((m) => (m === "command" || m === "super" || m === "meta" ? "cmd" : m === "control" ? "ctrl" : m === "option" || m === "opt" ? "alt" : m)), key };
}

export function classifyKey(combo: string, focused: AxElement | null): ActionClass {
  const { mods, key } = parseCombo(combo);
  if (key === "" || mods.some((m) => !MODS.has(m) && !["cmd", "ctrl", "alt", "shift"].includes(m))) return { kind: "deny", reason: `the key ${combo} is not known` };
  const strong = mods.filter((m) => m !== "shift");
  if (key === "return" || key === "enter" || key === "kp_enter") return { kind: "commit", verb: "submit", control: `key ${combo}` };
  if (strong.includes("cmd") && key === "s") return { kind: "commit", verb: "save", control: `key ${combo}` };
  if (key === "v" && strong.length > 0) return { kind: "deny", reason: "pasting is not allowed: type the approved text instead" };
  if (key === "delete" || key === "backspace" || key === "forwarddelete" || key === "del") {
    if (isText(focused) && (strong.length === 0 || (strong.length === 1 && TEXT_SHORTCUTS.has(key)))) return { kind: "input" };
    return { kind: "commit", verb: "delete", control: `key ${combo}` };
  }
  if (strong.length > 0) {
    if (isText(focused) && strong.length === 1 && TEXT_SHORTCUTS.has(key)) return { kind: "input" };
    return { kind: "deny", reason: `the shortcut ${combo} could do anything in this app, so Offload does not press it` };
  }
  if (NAV_KEYS.has(key)) return { kind: "input" };
  if (key === "space" || key.length === 1) return isText(focused) ? { kind: "input" } : { kind: "deny", reason: `the key ${combo} only works inside a text field` };
  return { kind: "deny", reason: `the key ${combo} is not allowed` };
}

/**
 * Class of one action. `target` is the element under the click point (clicks), `focused` the focused element (type,
 * key). Pure: the caller reads AX first.
 */
export function classify(name: string, input: Record<string, unknown>, ctx: { target: AxElement | null; focused: AxElement | null }): ActionClass {
  if (name === "read_ui" || READ_MEMBERS.has(name)) return { kind: "read" };
  if (DENIED_MEMBERS.has(name)) return { kind: "deny", reason: `${name} is not allowed in Offload's computer use` };
  if (CLICK_MEMBERS.has(name)) {
    const el = ctx.target;
    if (el === null) return { kind: "deny", reason: "Offload cannot tell what is under the pointer, so it does not click there" };
    if (name !== "right_click") {
      const verb = commitVerbOf(el);
      if (verb !== null) return { kind: "commit", verb, control: `${el.role} ${el.title}`.trim() };
    }
    if (typeof input.text === "string" && input.text !== "" && name !== "left_click") return { kind: "deny", reason: "a click with keys held is not allowed here" };
    return { kind: "input" };
  }
  if (name === "type") {
    const text = typeof input.text === "string" ? input.text : null;
    if (text === null) return { kind: "deny", reason: "type needs text" };
    if (!isText(ctx.focused)) return { kind: "deny", reason: "nothing that takes text has focus: click the field first" };
    if (/[\r\n]/.test(text) && ctx.focused?.multiline !== true) return { kind: "deny", reason: "a new line in a one-line field would submit the form; click the control named for the approved action instead" };
    return { kind: "input" };
  }
  if (name === "key") return typeof input.text === "string" ? classifyKey(input.text, ctx.focused) : { kind: "deny", reason: "key needs a key name" };
  return { kind: "deny", reason: `${name} is not a computer action Offload knows` };
}

// ---------- the form a commit carries ----------

/** Label aliases per target: the semantic key the approved item uses -> AX labels apps show. */
const EMAIL_LABELS: Record<string, readonly string[]> = {
  to: ["to", "to recipients", "recipients", "to:"],
  cc: ["cc", "cc recipients"],
  bcc: ["bcc", "bcc recipients"],
  subject: ["subject", "subject:", "add a subject"],
  body: ["message body", "body", "message", "message text"],
};
const ADDRESS_KEYS = new Set(["to", "cc", "bcc"]);

export const normaliseLabel = (label: string) => label.normalize("NFC").trim().toLowerCase().replace(/:$/, "").replace(/\s+/g, " ");

function semanticKey(label: string): string {
  const l = normaliseLabel(label);
  for (const [k, aliases] of Object.entries(EMAIL_LABELS)) if (aliases.includes(l) || aliases.includes(`${l}:`)) return k;
  return l === "" ? "(unlabelled)" : l;
}

/** "Anna Berg <anna@x.com>, leo@y.vc" -> "anna@x.com, leo@y.vc" (sorted, normalised); unparsable parts kept as text. */
export function canonicalAddresses(value: string): string {
  const parts = value.split(/[,;\n]/).map((p) => p.trim()).filter((p) => p !== "");
  return parts
    .map((p) => {
      const m = /<([^<>]+)>\s*$/.exec(p);
      return normaliseAddress(m?.[1] ?? p) ?? p.toLowerCase();
    })
    .sort()
    .join(", ");
}

const canonValue = (key: string, value: string) => (ADDRESS_KEYS.has(key) ? canonicalAddresses(value) : value.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\s+$/u, ""));

/** The form as the commit carries it: [key, value] pairs, empty fields dropped, sorted. */
export function canonicalForm(fields: readonly Pick<FormField, "label" | "value">[]): string[][] {
  return fields
    .map((f) => {
      const key = semanticKey(f.label);
      return [key, canonValue(key, f.value)];
    })
    .filter(([, v]) => v !== "")
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0));
}

/** What an approved item commits: its `commit` (any app), or an email's to / subject / body with verb send. */
export function expectedCommit(item: BatchItem): { verb: string; fields: string[][] } {
  if (item.commit !== undefined) return { verb: item.commit.verb, fields: canonicalForm(item.commit.fields.map(([label, value]) => ({ label, value }))) };
  return { verb: "send", fields: canonicalForm([{ label: "to", value: item.to }, { label: "subject", value: item.subject }, { label: "body", value: item.body }]) };
}
