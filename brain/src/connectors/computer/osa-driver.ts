// s13: the real computer-use driver, OPT-IN ONLY (OFFLOAD_COMPUTER_REAL=1). Never used by tests or verify.sh.
// Built on tools every Mac has, so no Swift helper is needed in the brain: `screencapture` + `sips` for screenshots,
// JXA (`osascript -l JavaScript`) with the ApplicationServices / CoreGraphics bridge for AX hit tests, focus, pointer
// and key events, and System Events for typing and the window's text fields. NOT VERIFIED on this Mac yet: the JXA
// bridge calls (AXUIElementCopyElementAtPosition, CGEvent*) need Accessibility for the process that runs the brain.
// Every call is bounded by a timeout and gets the plain environment (linkEnv): no secret, no OFFLOAD_TOKEN.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../config.ts";
import { linkEnv, type LinkRunner } from "../link.ts";
import type { ChainTarget } from "../targets.ts";
import type { AxElement, ComputerDriver, FormField, MouseButton, Permissions, Screenshot } from "./driver.ts";
import { parseCombo } from "./actions.ts";

const STEP_TIMEOUT_MS = 10_000;
export const SCREENSHOT_LONG_EDGE = 1366;

/** macOS virtual key codes for the named keys the executor lets through. */
const KEY_CODES: Record<string, number> = {
  return: 36, enter: 76, kp_enter: 76, tab: 48, space: 49, delete: 117, forwarddelete: 117, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, page_up: 116, pageup: 116, page_down: 121, pagedown: 121,
};

export class OsaDriver implements ComputerDriver {
  readonly real = true;
  private readonly env: Record<string, string>;

  constructor(
    private readonly runner: LinkRunner,
    env: Env,
  ) {
    this.env = linkEnv(env);
  }

  private async jxa(script: string): Promise<string> {
    const r = await this.runner.run(["osascript", "-l", "JavaScript", "-e", script], { timeoutMs: STEP_TIMEOUT_MS, env: this.env });
    if (r.code !== 0) throw new Error(`osascript failed (exit ${String(r.code)}${r.timedOut ? ", timed out" : ""})`);
    return r.stdout.trim();
  }

  private async run(argv: string[]): Promise<string> {
    const r = await this.runner.run(argv, { timeoutMs: STEP_TIMEOUT_MS, env: this.env });
    if (r.code !== 0) throw new Error(`${argv[0]} failed (exit ${String(r.code)})`);
    return r.stdout;
  }

  async permissions(): Promise<Permissions> {
    const out = await this.jxa("ObjC.import('ApplicationServices'); ObjC.import('CoreGraphics'); JSON.stringify({ a: $.AXIsProcessTrusted(), s: $.CGPreflightScreenCaptureAccess() })").catch(() => "{}");
    try {
      const v = JSON.parse(out) as { a?: boolean; s?: boolean };
      return { accessibility: v.a === true, screenRecording: v.s === true };
    } catch {
      return { accessibility: false, screenRecording: false };
    }
  }

  async appPresent(t: ChainTarget): Promise<boolean> {
    if (t.hosts.length > 0) return true;
    for (const b of t.bundleIds) {
      if (!/^[A-Za-z0-9.-]{3,200}$/.test(b)) continue;
      const out = await this.run(["mdfind", `kMDItemCFBundleIdentifier == '${b}'`]).catch(() => "");
      if (out.trim() !== "") return true;
    }
    return false;
  }

  async open(t: ChainTarget): Promise<void> {
    if (t.hosts[0] !== undefined) await this.run(["open", `https://${t.hosts[0]}/`]);
    else if (t.bundleIds[0] !== undefined) await this.run(["open", "-b", t.bundleIds[0]]);
  }

