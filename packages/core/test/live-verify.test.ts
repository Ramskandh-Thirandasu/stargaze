/**
 * Re-verifies the ephemeris against a FRESH JPL Horizons epoch -- "now", not
 * the committed fixture dates. Passing against six fixed dates forever does
 * not prove the model still holds years from now; this is what actually
 * checks that, on a live instant nobody hand-picked. The asteroids need it
 * most: their elements are one osculating solution and they age.
 *
 * Skipped by default, so `npm test` stays offline and fast. Runs only when
 * LIVE_VERIFY is set, which the monthly scheduled workflow does -- see
 * .github/workflows/verify-ephemeris.yml. Never runs as part of the app or
 * any build; this is CI-only, exactly like fetch_reference.py.
 */

import { describe, expect, it } from 'vitest';

import { angularSeparation } from '../src/angles.js';
import { julianDate, terrestrialJulianDate } from '../src/time.js';
import { moonPosition } from '../src/moon.js';
import { ALL_PLANETS, planetPosition, sunPosition, type PlanetName } from '../src/planets.js';
import { ASTEROIDS, asteroidPosition } from '../src/asteroids.js';
import { asteroidTable, planetTable } from './fixtures.js';
import { asteroidToleranceArcsec, TOLERANCE_ARCSEC, MOON_TOLERANCE_ARCSEC } from './tolerances.js';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';

const BODIES: Record<string, string> = {
  Sun: '10',
  Mercury: '199',
  Venus: '299',
  Mars: '499',
  Jupiter: '599',
  Saturn: '699',
  Uranus: '799',
  Neptune: '899',
};
const MOON = '301';

/** Horizons small-body record numbers; the semicolon is what makes them so. */
const ASTEROID_COMMANDS: Record<string, string> = {
  Ceres: '1;',
  Pallas: '2;',
  Juno: '3;',
  Vesta: '4;',
};

function isNumber(cell: string): boolean {
  return cell.trim() !== '' && Number.isFinite(Number(cell));
}

function firstDataRow(result: string): string[] {
  const lines = result.split('\n');
  const start = lines.findIndex((line) => line.startsWith('$$SOE'));
  const end = lines.findIndex((line) => line.startsWith('$$EOE'));
  if (start === -1 || end === -1) throw new Error('no ephemeris rows in the Horizons reply');
  const row = lines.slice(start + 1, end).find((line) => line.trim().length > 0);
  if (!row) throw new Error('empty ephemeris block in the Horizons reply');
  return row.split(',').map((cell) => cell.trim());
}

/**
 * Geocentric RA/Dec from Horizons. `quantity` matters: '1' is astrometric
 * J2000 (what planetPosition/sunPosition return -- no nutation, no
 * aberration), '2' is apparent of date (what moonPosition returns, since it
 * applies both -- see apparent.ts). Mixing these up produces an error in the
 * tens of arcminutes that looks like a model bug and isn't one; the offline
 * fixture (fetch_reference.py) already makes this same distinction, and this
 * has to match it.
 */
async function fetchGeocentric(
  command: string,
  startIso: string,
  stopIso: string,
  quantity: '1' | '2' = '1',
): Promise<{ ra: number; dec: number }> {
  const params = new URLSearchParams({
    format: 'json',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'OBSERVER',
    ANG_FORMAT: 'DEG',
    CSV_FORMAT: 'YES',
    OBJ_DATA: 'NO',
    STEP_SIZE: '1m',
    COMMAND: `'${command}'`,
    CENTER: "'500@399'",
    START_TIME: `'${startIso}'`,
    STOP_TIME: `'${stopIso}'`,
    QUANTITIES: `'${quantity}'`,
  });

  const response = await fetch(`${API}?${params.toString()}`, {
    headers: { 'User-Agent': 'stargaze-live-verify' },
  });
  if (!response.ok) throw new Error(`Horizons HTTP ${response.status} for ${command}`);
  const payload = (await response.json()) as { result: string };

  const row = firstDataRow(payload.result);
  const numbers = row.slice(1).filter(isNumber).map(Number);
  const [ra, dec] = numbers;
  if (ra === undefined || dec === undefined) {
    throw new Error(`could not parse RA/Dec for ${command} from: ${row.join(',')}`);
  }
  return { ra, dec };
}

/** "YYYY-MM-DD HH:MM" in UTC, Horizons' expected format, from "now". */
function horizonsStamp(date: Date): string {
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

describe.skipIf(!process.env.LIVE_VERIFY)('live ephemeris re-verification', () => {
  const now = new Date();
  now.setUTCSeconds(0, 0); // Horizons wants whole minutes
  const later = new Date(now.getTime() + 60000);
  const start = horizonsStamp(now);
  const stop = horizonsStamp(later);

  const jd = julianDate(now);
  const ttJd = terrestrialJulianDate(jd);

  it('matches the Sun at the current instant', async () => {
    const reference = await fetchGeocentric(BODIES.Sun as string, start, stop);
    const computed = sunPosition(planetTable, ttJd);
    const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);
    expect(
      error,
      `Sun at ${start}: off by ${(error * 3600).toFixed(1)}", budget ${TOLERANCE_ARCSEC.Sun}"`,
    ).toBeLessThan((TOLERANCE_ARCSEC.Sun as number) / 3600);
  });

  for (const name of ALL_PLANETS.filter((p) => p !== 'Earth')) {
    it(`matches ${name} at the current instant`, async () => {
      const reference = await fetchGeocentric(BODIES[name] as string, start, stop);
      const computed = planetPosition(planetTable, name as PlanetName, ttJd);
      const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);
      expect(
        error,
        `${name} at ${start}: off by ${(error * 3600).toFixed(1)}", budget ${TOLERANCE_ARCSEC[name]}"`,
      ).toBeLessThan((TOLERANCE_ARCSEC[name] as number) / 3600);
    });
  }

  // The check this file exists for, more than any other. The planets ride a
  // fit that stays honest to 2050; the asteroids ride one osculating solution
  // that goes quietly wrong as the calendar moves away from it, and nothing
  // in the committed fixtures can notice that happening.
  for (const name of ASTEROIDS) {
    it(`matches ${name} at the current instant`, async () => {
      const reference = await fetchGeocentric(ASTEROID_COMMANDS[name] as string, start, stop);
      const computed = asteroidPosition(asteroidTable, planetTable, name, ttJd);
      const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);
      const budget = asteroidToleranceArcsec(ttJd - asteroidTable.solutionEpoch);
      expect(
        error,
        `${name} at ${start}: off by ${(error * 3600).toFixed(1)}", budget ${budget.toFixed(0)}"` +
          ' -- if this fails, rebuild with `python tools/build_asteroids.py`',
      ).toBeLessThan(budget / 3600);
    });
  }

  it('matches the Moon at the current instant', async () => {
    // Quantity 2 (apparent), not 1 -- moonPosition already applies nutation
    // and aberration, so it has to be compared against Horizons' apparent
    // coordinates, exactly as the offline fixture does.
    const reference = await fetchGeocentric(MOON, start, stop, '2');
    const computed = moonPosition(ttJd);
    const error = angularSeparation(computed.ra, computed.dec, reference.ra, reference.dec);
    expect(
      error,
      `Moon at ${start}: off by ${(error * 3600).toFixed(1)}", budget ${MOON_TOLERANCE_ARCSEC}"`,
    ).toBeLessThan(MOON_TOLERANCE_ARCSEC / 3600);
  });
});
