// working_time_aggregate: one person-day of active minutes and the first/last active 15-minute slot. Built only when
// G2 allows it (sync/consent.ts); nothing per app or per span.
import type { ProjectionContext, WorkingTimeAggregate, WorkingTimeInput } from "../types.ts";

const quarter = (minute: number) => Math.min(95, Math.max(0, Math.floor(minute / 15)));

export function projectWorkingTime(i: WorkingTimeInput, ctx: ProjectionContext): WorkingTimeAggregate {
  return {
    id: ctx.ids("working_time_aggregate", i.day, i.dayEnd),
    kind: "working_time_aggregate",
    createdAt: i.dayEnd,
    day: i.day,
    activeMinutes: Math.min(1440, Math.max(0, Math.floor(i.activeSeconds / 60))),
    firstActiveQuarter: quarter(i.firstActiveMinute),
    lastActiveQuarter: quarter(i.lastActiveMinute),
    noticeVersionId: i.noticeVersionId,
  };
}
