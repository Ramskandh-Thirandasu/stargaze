/**
 * Ephemeris tests, against JPL Horizons.
 *
 * The geometry tests prove the transforms are self-consistent. These prove the
 * positions are actually right, by comparing against the same service that
 * produced the orbital elements in the first place.
 *
 * Fixtures come from `python tools/fetch_reference.py`; the tests run offline.
 */

import { describe, expect, it } from 'vitest';

import { angularSeparation } from '../src/angles.js';
import { dateFromJulian, localSiderealTime, julianDate, terrestrialJulianDate } from '../src/time.js';
import { moonPosition, moonPhaseName } from '../src/moon.js';
import { ALL_PLANETS, planetPosition, sunPosition, VISIBLE_PLANETS } from '../src/planets.js';
import type { PlanetName } from '../src/planets.js';
import { arcseconds, horizons, parseUtc, planetTable } from './fixtures.js';
import { TOLERANCE_ARCSEC, MOON_TOLERANCE_ARCSEC } from './tolerances.js';

const asDegrees = (arcsec: number): number => arcsec / 3600;

const MOON_TOLERANCE_DEG = asDegrees(MOON_TOLERANCE_ARCSEC);

describe('the Sun', () => {
  it('matches Horizons at every epoch', () => {
    for (const reference of horizons.geocentric.Sun ?? []) {
      const jd = terrestrialJulianDate(julianDate(parseUtc(reference.utc)));
      const computed = sunPosition(planetTable, jd);
      const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);

      expect(
        error,
        `Sun at ${reference.utc}: off by ${arcseconds(error).toFixed(1)}"`,
      ).toBeLessThan(asDegrees(TOLERANCE_ARCSEC.Sun as number));
    }
  });

  it('reaches its northern extreme at the June solstice', () => {
    // The Sun's declination at the solstice IS the Earth's axial tilt.
    const jd = julianDate(new Date('2025-06-21T03:30:00Z'));
    expect(sunPosition(planetTable, jd).dec).toBeCloseTo(23.44, 1);
  });

  it('crosses the equator on the day of the March equinox', () => {
    // Solve for the crossing rather than asserting a remembered instant: this
    // tests the model, not the almanac entry in the author's head.
    let low = julianDate(new Date('2026-03-18T00:00:00Z'));
    let high = julianDate(new Date('2026-03-23T00:00:00Z'));
    expect(sunPosition(planetTable, low).dec).toBeLessThan(0);
    expect(sunPosition(planetTable, high).dec).toBeGreaterThan(0);

    for (let step = 0; step < 60; step += 1) {
      const middle = (low + high) / 2;
      if (sunPosition(planetTable, middle).dec < 0) low = middle;
      else high = middle;
    }

    const equinox = dateFromJulian((low + high) / 2);
    expect(equinox.toISOString().slice(0, 10)).toBe('2026-03-20');
  });
});

describe('planets', () => {
  // Every planet is verified, including the two the app never draws: they
  // exercise the Kepler solver across the widest range of orbits available.
  for (const name of ALL_PLANETS.filter((p) => p !== 'Earth')) {
    it(`${name} matches Horizons at every epoch`, () => {
      const rows = horizons.geocentric[name];
      expect(rows, `no fixture rows for ${name}`).toBeTruthy();

      for (const reference of rows ?? []) {
        const jd = terrestrialJulianDate(julianDate(parseUtc(reference.utc)));
        const computed = planetPosition(planetTable, name as PlanetName, jd);
        const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);

        expect(
          error,
          `${name} at ${reference.utc}: off by ${arcseconds(error).toFixed(1)}", ` +
            `budget ${TOLERANCE_ARCSEC[name]}"`,
        ).toBeLessThan(asDegrees(TOLERANCE_ARCSEC[name] as number));
      }
    });
  }

  it('offers every planet but Earth, and lets the magnitude limit do the filtering', () => {
    expect([...VISIBLE_PLANETS]).toEqual([
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ]);
    expect(VISIBLE_PLANETS).not.toContain('Earth');

    // The honesty rule, restated as an assertion: the two faint ones are in
    // the list, but their own magnitudes keep them out of the default view --
    // the renderer draws nothing fainter than the user's setting, which starts
    // at 4.5 and reaches the catalogue ceiling of 6.5.
    const jd = julianDate(new Date('2026-01-08T19:45:00Z'));
    expect(planetPosition(planetTable, 'Uranus', jd).magnitude).toBeGreaterThan(4.5);
    expect(planetPosition(planetTable, 'Uranus', jd).magnitude).toBeLessThan(6.5);
    // Neptune has never been a naked-eye object and never clears the ceiling.
    expect(planetPosition(planetTable, 'Neptune', jd).magnitude).toBeGreaterThan(6.5);

    // The five everyone has always been able to see are comfortably in reach.
    for (const name of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'] as const) {
      expect(planetPosition(planetTable, name, jd).magnitude).toBeLessThan(5);
    }
  });

  it('puts the planets at plausible distances', () => {
    const jd = julianDate(new Date('2026-01-08T19:45:00Z'));
    // Sanity bounds straight off the orbits, to catch a unit slip.
    expect(planetPosition(planetTable, 'Venus', jd).heliocentricDistance).toBeCloseTo(0.72, 1);
    expect(planetPosition(planetTable, 'Jupiter', jd).heliocentricDistance).toBeCloseTo(5.2, 0);
    expect(planetPosition(planetTable, 'Neptune', jd).heliocentricDistance).toBeCloseTo(30, 0);
  });

  it('gives Venus and Jupiter their familiar brightnesses', () => {
    const jd = julianDate(new Date('2026-01-08T19:45:00Z'));
    // Venus is always the brightest thing after the Sun and Moon.
    const venus = planetPosition(planetTable, 'Venus', jd).magnitude;
    expect(venus).toBeGreaterThan(-5);
    expect(venus).toBeLessThan(-3);

    const jupiter = planetPosition(planetTable, 'Jupiter', jd).magnitude;
    expect(jupiter).toBeGreaterThan(-3);
    expect(jupiter).toBeLessThan(-1.5);

    // Neptune has never been visible to the naked eye.
    expect(planetPosition(planetTable, 'Neptune', jd).magnitude).toBeGreaterThan(7);
  });
});

