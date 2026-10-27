// s13: what computer use needs from the Mac: screenshots, the Accessibility (AX) view of what is under the pointer and
// what has focus, and input (click, type, key, scroll). Two drivers: StubDriver (in memory, deterministic, used by the
// stub model and every test; it never touches the real UI) and OsaDriver (osa-driver.ts, opt-in real mode).
import type { ChainTarget } from "../targets.ts";
import { formatAxLine } from "./ax-text.ts";

export interface AxElement {
  role: string;
  title: string;
  description?: string;
  identifier?: string;
  value?: string;
  /** A text element the user can type into. */
  editable: boolean;
  /** A multi-line text area (a typed newline is a newline, not a submit). */
  multiline?: boolean;
}

export interface FormField {
  label: string;
  role: string;
  value: string;
}

export interface Screenshot {
  /** base64 PNG, already within the model's image limits. */
  png: string;
  width: number;
  height: number;
  /** Image pixels per screen point (coordinates from the model are divided by it). */
  scale: number;
}

export interface Permissions {
  accessibility: boolean;
  screenRecording: boolean;
}

export type MouseButton = "left" | "right" | "middle";

export interface ComputerDriver {
  readonly real: boolean;
  permissions(): Promise<Permissions>;
  appPresent(t: ChainTarget): Promise<boolean>;
  open(t: ChainTarget): Promise<void>;
  screenshot(): Promise<Screenshot>;
  /** The element at a screen point, null when AX cannot say. */
  elementAt(x: number, y: number): Promise<AxElement | null>;
  focused(): Promise<AxElement | null>;
  /** The editable fields of the focused window with their current values (read at commit time). */
  formValues(): Promise<FormField[]>;
  /** A short text outline of the focused window's AX tree (the read_ui tool). */
  readUi(): Promise<string>;
  click(x: number, y: number, button: MouseButton, count: 1 | 2 | 3, mods: readonly string[]): Promise<void>;
  move(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  key(combo: string, repeat: number): Promise<void>;
  scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void>;
  cursor(): Promise<{ x: number; y: number }>;
  wait(seconds: number): Promise<void>;
}

/** 1x1 transparent PNG. */
export const BLANK_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export interface StubElement extends AxElement {
  id: string;
  /** Hit box in screen points. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Shown as a form field (editable elements only); `label` is its AX title or description. */
}

export interface StubEvent {
  kind: "click" | "type" | "key" | "scroll" | "move" | "open";
  detail: string;
}

/**
 * An in-memory app: elements with hit boxes; clicking an editable element focuses it; typing appends to the focused
 * value; Tab moves focus to the next editable element; clicking a button records a press. Nothing outside the process
 * is touched. `userMoves(x, y)` simulates the person grabbing the mouse.
 */
export class StubDriver implements ComputerDriver {
  readonly real = false;
  readonly events: StubEvent[] = [];
  readonly pressed: Array<{ title: string; form: FormField[] }> = [];
  private focusId: string | null = null;
  private pos = { x: 0, y: 0 };
  perms: Permissions = { accessibility: true, screenRecording: true };
  present = true;

  constructor(public elements: StubElement[]) {}

  static compose(): StubDriver {
    return new StubDriver([
      { id: "to", role: "AXTextField", title: "To recipients", editable: true, value: "", x: 100, y: 100, w: 400, h: 20 },
      { id: "subject", role: "AXTextField", title: "Subject", editable: true, value: "", x: 100, y: 130, w: 400, h: 20 },
      { id: "body", role: "AXTextArea", title: "Message Body", editable: true, multiline: true, value: "", x: 100, y: 160, w: 400, h: 200 },
      { id: "send", role: "AXButton", title: "Send", editable: false, x: 100, y: 380, w: 60, h: 24 },
      { id: "schedule", role: "AXButton", title: "Schedule send", editable: false, x: 170, y: 380, w: 100, h: 24 },
      { id: "format", role: "AXButton", title: "Formatting options", editable: false, x: 280, y: 380, w: 40, h: 24 },
      { id: "discard", role: "AXButton", title: "Discard draft", editable: false, x: 330, y: 380, w: 40, h: 24 },
    ]);
  }

