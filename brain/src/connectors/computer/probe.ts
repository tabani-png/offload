// s13: the computer method's probe. Computer use is the last resort and is off until the person turns it on
// (OFFLOAD_COMPUTER_REAL=1 for now; the app's switch later). When on, the driver must report Accessibility and Screen
// Recording granted and the app on this Mac (a bundle id it can find) or a host it can open in the browser.
import { CHAIN_WORDS, result, type ChainDeps, type ProbeResult } from "../chain.ts";
import { SCREEN_READ, type ChainTarget } from "../targets.ts";
import type { ComputerDriver } from "./driver.ts";

export interface ComputerProbe {
  probe(t: ChainTarget, d: ChainDeps): Promise<ProbeResult>;
}

/** The capabilities computer use offers for a target: reading the screen and the target's commits. */
export function computerCapabilities(t: ChainTarget, server: string): { reads: string[]; writes: string[]; tools: Record<string, string> } {
  return { reads: [SCREEN_READ], writes: [...t.sends], tools: { [SCREEN_READ]: `mcp__${server}__read`, ...Object.fromEntries(t.sends.map((c) => [c, `mcp__${server}__commit`])) } };
}

export const computerServer = (targetId: string) => `computer_${targetId.replace(/-/g, "_")}`;

/** Default: off. */
export class DisabledComputerProbe implements ComputerProbe {
  async probe(): Promise<ProbeResult> {
    return result("skipped", "computer_off", CHAIN_WORDS.computerOff);
  }
}

export class DriverComputerProbe implements ComputerProbe {
  constructor(private readonly driver: ComputerDriver) {}

  async probe(t: ChainTarget, d: ChainDeps): Promise<ProbeResult> {
    const t0 = d.now();
    const p = await this.driver.permissions();
    if (!p.accessibility || !p.screenRecording) return result("skipped", "no_permission", CHAIN_WORDS.computerNoAccess, {}, d.now() - t0);
    if (!(await this.driver.appPresent(t))) return result("skipped", "app_missing", CHAIN_WORDS.computerNoApp(t.name), {}, d.now() - t0);
    return result("ok", "ok", null, computerCapabilities(t, computerServer(t.id)), d.now() - t0);
  }
}
