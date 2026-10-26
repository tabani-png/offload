// s23: the one rounding rule for hours, shared by every figure the brain shows on the time screen and mirrored by the
// app's HoursFormat. Tenths of an hour, half up, with a 1e-9 guard so binary fractions like 24.65 (24.6499... in
// floating point) round the way a person rounds them: 1479 min = 24.65 h -> "24.7 h" (printf %.1f says 24.6).

/** Whole tenths of an hour, half up: floor(hours x 10 + 0.5 + 1e-9). */
export function hoursTenths(hours: number): number {
  return Math.floor(hours * 10 + 0.5 + 1e-9);
}

/** "<tenths / 10 with one decimal> h", e.g. formatHours(24.65) = "24.7 h". */
export function formatHours(hours: number): string {
  return `${(hoursTenths(hours) / 10).toFixed(1)} h`;
}

/** Minutes are shown as hours with the same rule. */
export const formatMinutesAsHours = (minutes: number): string => formatHours(minutes / 60);