  async screenshot(): Promise<Screenshot> {
    const dir = mkdtempSync(join(tmpdir(), "offload-shot-"));
    try {
      const raw = join(dir, "raw.png");
      const out = join(dir, "shot.png");
      await this.run(["screencapture", "-x", "-t", "png", raw]);
      await this.run(["sips", "-Z", String(SCREENSHOT_LONG_EDGE), raw, "--out", out]);
      const dims = await this.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", out]);
      const width = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1] ?? 0);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1] ?? 0);
      const pts = Number(await this.jxa("ObjC.import('AppKit'); $.NSScreen.mainScreen.frame.size.width"));
      return { png: readFileSync(out).toString("base64"), width, height, scale: pts > 0 ? width / pts : 1 };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private static readonly AX_DESCRIBE = `
    function attr(el, name) { var r = Ref(); var e = $.AXUIElementCopyAttributeValue(el, name, r); if (e !== 0) return ''; var v = r[0]; try { return ObjC.unwrap(v) || ''; } catch (x) { return ''; } }
    function describe(el) { if (!el) return null; var role = String(attr(el, 'AXRole')); return { role: role, title: String(attr(el, 'AXTitle') || attr(el, 'AXDescription') || ''), description: String(attr(el, 'AXDescription') || ''), identifier: String(attr(el, 'AXIdentifier') || ''), value: String(attr(el, 'AXValue') || ''), editable: ['AXTextField','AXTextArea','AXComboBox','AXSearchField'].indexOf(role) >= 0, multiline: role === 'AXTextArea' }; }`;

  async elementAt(x: number, y: number): Promise<AxElement | null> {
    const out = await this.jxa(`ObjC.import('ApplicationServices'); ${OsaDriver.AX_DESCRIBE}
      var sys = $.AXUIElementCreateSystemWide(); var r = Ref(); var e = $.AXUIElementCopyElementAtPosition(sys, ${Number(x)}, ${Number(y)}, r);
      JSON.stringify(e === 0 ? describe(r[0]) : null)`).catch(() => "null");
    return parseEl(out);
  }

  async focused(): Promise<AxElement | null> {
    const out = await this.jxa(`ObjC.import('ApplicationServices'); ${OsaDriver.AX_DESCRIBE}
      var sys = $.AXUIElementCreateSystemWide(); var r = Ref(); var e = $.AXUIElementCopyAttributeValue(sys, 'AXFocusedUIElement', r);
      JSON.stringify(e === 0 ? describe(r[0]) : null)`).catch(() => "null");
    return parseEl(out);
  }

  async formValues(): Promise<FormField[]> {
    const out = await this.jxa(`var se = Application('System Events'); var p = se.processes.whose({ frontmost: true })[0];
      var all = p.windows[0].entireContents(); var out = [];
      for (var i = 0; i < all.length; i++) { try { var el = all[i]; var role = el.role(); if (['AXTextField','AXTextArea','AXComboBox','AXSearchField'].indexOf(role) < 0) continue;
        out.push({ label: String(el.description() || el.name() || el.title() || ''), role: role, value: String(el.value() || '') }); } catch (x) {} }
      JSON.stringify(out)`).catch(() => "[]");
    try {
      const v = JSON.parse(out) as FormField[];
      return Array.isArray(v) ? v.filter((f) => typeof f.label === "string" && typeof f.value === "string") : [];
    } catch {
      return [];
    }
  }

  async readUi(): Promise<string> {
    return this.jxa(`var se = Application('System Events'); var p = se.processes.whose({ frontmost: true })[0];
      var all = p.windows[0].entireContents(); var out = [];
      for (var i = 0; i < all.length && out.length < 200; i++) { try { var el = all[i]; var n = el.name() || el.description() || ''; if (!n) continue; out.push(el.role() + ' "' + n + '"'); } catch (x) {} }
      out.join('\\n')`).catch(() => "");
  }

  async click(x: number, y: number, button: MouseButton, count: 1 | 2 | 3, mods: readonly string[]): Promise<void> {
    const [down, up, btn] = button === "right" ? ["kCGEventRightMouseDown", "kCGEventRightMouseUp", "kCGMouseButtonRight"] : button === "middle" ? ["kCGEventOtherMouseDown", "kCGEventOtherMouseUp", "kCGMouseButtonCenter"] : ["kCGEventLeftMouseDown", "kCGEventLeftMouseUp", "kCGMouseButtonLeft"];
    const flags = mods.map((m) => parseCombo(`${m}+x`).mods[0]).map((m) => (m === "cmd" ? "$.kCGEventFlagMaskCommand" : m === "ctrl" ? "$.kCGEventFlagMaskControl" : m === "alt" ? "$.kCGEventFlagMaskAlternate" : m === "shift" ? "$.kCGEventFlagMaskShift" : "0"));
    await this.jxa(`ObjC.import('CoreGraphics'); var p = $.CGPointMake(${Number(x)}, ${Number(y)}); var f = ${flags.length === 0 ? "0" : flags.join(" | ")};
      for (var i = 1; i <= ${count}; i++) { var d = $.CGEventCreateMouseEvent(null, $.${down}, p, $.${btn}); $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, i); if (f) $.CGEventSetFlags(d, f); $.CGEventPost($.kCGHIDEventTap, d);
        var u = $.CGEventCreateMouseEvent(null, $.${up}, p, $.${btn}); $.CGEventSetIntegerValueField(u, $.kCGMouseEventClickState, i); if (f) $.CGEventSetFlags(u, f); $.CGEventPost($.kCGHIDEventTap, u); }
      'ok'`);
  }

  async move(x: number, y: number): Promise<void> {
    await this.jxa(`ObjC.import('CoreGraphics'); $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, $.CGPointMake(${Number(x)}, ${Number(y)}), $.kCGMouseButtonLeft)); 'ok'`);
  }

  async type(text: string): Promise<void> {
    // keystroke takes the text as data (JSON-quoted into the script), one line at a time; newlines as Return inside
    // a multi-line area only (the executor refuses them elsewhere).
    const lines = text.split(/\r?\n/);
    const parts = lines.map((l, i) => `se.keystroke(${JSON.stringify(l)});${i < lines.length - 1 ? " se.keyCode(36);" : ""}`).join(" ");
    await this.jxa(`var se = Application('System Events'); ${parts} 'ok'`);
  }

  async key(combo: string, repeat: number): Promise<void> {
    const { mods, key } = parseCombo(combo);
    const using = mods.map((m) => (m === "cmd" ? "'command down'" : m === "ctrl" ? "'control down'" : m === "alt" ? "'option down'" : m === "shift" ? "'shift down'" : null)).filter((x) => x !== null);
    const code = KEY_CODES[key];
    const press = code !== undefined ? `se.keyCode(${code}, { using: [${using.join(",")}] });` : `se.keystroke(${JSON.stringify(key)}, { using: [${using.join(",")}] });`;
    await this.jxa(`var se = Application('System Events'); for (var i = 0; i < ${Math.max(1, Math.min(repeat, 100))}; i++) { ${press} } 'ok'`);
  }

  async scroll(x: number, y: number, direction: "up" | "down" | "left" | "right", amount: number): Promise<void> {
    await this.move(x, y);
    const [dy, dx] = direction === "up" ? [amount, 0] : direction === "down" ? [-amount, 0] : direction === "left" ? [0, amount] : [0, -amount];
    await this.jxa(`ObjC.import('CoreGraphics'); $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 2, ${dy}, ${dx})); 'ok'`);
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const out = await this.jxa("ObjC.import('CoreGraphics'); var p = $.CGEventGetLocation($.CGEventCreate(null)); JSON.stringify({ x: p.x, y: p.y })");
    const v = JSON.parse(out) as { x: number; y: number };
    return { x: v.x, y: v.y };
  }

  async wait(seconds: number): Promise<void> {
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(seconds, 5)) * 1000));
  }
}

function parseEl(out: string): AxElement | null {
  try {
    const v = JSON.parse(out) as AxElement | null;
    return v !== null && typeof v.role === "string" && v.role !== "" ? v : null;
  } catch {
    return null;
  }
}
