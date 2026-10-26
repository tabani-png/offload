// s26: a remembered leave_alone choice. The person chose "leave it alone" for a task: nothing is built, and Offload
// stops suggesting it (dashboard suggestions; GET /insights flags it). Choosing any other kind of fix for the task
// later takes it back. File: $OFFLOAD_HOME/left-alone.json (0600, version 1), keyed by task id. No content, no figures.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivate } from "../workflows/store.ts";

export interface LeftAloneEntry {
  taskId: string;
  insightId: string;
  at: number;
}

interface LeftAloneFile {
  version: 1;
  tasks: Record<string, { insightId: string; at: number }>;
}

const TASK_ID_RE = /^t_[A-Za-z0-9_-]{1,64}$/;
export const leftAlonePath = (home: string) => join(home, "left-alone.json");

function readFile(home: string): LeftAloneFile {
  const p = leftAlonePath(home);
  if (!existsSync(p)) return { version: 1, tasks: {} };
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as Partial<LeftAloneFile>;
    const tasks: LeftAloneFile["tasks"] = {};
    for (const [k, e] of Object.entries(v.tasks ?? {})) {
      if (TASK_ID_RE.test(k) && e !== null && typeof e === "object" && typeof e.insightId === "string" && typeof e.at === "number") tasks[k] = { insightId: e.insightId, at: e.at };
    }
    return { version: 1, tasks };
  } catch {
    // An unreadable file forgets the choices (the task is suggested again) rather than hiding work by mistake.
    return { version: 1, tasks: {} };
  }
}

/** Task ids the person chose to leave alone. */
export function leftAloneTasks(home: string): Set<string> {
  return new Set(Object.keys(readFile(home).tasks));
}

export function markLeftAlone(home: string, taskId: string, insightId: string, now: number): LeftAloneEntry {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`bad task id ${taskId}`);
  const f = readFile(home);
  f.tasks[taskId] = { insightId, at: now };
  writePrivate(leftAlonePath(home), JSON.stringify(f, null, 2) + "\n");
  return { taskId, insightId, at: now };
}

/** Takes a task back (another kind of fix was chosen). No-op when it was not left alone. */
export function clearLeftAlone(home: string, taskId: string): void {
  const f = readFile(home);
  if (!(taskId in f.tasks)) return;
  delete f.tasks[taskId];
  writePrivate(leftAlonePath(home), JSON.stringify(f, null, 2) + "\n");
}
