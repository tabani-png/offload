// s10b, REVIEW-2 section 3 (logs): the brain log (serve --log-file, or stderr) and gate-log.jsonl rotate at 5 MB and
// keep 2 old files; log lines never carry content (addresses, quoted text, OCR, mail bodies).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installBrainLogging, LOG_KEEP, LOG_MAX_BYTES, rotateIfLarge, scrubLogText } from "../../src/log.ts";
import { tempHome } from "../helpers.ts";

let home = "";
let cleanup = () => {};
beforeEach(() => ({ home, cleanup } = tempHome()));
afterEach(() => cleanup());

describe("s10b logs", () => {
  test("LOG: rotation at 5 MB keeps the live file and 2 old ones", () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(LOG_KEEP).toBe(2);
    const p = join(home, "brain.err.log");
    for (let i = 0; i < 4; i++) {
      writeFileSync(p, "x".repeat(LOG_MAX_BYTES));
      rotateIfLarge(p);
    }
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(existsSync(`${p}.2`)).toBe(true);
    expect(existsSync(`${p}.3`)).toBe(false);
    writeFileSync(p, "small");
    rotateIfLarge(p);
    expect(readFileSync(p, "utf8")).toBe("small");
  });

  test("LOG: installed logging writes scrubbed lines to the file and rotates it", () => {
    const p = join(home, "brain.err.log");
    const off = installBrainLogging({ file: p });
    try {
      console.error("brain: scheduler: wf_x:", new Error('could not draft "Dear Ana, our SECRET raise" for ana@fund.vc'));
      console.warn("brain: OCR said To: bo@seed.vc Subject: \"Term sheet\"");
    } finally {
      off();
    }
    const text = readFileSync(p, "utf8");
    expect(text).toContain("brain: scheduler: wf_x:");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("ana@fund.vc");
    expect(text).not.toContain("bo@seed.vc");
    expect(text).not.toContain("Term sheet");
    writeFileSync(p, "y".repeat(LOG_MAX_BYTES + 1));
    const off2 = installBrainLogging({ file: p });
    try {
      console.error("after");
    } finally {
      off2();
    }
    expect(statSync(p).size).toBeLessThan(1000);
    expect(existsSync(`${p}.1`)).toBe(true);
  });

  test("LOG: scrubbing drops addresses, quoted text, control and format characters, and caps the length", () => {
    const s = scrubLogText(`to ana@fund.vc said "hello there" ‮end\u0007 ${"z".repeat(2000)}`);
    expect(s).not.toContain("ana@fund.vc");
    expect(s).not.toContain("hello there");
    expect(/[\u0000-\u0008‮]/.test(s)).toBe(false);
    expect(s.length).toBeLessThanOrEqual(500);
  });

  test("LOG: serve --log-file writes the brain's startup lines there, not the token", async () => {
    const p = join(home, "brain.err.log");
    const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
    const proc = Bun.spawn(["bun", "run", cli, "serve", "--home", join(home, "h"), "--port", "0", "--model", "stub", "--log-file", p], { env: { ...process.env, OFFLOAD_TOKEN: "", OFFLOAD_KEYS: "file" }, stdout: "pipe", stderr: "pipe" });
    try {
      const reader = proc.stdout.getReader();
      const { value } = await reader.read();
      const first = new TextDecoder().decode(value).split("\n")[0]!;
      expect(first.startsWith("OFFLOAD_BRAIN_READY ")).toBe(true);
      const token = (JSON.parse(first.slice("OFFLOAD_BRAIN_READY ".length)) as { token: string }).token;
      for (let i = 0; i < 50 && !existsSync(p); i++) await Bun.sleep(20);
      const text = readFileSync(p, "utf8");
      expect(text).toContain("--model stub");
      expect(text).not.toContain(token);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  test("LOG: the gate log rotates at 5 MB too", async () => {
    const { appendGateLog } = await import("../../src/workflows/gate.ts");
    const p = join(home, "gate-log.jsonl");
    writeFileSync(p, "g".repeat(LOG_MAX_BYTES));
    appendGateLog(p, { at: 1, workflowId: "wf_a", batchHash: "h", mode: "live", tool: "t", toolClass: "side_effect", decision: "deny", reason: "r" });
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(readFileSync(p, "utf8")).toContain('"decision":"deny"');
  });
});
