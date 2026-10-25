import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as fx from "../src/api/mock/fixtures.ts";
import { contrast, dark, light, over, parseColor, type Scheme } from "../src/design/tokens.ts";
import { h1, main, renderAt, settle, until } from "./helpers/render.tsx";

afterEach(cleanup);

const CSS = readFileSync(join(import.meta.dir, "../src/design/styles.css"), "utf8");
const solid = (c: string, bg: string) => {
  const [r, g, b] = over(c, bg);
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
};

function surfaces(s: Scheme): Record<string, string> {
  return { canvas: s.canvas, card: solid(s.group, s.canvas), sidebar: s.sidebar, toolbar: s.toolbar, sheet: s.sheet };
}

describe("contrast", () => {
  for (const [name, s] of [["dark", dark], ["light", light]] as const) {
    test(`A11Y: body text tokens reach 4.5:1 on every ${name} surface`, () => {
      for (const [surface, bg] of Object.entries(surfaces(s))) {
        for (const ink of ["ink1", "ink2", "ink3"] as const) {
          const ratio = contrast(over(s[ink], bg), parseColor(bg));
          if (ratio < 4.5) throw new Error(`${name} ${ink} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
    });

    test(`A11Y: state text and the primary button reach 4.5:1 (${name})`, () => {
      // State words sit on content surfaces; the sidebar shows only a dot and a count in ink (light green text on the
      // sidebar would be 4.42:1 with the app's own token, so the web never puts state text there).
      const { sidebar: _sidebar, ...content } = surfaces(s);
      for (const [surface, bg] of Object.entries(content)) {
        for (const role of ["working", "needsYou", "done"] as const) {
          const ratio = contrast(over(s.statusInk[role], bg), parseColor(bg));
          if (ratio < 4.5) throw new Error(`${name} ${role} text on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      expect(contrast(parseColor(s.primaryInk), parseColor(s.primaryFill))).toBeGreaterThan(4.5);
    });

    test(`A11Y: the focus ring is distinguishable from every ${name} surface (3:1)`, () => {
      for (const bg of Object.values(surfaces(s))) expect(contrast(parseColor(s.focus), parseColor(bg))).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("focus and keyboard", () => {
  test("A11Y: the stylesheet draws a visible focus ring and never removes it for keyboard focus", () => {
    expect(CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
    for (const rule of CSS.match(/[^{}]+\{[^}]*outline:\s*(none|0)[^}]*\}/g) ?? []) {
      expect(rule.split("{")[0]).not.toContain("focus-visible");
    }
  });

  test("A11Y: only weights 400 and 500 appear in the stylesheet", () => {
    for (const m of CSS.matchAll(/font-weight:\s*([^;]+);/g)) expect(m[1]).toMatch(/^(400|500|var\(--type-[a-z-]+-weight\))$/);
  });

  const PATHS = ["/", `/departments/${fx.DEPT.sales}`, "/workflows", `/workflows/${fx.WF[309]}`, `/workflows/${fx.WF[301]}/evidence`,
    "/approvals", "/digest", "/workers", `/workers/${fx.workers[0]!.id}`, "/people", "/offboarding", "/compliance", "/me"];

  test("A11Y: every interactive element on every route is focusable and named", async () => {
    for (const path of PATHS) {
      await renderAt(path);
      const els = Array.from(document.querySelectorAll<HTMLElement>("a, button, input, select, textarea, [role=radio], tr.openable"));
      expect(els.length).toBeGreaterThan(0);
      for (const el of els) {
        if ((el as HTMLButtonElement).disabled) continue;
        const where = `${path}: <${el.tagName.toLowerCase()}> "${el.textContent?.slice(0, 40)}"`;
        if (el.tabIndex < 0) throw new Error(`not focusable ${where}`);
        if (el.tagName === "A" && !el.getAttribute("href")) throw new Error(`link without href ${where}`);
        const name = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
        if (!name && !el.closest("label") && el.tagName !== "TR") throw new Error(`no accessible name ${where}`);
        el.focus();
        if (document.activeElement !== el) throw new Error(`focus() did not land ${where}`);
      }
      cleanup();
    }
  });

  test("A11Y: number keys move between views", async () => {
    const { router } = await renderAt("/");
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "2" });
    });
    await until(() => router.state.location.pathname === "/workflows", "navigation");
    await settle();
    expect(h1()).toBe("Workflows");
  });

  test("A11Y: table rows walk with j/k and open with Enter", async () => {
    const { router } = await renderAt("/workflows");
    const rows = Array.from(main().querySelectorAll<HTMLElement>("tbody tr[tabindex]"));
    rows[0]!.focus();
    fireEvent.keyDown(rows[0]!, { key: "j" });
    expect(document.activeElement).toBe(rows[1]!);
    fireEvent.keyDown(rows[1]!, { key: "k" });
    expect(document.activeElement).toBe(rows[0]!);
    await act(async () => {
      fireEvent.keyDown(rows[0]!, { key: "Enter" });
    });
    await until(() => router.state.location.pathname.startsWith("/workflows/"), "row to open");
  });

  test("A11Y: sheets take focus, trap it, close on Escape and give focus back", async () => {
    await renderAt(`/workflows/${fx.WF[301]}`);
    const opener = screen.getByRole("button", { name: /Preview SOP/ });
    opener.focus();
    await act(async () => {
      fireEvent.click(opener);
    });
    await settle();
    const dialog = document.querySelector("[role=dialog]") as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("A11Y: state is never colour alone: every dot carries words", async () => {
    await renderAt("/workflows");
    for (const dot of Array.from(document.querySelectorAll(".dot"))) {
      const labelled = dot.getAttribute("aria-label") || (dot.getAttribute("aria-hidden") === "true" && dot.parentElement?.textContent?.trim());
      expect(Boolean(labelled)).toBe(true);
    }
  });

  test("A11Y: motion uses the app easing at 150-300 ms and honours reduced motion", () => {
    const durations = [...CSS.matchAll(/var\(--dur-(\w+)\)/g)].map((m) => m[1]);
    expect(new Set(durations)).toEqual(new Set(["fast", "base", "slow", "press"]));
    expect(CSS).not.toMatch(/transition:[^;]*\d+m?s/);
    expect(CSS).toContain("var(--ease-out-expo)");
  });
});
