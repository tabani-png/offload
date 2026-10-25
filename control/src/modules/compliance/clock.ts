import type { Clock } from "../../ports.ts";

/**
 * The app's clock, for the ports this module provides. `ModuleDef.provides` is built before `Deps` exists, so the
 * ports read the clock captured when `routes(app, deps)` mounts the module (one app per process in production).
 */
let current: Clock = { now: () => Date.now() };

export function useClock(c: Clock): void {
  current = c;
}

export function now(): number {
  return current.now();
}
