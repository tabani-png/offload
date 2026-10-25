// s13: the computer-use run's kill switch and the pointer overlay hook.
// Kill switch: POST /computer/stop (the app maps Esc and its menu item to it), the workflow's abort signal (pause,
// delete) and "you moved the pointer" all stop the run before its next action. Pointer hook (Clicky-style, research 11
// B5/B7): every pointer action emits { x, y, label, action, at } so the app can fly a glyph to the control Offload is
// about to use. The overlay never takes focus or clicks; it is drawn by the app later, the brain only reports.
import type { ComputerSessionDTO } from "../../api/types.ts";

export interface PointerEvent {
  x: number;
  y: number;
  label: string;
  action: string;
  at: number;
}

export interface PointerSink {
  pointer(e: PointerEvent): void;
}

export class KillSwitch {
  private why: string | null = null;
  private readonly listeners: Array<(reason: string) => void> = [];

  get stopped(): boolean {
    return this.why !== null;
  }
  get reason(): string | null {
    return this.why;
  }
  stop(reason: string): void {
    if (this.why !== null) return;
    this.why = reason;
    for (const l of this.listeners) l(reason);
  }
  onStop(l: (reason: string) => void): void {
    this.listeners.push(l);
  }
  /** Stops when `signal` aborts (pause, delete). */
  link(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    if (signal.aborted) this.stop("the workflow was paused or deleted");
    else signal.addEventListener("abort", () => this.stop("the workflow was paused or deleted"), { once: true });
  }
}

export const STOP_REASONS = {
  user: "You stopped Offload.",
  pointer: "You moved the pointer, so Offload stopped and handed control back.",
  paused: "The workflow was paused or deleted.",
} as const;

/** The one computer-use run at a time (the screen has one pointer), for the routes and the overlay. */
export class ComputerSessions implements PointerSink {
  private current: { workflowId: string; targetId: string; kill: KillSwitch } | null = null;
  private last: PointerEvent | null = null;
  private lastStop: string | null = null;
  private wasStopped = false;
  private readonly sinks: PointerSink[] = [];

  addSink(s: PointerSink): void {
    this.sinks.push(s);
  }

  begin(workflowId: string, targetId: string, signal?: AbortSignal): KillSwitch {
    if (this.current !== null) throw new Error("another computer-use run is in progress");
    const kill = new KillSwitch();
    kill.link(signal);
    kill.onStop((r) => {
      this.lastStop = r;
      this.wasStopped = true;
    });
    this.current = { workflowId, targetId, kill };
    this.wasStopped = false;
    this.lastStop = null;
    return kill;
  }

  end(kill: KillSwitch): void {
    if (this.current?.kill === kill) this.current = null;
  }

  /** POST /computer/stop. True when a run was stopped. */
  stop(reason: string = STOP_REASONS.user): boolean {
    if (this.current === null) return false;
    this.current.kill.stop(reason);
    return true;
  }

  pointer(e: PointerEvent): void {
    this.last = e;
    for (const s of this.sinks) s.pointer(e);
  }

  dto(): ComputerSessionDTO {
    return {
      running: this.current !== null,
      workflowId: this.current?.workflowId ?? null,
      targetId: this.current?.targetId ?? null,
      pointer: this.last === null ? null : { ...this.last },
      stopped: this.current?.kill.stopped ?? this.wasStopped,
      stopReason: this.current?.kill.reason ?? this.lastStop,
    };
  }
}
