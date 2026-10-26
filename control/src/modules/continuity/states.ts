/**
 * The offboarding state machine of a person (ADR 0107 §1), as data. `active` → `leaving` (end date set; everything
 * runs) → `frozen` (directory deactivation, admin action or end date) → `departed` (all hand-overs closed or 30 days).
 * Anything not in the table is illegal; callers map `IllegalTransition` to 409 conflict.
 */
export type PersonState = "active" | "leaving" | "frozen" | "departed";
export type PersonEvent = "set_end_date" | "clear_end_date" | "freeze" | "depart";

const TABLE: Record<PersonState, Partial<Record<PersonEvent, PersonState>>> = {
  active: { set_end_date: "leaving", freeze: "frozen" },
  leaving: { set_end_date: "leaving", clear_end_date: "active", freeze: "frozen" },
  frozen: { depart: "departed" },
  departed: {},
};

export class IllegalTransition extends Error {
  constructor(
    readonly from: PersonState,
    readonly event: PersonEvent,
  ) {
    super(`a ${from} person cannot ${event.replace(/_/g, " ")}`);
  }
}

export function transition(from: PersonState, event: PersonEvent): PersonState {
  const to = TABLE[from]?.[event];
  if (to === undefined) throw new IllegalTransition(from, event);
  return to;
}

export function canTransition(from: PersonState, event: PersonEvent): boolean {
  return TABLE[from]?.[event] !== undefined;
}

/** A departed-or-frozen person's identity is never used to send (ADR 0107 §4). */
export const GONE: readonly PersonState[] = ["frozen", "departed"];

/** Days after the freeze when a person is departed even with hand-overs still open (ADR 0107 §1). */
export const DEPART_AFTER_DAYS = 30;
/** Days the departed person's unpromoted proposals are kept for the admin (ADR 0107 §7). */
export const PROPOSALS_KEPT_DAYS = 90;
