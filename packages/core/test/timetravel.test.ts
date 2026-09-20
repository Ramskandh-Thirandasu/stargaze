/**
 * The time-travel clock: stepping, the edges of the ephemeris, and the one
 * predicate the whole "you are not looking at now" warning hangs off.
 */

import { describe, expect, it } from 'vitest';
import {
  boundsFromYears,
  clampOffset,
  DAY_MS,
  formatOffset,
  HOUR_MS,
  isPresent,
  scrubRate,
} from '../src/timetravel.js';

const NOW = Date.UTC(2026, 8, 19, 21, 30);
const BOUNDS = boundsFromYears(1800, 2050);

describe('is this now', () => {
  it('treats zero as the present', () => {
    expect(isPresent(0)).toBe(true);
  });

  it('ignores offsets too small to see in the sky', () => {
    expect(isPresent(30000)).toBe(true);
    expect(isPresent(-30000)).toBe(true);
  });

  it('calls anything from a couple of minutes out time travel, in both directions', () => {
    expect(isPresent(2 * 60000)).toBe(false);
    expect(isPresent(-2 * 60000)).toBe(false);
  });
});

describe('bounds', () => {
  it('covers the whole of the last valid year, not just its first instant', () => {
    expect(new Date(BOUNDS.earliestMs).getUTCFullYear()).toBe(1800);
    expect(new Date(BOUNDS.latestMs).getUTCFullYear()).toBe(2050);
    expect(new Date(BOUNDS.latestMs).getUTCMonth()).toBe(11);
    expect(new Date(BOUNDS.latestMs).getUTCDate()).toBe(31);
  });
});

describe('clamping', () => {
  it('leaves an ordinary step alone', () => {
    expect(clampOffset(3 * HOUR_MS, NOW, BOUNDS)).toBe(3 * HOUR_MS);
    expect(clampOffset(-14 * DAY_MS, NOW, BOUNDS)).toBe(-14 * DAY_MS);
  });

  it('stops at the last date the planetary theory is fit for', () => {
    const far = clampOffset(500 * 365 * DAY_MS, NOW, BOUNDS);
    expect(NOW + far).toBe(BOUNDS.latestMs);
  });

  it('stops at the first one, going back', () => {
    const far = clampOffset(-500 * 365 * DAY_MS, NOW, BOUNDS);
    expect(NOW + far).toBe(BOUNDS.earliestMs);
  });

  it('is idempotent, so holding the control against the edge does not creep', () => {
    const once = clampOffset(1e15, NOW, BOUNDS);
    expect(clampOffset(once, NOW, BOUNDS)).toBe(once);
  });
});

describe('scrub rate', () => {
  it('sits still at rest', () => {
    expect(scrubRate(0)).toBe(0);
  });

  it('runs backwards for a backwards deflection', () => {
    expect(scrubRate(-0.5)).toBe(-scrubRate(0.5));
  });

  it('gives fine control near the middle and speed at the ends', () => {
    // A third of the travel should still be minutes per second, so an object
    // can be walked across a rooftop; full deflection should cross days.
    const gentle = scrubRate(1 / 3) * 1000;
    expect(gentle).toBeGreaterThan(60000);
    expect(gentle).toBeLessThan(2 * HOUR_MS);
    expect(scrubRate(1) * 1000).toBeGreaterThan(DAY_MS);
  });

  it('never runs away past the ends of the control', () => {
    expect(scrubRate(9)).toBe(scrubRate(1));
    expect(scrubRate(-9)).toBe(scrubRate(-1));
  });

  it('rises monotonically across the travel', () => {
    let previous = scrubRate(0);
    for (const deflection of [0.1, 0.25, 0.5, 0.75, 1]) {
      const rate = scrubRate(deflection);
      expect(rate).toBeGreaterThan(previous);
      previous = rate;
    }
  });
});

describe('offset in words', () => {
  it('says now when it is now', () => {
    expect(formatOffset(0)).toBe('now');
    expect(formatOffset(-20000)).toBe('now');
  });

  it('signs both directions', () => {
    expect(formatOffset(3 * HOUR_MS)).toBe('+3h');
    expect(formatOffset(-3 * HOUR_MS)).toBe('-3h');
  });

  it('shows at most two units, largest first', () => {
    expect(formatOffset(2 * DAY_MS + 4 * HOUR_MS + 31 * 60000)).toBe('+2d 4h');
    expect(formatOffset(4 * HOUR_MS + 31 * 60000)).toBe('+4h 31m');
    expect(formatOffset(31 * 60000)).toBe('+31m');
  });

  it('drops a zero unit rather than printing it', () => {
    expect(formatOffset(2 * DAY_MS)).toBe('+2d');
  });

  it('switches to years once days stop being readable', () => {
    expect(formatOffset(3653 * DAY_MS)).toBe('+10.0y');
  });
});