  el(id: string): StubElement {
    const e = this.elements.find((x) => x.id === id);
    if (e === undefined) throw new Error(`no stub element ${id}`);
    return e;
  }

  center(id: string): [number, number] {
    const e = this.el(id);
    return [e.x + Math.floor(e.w / 2), e.y + Math.floor(e.h / 2)];
  }

  userMoves(x: number, y: number): void {
    this.pos = { x, y };
  }

  private hit(x: number, y: number): StubElement | null {
    return this.elements.find((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h) ?? null;
  }

  async permissions() {
    return { ...this.perms };
  }
  async appPresent() {
    return this.present;
  }
  async open(t: ChainTarget) {
    this.events.push({ kind: "open", detail: t.id });
  }
  async screenshot(): Promise<Screenshot> {
    return { png: BLANK_PNG, width: 1280, height: 800, scale: 1 };
  }
  async elementAt(x: number, y: number) {
    const e = this.hit(x, y);
    return e === null ? null : strip(e);
  }
  async focused() {
    const e = this.focusId === null ? null : this.el(this.focusId);
    return e === null ? null : strip(e);
  }
  async formValues(): Promise<FormField[]> {
    return this.elements.filter((e) => e.editable).map((e) => ({ label: e.title || (e.description ?? ""), role: e.role, value: e.value ?? "" }));
  }
  async readUi() {
    // s27: the one accessibility-line format (ax-text.ts), so the read step parses exactly what is written.
    return this.elements.map((e) => formatAxLine(e.role, e.title, e.editable ? (e.value ?? "") : null)).join("\n");
  }
  async click(x: number, y: number, button: MouseButton, count: 1 | 2 | 3) {
    this.pos = { x, y };
    const e = this.hit(x, y);
    this.events.push({ kind: "click", detail: `${button}x${count} ${e?.id ?? "nothing"}` });
    if (e === null) return;
    if (e.editable) this.focusId = e.id;
    else if (button === "left") this.pressed.push({ title: e.title, form: await this.formValues() });
  }
  async move(x: number, y: number) {
    this.pos = { x, y };
    this.events.push({ kind: "move", detail: `${x},${y}` });
  }
  async type(text: string) {
    this.events.push({ kind: "type", detail: text });
    if (this.focusId === null) return;
    const e = this.el(this.focusId);
    e.value = (e.value ?? "") + text;
  }
  async key(combo: string, repeat: number) {
    this.events.push({ kind: "key", detail: `${combo}x${repeat}` });
    const k = combo.split("+").pop()!.toLowerCase();
    if (k === "tab") {
      const editable = this.elements.filter((e) => e.editable);
      const i = editable.findIndex((e) => e.id === this.focusId);
      this.focusId = editable[(i + 1) % editable.length]?.id ?? null;
    } else if ((k === "return" || k === "enter") && this.focusId !== null) {
      this.pressed.push({ title: `key:${combo}`, form: await this.formValues() });
    } else if (k === "backspace" && this.focusId !== null) {
      const e = this.el(this.focusId);
      e.value = (e.value ?? "").slice(0, -repeat);
    }
  }
  async scroll(x: number, y: number, direction: string, amount: number) {
    this.pos = { x, y };
    this.events.push({ kind: "scroll", detail: `${direction}x${amount}` });
  }
  async cursor() {
    return { ...this.pos };
  }
  async wait() {}
}

function strip(e: StubElement): AxElement {
  return { role: e.role, title: e.title, editable: e.editable, ...(e.description === undefined ? {} : { description: e.description }), ...(e.identifier === undefined ? {} : { identifier: e.identifier }), ...(e.value === undefined ? {} : { value: e.value }), ...(e.multiline === undefined ? {} : { multiline: e.multiline }) };
}
