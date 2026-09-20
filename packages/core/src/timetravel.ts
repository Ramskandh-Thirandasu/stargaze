/**
 * Scrubbing the clock.
 *
 * The sky is drawn for `now + offset`, so a single signed offset is the whole
 * of the time-travel state. Relative rather than absolute on purpose: the sky
 * keeps turning while you are away from the present, so a chosen moment
 * behaves like a moment rather than a freeze-frame, and "back to now" is the
 * one value -- zero -- that needs no arithmetic to reach.
 *
 * Nothing here is persisted anywhere. Reopening the app has to land on the
 * present: a stargazer who finds yesterday's sky waiting for them has no way
 * of knowing that is what they are looking at.
 */

export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;

/**
 * Offsets under a minute are the present. The sky turns a quarter of a degree
 * in that time -- far inside the pointing error of any phone -- so calling it
 * anything else would be a distinction nobody can see, and would leave the
 * "you are time travelling" warning on for a rounding error.
 */
export const PRESENT_TOLERANCE_MS = 60000;

export function isPresent(offsetMs: number): boolean {
  return Math.abs(offsetMs) < PRESENT_TOLERANCE_MS;
}

/** The span of instants the ephemeris is fit for. */
export interface ClockBounds {
  earliestMs: number;
  latestMs: number;
}

/**
 * Bounds from the planet table's own validity years (planets.json carries
 * validFrom/validTo). The JPL elements are fit across whole years, so validTo
 * is the last good year rather than the first bad one.
 */
export function boundsFromYears(validFrom: number, validTo: number): ClockBounds {
  return {
    earliestMs: Date.UTC(validFrom, 0, 1),
    latestMs: Date.UTC(validTo + 1, 0, 1) - 1,
  };
}

/**
 * Keep `nowMs + offset` inside the bounds.
 *
 * Clamped rather than refused: someone dragging hard at the end of the range
 * gets the last date the maths is honest about, where a control that simply
 * stops responding reads as broken. Past the edge the planetary theory does
 * not fail loudly, it just quietly drifts -- which is the one outcome worth
 * ruling out.
 */
export function clampOffset(offsetMs: number, nowMs: number, bounds: ClockBounds): number {
  return Math.max(bounds.earliestMs - nowMs, Math.min(bounds.latestMs - nowMs, offsetMs));
}

/** Fastest scrub at full deflection: two days of sky per second of dragging. */
const MAX_SCRUB_RATE = (2 * DAY_MS) / 1000;

/**
 * Sky-milliseconds per real millisecond for a jog-wheel deflection in -1..1.
 *
 * Cubed. A linear response has to choose between being fine enough to walk the
 * Moon along a rooftop and being fast enough to reach next month, and cannot
 * be both; cubing gives the first third of the travel minutes per second and
 * the far end days per second.
 */
export function scrubRate(deflection: number): number {
  const d = Math.max(-1, Math.min(1, deflection));
  return d * d * d * MAX_SCRUB_RATE;
}

/**
 * How far from the present, in words: "+3h 20m", "-2d 4h", "now".
 *
 * Two units at most, largest first. The exact date is shown alongside this --
 * what this adds is the direction and the distance, which is the part that
 * answers "how far out am I" at a glance.
 */
export function formatOffset(offsetMs: number): string {
  if (isPresent(offsetMs)) return 'now';

  const sign = offsetMs < 0 ? '-' : '+';
  const total = Math.abs(offsetMs);

  const days = Math.floor(total / DAY_MS);
  const hours = Math.floor((total % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((total % HOUR_MS) / 60000);

  // Beyond a year, days stop meaning anything -- the range runs to 2050, and
  // "+73048d" is a number nobody can read.
  if (days >= 365) return `${sign}${(days / 365.25).toFixed(1)}y`;
  if (days > 0) return hours > 0 ? `${sign}${days}d ${hours}h` : `${sign}${days}d`;
  if (hours > 0) return minutes > 0 ? `${sign}${hours}h ${minutes}m` : `${sign}${hours}h`;
  return `${sign}${minutes}m`;
}
