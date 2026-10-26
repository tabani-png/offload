import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as fx from "../src/api/mock/fixtures.ts";
import { main, renderAt } from "./helpers/render.tsx";

afterEach(cleanup);

const SRC = join(import.meta.dir, "../src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const PERSONISH = /person|people|displayName|holder|member|employee/i;
const METRICISH = /seconds|hours|saved|metric|minutes|runs|residual|activeMinutes|score|rank/i;

describe("no ranking of people", () => {
  test("NORANK: grep finds no sort over person metrics anywhere in src", () => {
    const bad = (line: string) => /\.(sort|toSorted)\(|sortBy|orderBy|rank\(/.test(line) && PERSONISH.test(line) && METRICISH.test(line);
    // the check itself catches a league table
    expect(bad("people.sort((a, b) => hoursFor(b) - hoursFor(a))")).toBe(true);
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (bad(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("NORANK: the only sort of people is the directory's name order", () => {
    const sorts = files(SRC).flatMap((f) =>
      readFileSync(f, "utf8").split("\n").filter((l) => /\.(sort|toSorted)\(/.test(l) && PERSONISH.test(l)).map((l) => l.trim()));
    expect(sorts.length).toBeLessThanOrEqual(1);
    for (const s of sorts) expect(s).toContain("displayName.localeCompare");
  });

  test("NORANK: the Table component offers no sorting at all", () => {
    const src = readFileSync(join(SRC, "design/components.tsx"), "utf8");
    const table = src.slice(src.indexOf("export function Table"), src.indexOf("export function Sheet"));
    expect(table).not.toMatch(/sort/i);
    expect(src).not.toContain("aria-sort");
  });

  test("NORANK: people table with per-person views on stays in directory order with no sort controls", async () => {
    await renderAt("/people", { features: ["per_person_views"] });
    const headers = screen.getAllByRole("columnheader");
    for (const h of headers) {
      expect(h.getAttribute("aria-sort")).toBeNull();
      expect(h.querySelector("button, a, [role=button]")).toBeNull();
    }
    const names = Array.from(main().querySelectorAll("tbody tr")).map((r) => r.querySelector("td")!.textContent!);
    expect(names).toEqual([...fx.people].map((p) => p.displayName).sort((a, b) => a.localeCompare(b)));
  });

  test("NORANK: department and overview screens never list people", async () => {
    for (const path of ["/", `/departments/${fx.DEPT.sales}`]) {
      await renderAt(path, { features: ["per_person_views", "working_time"] });
      const text = main().textContent!;
      for (const p of fx.people) expect(text).not.toContain(p.displayName);
      cleanup();
    }
  });

  test("NORANK: the mock API has no endpoint that ranks or sorts people", async () => {
    const { ROUTES } = await import("../src/api/mock/server.ts");
    for (const r of ROUTES) expect(r.path).not.toMatch(/rank|leader|top-?people|sort/i);
  });
});
