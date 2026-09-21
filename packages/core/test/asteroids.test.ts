/**
 * The minor planets, against JPL Horizons.
 *
 * These matter more than the planetary checks, not less: the elements are a
 * single osculating solution with no perturbation terms, so a transcription
 * error and a real modelling limit look identical from the outside. Only an
 * independent ephemeris tells them apart.
 */

import { describe, expect, it } from 'vitest';

import { angularSeparation } from '../src/angles.js';
import { ASTEROIDS, asteroidMagnitude, asteroidPosition, asteroidsValidAt } from '../src/asteroids.js';
import type { AsteroidName } from '../src/asteroids.js';
import { julianDate, terrestrialJulianDate } from '../src/time.js';
import { arcseconds, asteroidTable, horizons, parseUtc, planetTable } from './fixtures.js';
import { asteroidToleranceArcsec } from './tolerances.js';

const asDegrees = (arcsec: number): number => arcsec / 3600;

describe('asteroids', () => {
  for (const name of ASTEROIDS) {
    it(`${name} matches Horizons at every epoch inside the validity window`, () => {
      const rows = horizons.asteroids[name];
      expect(rows, `no fixture rows for ${name}`).toBeTruthy();

      for (const reference of rows ?? []) {
        const jd = terrestrialJulianDate(julianDate(parseUtc(reference.utc)));
        const computed = asteroidPosition(asteroidTable, planetTable, name, jd);
        const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);
        const budget = asteroidToleranceArcsec(jd - asteroidTable.solutionEpoch);

        expect(
          error,
          `${name} at ${reference.utc}: off by ${arcseconds(error).toFixed(1)}", ` +
            `budget ${budget.toFixed(0)}"`,
        ).toBeLessThan(asDegrees(budget));
      }
    });
  }

  it('ships all four and no Earth-crossers', () => {
    expect([...ASTEROIDS]).toEqual(['Vesta', 'Ceres', 'Pallas', 'Juno']);
    for (const name of ASTEROIDS) {
      const entry = asteroidTable.asteroids[name];
      expect(entry, `asteroids.json has no ${name}`).toBeTruthy();
      // Every one of these is a main-belt body between Mars and Jupiter. A
      // semi-major axis outside that band means the wrong object was fetched.
      expect(entry?.elements.a).toBeGreaterThan(2.1);
      expect(entry?.elements.a).toBeLessThan(3.3);
      expect(entry?.designation).toMatch(/^\d+ /);
    }
  });

  it('puts Vesta within naked-eye reach at a good opposition, and Ceres just past it', () => {
    // Vesta's 2026 opposition. The claim the app makes by drawing these at
    // all: the brightest of them genuinely clears the dark-sky limit.
    let brightest = 99;
    for (let day = 0; day < 365; day += 1) {
      const jd = julianDate(new Date(Date.UTC(2026, 0, 1 + day)));
      brightest = Math.min(brightest, asteroidPosition(asteroidTable, planetTable, 'Vesta', jd).magnitude);
    }
    expect(brightest).toBeLessThan(6.5);

    // Ceres never quite gets there, which is why it is drawn dimmed rather
    // than not drawn: honest about being a binocular object.
    let ceres = 99;
    for (let day = 0; day < 365; day += 1) {
      const jd = julianDate(new Date(Date.UTC(2026, 0, 1 + day)));
      ceres = Math.min(ceres, asteroidPosition(asteroidTable, planetTable, 'Ceres', jd).magnitude);
    }
    expect(ceres).toBeGreaterThan(6.5);
    expect(ceres).toBeLessThan(8);
  });

  it('dims a rock as it turns away from us', () => {
    // The whole point of the H-G law over a plain inverse-square: at the same
    // distances, a body seen half-lit is markedly fainter than one at full.
    const full = asteroidMagnitude(3.25, 0.32, 2.36, 1.36, 0);
    const oblique = asteroidMagnitude(3.25, 0.32, 2.36, 1.36, 25);
    expect(oblique).toBeGreaterThan(full + 0.3);

    // And an absolute magnitude at 1 au from both is, by definition, H.
    expect(asteroidMagnitude(5, 0.15, 1, 1, 0)).toBeCloseTo(5, 6);
  });

  it('knows when its two-body solution has run out', () => {
    expect(asteroidTable.validTo - asteroidTable.validFrom).toBeGreaterThanOrEqual(6);
    expect(asteroidsValidAt(asteroidTable, new Date(`${asteroidTable.validFrom}-06-01T00:00:00Z`))).toBe(true);
    expect(asteroidsValidAt(asteroidTable, new Date(`${asteroidTable.validTo}-06-01T00:00:00Z`))).toBe(true);
    expect(asteroidsValidAt(asteroidTable, new Date(`${asteroidTable.validTo + 1}-06-01T00:00:00Z`))).toBe(false);
    expect(asteroidsValidAt(asteroidTable, new Date(`${asteroidTable.validFrom - 1}-06-01T00:00:00Z`))).toBe(false);
  });

  it('refuses a body it does not have rather than returning a plausible wrong place', () => {
    expect(() =>
      asteroidPosition(asteroidTable, planetTable, 'Hygiea' as AsteroidName, 2460000),
    ).toThrow(/Hygiea/);
  });
});