describe('the Moon', () => {
  it('matches Horizons geocentrically', () => {
    for (const reference of horizons.moonGeocentric) {
      const jd = terrestrialJulianDate(julianDate(parseUtc(reference.utc)));
      const computed = moonPosition(jd);
      const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);

      expect(
        error,
        `Moon (geocentric) at ${reference.utc}: off by ${arcseconds(error).toFixed(1)}"`,
      ).toBeLessThan(MOON_TOLERANCE_DEG);
    }
  });

  it('matches Horizons from an observer on the surface', () => {
    const { lat, lon, elevation_km } = horizons.site;
    const observer = { latitude: lat, longitude: lon, elevation: elevation_km * 1000 };

    for (const reference of horizons.moonTopocentric) {
      const jd = julianDate(parseUtc(reference.utc));
      const lst = localSiderealTime(jd, lon);
      const computed = moonPosition(terrestrialJulianDate(jd), observer, lst);
      const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);

      expect(
        error,
        `Moon (topocentric) at ${reference.utc}: off by ${arcseconds(error).toFixed(1)}"`,
      ).toBeLessThan(MOON_TOLERANCE_DEG);
    }
  });

  it('is moved substantially by the observer standing on the surface', () => {
    // The whole reason moonPosition takes an observer: parallax is up to a
    // degree, which is two Moon-widths. Skipping it misses the target.
    const { lat, lon } = horizons.site;
    const jd = julianDate(new Date('2026-01-08T19:45:00Z'));
    const lst = localSiderealTime(jd, lon);

    const geocentric = moonPosition(jd);
    const topocentric = moonPosition(jd, { latitude: lat, longitude: lon }, lst);
    const shift = angularSeparation(
      geocentric.ra,
      geocentric.dec,
      topocentric.ra,
      topocentric.dec,
    );

    expect(shift).toBeGreaterThan(0.1);
    expect(shift).toBeLessThan(1.1);
  });

  it('stays the right size and distance', () => {
    const jd = julianDate(new Date('2026-01-08T19:45:00Z'));
    const moon = moonPosition(jd);
    expect(moon.distance).toBeGreaterThan(356000);
    expect(moon.distance).toBeLessThan(407000);
    // Always close to half a degree across -- the reason total eclipses work.
    expect(moon.angularDiameter).toBeGreaterThan(0.48);
    expect(moon.angularDiameter).toBeLessThan(0.57);
  });

  it('is full when it is opposite the Sun', () => {
    // Full moon of 2026-01-03, near enough.
    const jd = julianDate(new Date('2026-01-03T10:03:00Z'));
    const moon = moonPosition(jd);
    const sun = sunPosition(planetTable, jd);
    const elongation = angularSeparation(moon.ra, moon.dec, sun.ra, sun.dec);

    expect(elongation).toBeGreaterThan(170);
    expect(moon.illumination).toBeGreaterThan(0.98);
    expect(moonPhaseName(moon.phase)).toBe('Full moon');
  });

  it('names the phases across a full cycle', () => {
    expect(moonPhaseName(0)).toBe('New moon');
    expect(moonPhaseName(0.25)).toBe('First quarter');
    expect(moonPhaseName(0.5)).toBe('Full moon');
    expect(moonPhaseName(0.75)).toBe('Last quarter');
    expect(moonPhaseName(0.6)).toBe('Waning gibbous');
    expect(moonPhaseName(0.1)).toBe('Waxing crescent');
  });
});
