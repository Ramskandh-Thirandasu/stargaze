/**
 * The visibility model, checked against physical intuition the same way the
 * rest of this package is: what happens at noon, what happens at true dark,
 * and that the model moves the right direction through the twilight bands.
 */

import { describe, expect, it } from 'vitest';
import { limitingMagnitude } from '../src/visibility.js';

describe('limiting magnitude', () => {
  it('leaves only the Moon and Venus-brightness objects visible at midday', () => {
    const limit = limitingMagnitude(60, -10, 0);
    expect(limit).toBeLessThan(-3);
    // Venus at its brightest (~-4.4 to -3.9) should still clear this.
    expect(limit).toBeLessThan(-3.9);
  });

  it('reaches the catalogue ceiling under a fully dark, moonless sky', () => {
    const limit = limitingMagnitude(-30, -10, 0);
    expect(limit).toBeCloseTo(6.5, 5);
  });

  it('sits in the "brightest planets and first-magnitude stars" band at the end of civil twilight', () => {
    const limit = limitingMagnitude(-6, -10, 0);
    expect(limit).toBeGreaterThan(1);
    expect(limit).toBeLessThan(3);
  });

  it('sits in the published magnitude 3-4 band at the end of nautical twilight', () => {
    const limit = limitingMagnitude(-12, -10, 0);
    expect(limit).toBeGreaterThanOrEqual(3);
    expect(limit).toBeLessThanOrEqual(4);
  });

  it('gets fainter monotonically as the Sun goes down', () => {
    let previous = limitingMagnitude(10, -10, 0);
    for (const sun of [5, 0, -3, -6, -9, -12, -15, -18, -25]) {
      const limit = limitingMagnitude(sun, -10, 0);
      expect(limit).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = limit;
    }
  });

  it('is unaffected by a Moon below the horizon', () => {
    const withMoonDown = limitingMagnitude(-30, -5, 1);
    const withNoMoonTerm = limitingMagnitude(-30, -30, 0);
    expect(withMoonDown).toBeCloseTo(withNoMoonTerm, 5);
  });

  it('is unaffected by a new Moon, however high', () => {
    const newMoonHigh = limitingMagnitude(-30, 80, 0);
    const noMoon = limitingMagnitude(-30, -10, 0);
    expect(newMoonHigh).toBeCloseTo(noMoon, 5);
  });

  it('washes out the sky more as a lit Moon climbs higher', () => {
    const low = limitingMagnitude(-30, 10, 1);
    const high = limitingMagnitude(-30, 80, 1);
    expect(high).toBeLessThan(low);
  });

  it('washes out the sky more as the Moon gets brighter, at fixed altitude', () => {
    const crescent = limitingMagnitude(-30, 60, 0.1);
    const full = limitingMagnitude(-30, 60, 1.0);
    expect(full).toBeLessThan(crescent);
  });

  it('never brightens the limit past a full Moon overhead on an otherwise perfect night', () => {
    const worst = limitingMagnitude(-30, 90, 1);
    // Catalogue ceiling (6.5) minus the maximum modelled Moon penalty (2.5).
    expect(worst).toBeCloseTo(6.5 - 2.5, 5);
  });
});
