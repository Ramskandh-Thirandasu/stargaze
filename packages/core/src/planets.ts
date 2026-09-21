/**
 * Planets and the Sun, from JPL's approximate Keplerian elements.
 *
 * Each planet is treated as a body on a slowly-drifting ellipse. Solve Kepler's
 * equation for where it is on that ellipse, subtract Earth's position to get the
 * view from here, and rotate into equatorial coordinates.
 *
 * Accurate to roughly an arcminute over 1800-2050 -- about a thirtieth of the
 * Moon's width, and far below the several degrees a phone compass contributes.
 */

import { normalize180, normalize360, toDegrees, toRadians } from './angles.js';
import { DAYS_PER_CENTURY, J2000 } from './time.js';
import type { Equatorial } from './coords.js';

/** One set of orbital elements, or their per-century rates. */
export interface KeplerianElements {
  /** Semi-major axis, au. */
  a: number;
  /** Eccentricity. */
  e: number;
  /** Inclination to the ecliptic, degrees. */
  i: number;
  /** Mean longitude, degrees. */
  L: number;
  /** Longitude of perihelion, degrees. */
  peri: number;
  /** Longitude of the ascending node, degrees. */
  node: number;
}

export interface PlanetEntry {
  elements: KeplerianElements;
  rates: KeplerianElements;
}

/** Shape of the generated `planets.json`. */
export interface PlanetTable {
  validFrom: number;
  validTo: number;
  planets: Record<string, PlanetEntry>;
}

export type PlanetName =
  | 'Mercury'
  | 'Venus'
  | 'Earth'
  | 'Mars'
  | 'Jupiter'
  | 'Saturn'
  | 'Uranus'
  | 'Neptune';

/**
 * Every body the elements cover. Used for the maths and the tests, not the UI.
 */
export const ALL_PLANETS: readonly PlanetName[] = [
  'Mercury',
  'Venus',
  'Earth',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
];

/**
 * The planets the app draws -- every one of them bar Earth.
 *
 * Uranus (magnitude ~5.7) is a naked-eye object under a genuinely dark sky, so
 * it belongs in the same list as the five everyone has always been able to see.
 * Neptune (~7.9) never has been, and including it here does not pretend
 * otherwise: nothing in this list is drawn unless it clears the user's
 * magnitude setting, and the sky's own limiting magnitude dims whatever is
 * below it (see visibility.ts). Neptune therefore ships computed, listed, and
 * in practice never drawn -- which is the honest answer rather than a decision
 * taken for the user one level too early.
 */
export const VISIBLE_PLANETS: readonly PlanetName[] = [
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Days light takes to cross one astronomical unit. */
const LIGHT_DAYS_PER_AU = 0.005775518331;

/**
 * Obliquity of the ecliptic at J2000.0, degrees.
 *
 * JPL's elements are referred to the J2000 ecliptic and equinox, so this is the
 * angle that converts them to equatorial -- NOT the obliquity of date. Using
 * the wrong one silently mixes reference frames.
 */
export const OBLIQUITY_J2000 = 23.4392911;

/**
 * Mean obliquity of the ecliptic, degrees -- the tilt between the Earth's
 * equator and its orbital plane, and the hinge every ecliptic-to-equatorial
 * conversion turns on. IAU 1980.
 *
 * Used by the Moon, whose theory works in coordinates of date.
 */
export function meanObliquity(jd: number): number {
  const t = (jd - J2000) / DAYS_PER_CENTURY;
  return (
    23.439291111 -
    0.0130041667 * t -
    1.6388889e-7 * t * t +
    5.0361111e-7 * t * t * t
  );
}

/**
 * Solve Kepler's equation M = E - e*sin(E) for the eccentric anomaly.
 *
 * Newton-Raphson from a decent first guess. Planetary eccentricities are all
 * small, so this converges in three or four passes; the loop bound is a
 * guard against a pathological input rather than an expected cost.
 */
export function solveKepler(meanAnomalyDeg: number, eccentricity: number): number {
  const m = normalize180(meanAnomalyDeg);
  const eStar = toDegrees(eccentricity); // e expressed in degrees, per JPL's write-up

  let e = m + eStar * Math.sin(toRadians(m));

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const eRad = toRadians(e);
    const deltaM = m - (e - eStar * Math.sin(eRad));
    const deltaE = deltaM / (1 - eccentricity * Math.cos(eRad));
    e += deltaE;
    if (Math.abs(deltaE) < 1e-9) break;
  }

  return e;
}

/** One body's elements propagated to `jd`. */
function elementsAt(entry: PlanetEntry, jd: number): KeplerianElements {
  const t = (jd - J2000) / DAYS_PER_CENTURY;
  const { elements, rates } = entry;

  return {
    a: elements.a + rates.a * t,
    e: elements.e + rates.e * t,
    i: elements.i + rates.i * t,
    L: elements.L + rates.L * t,
    peri: elements.peri + rates.peri * t,
    node: elements.node + rates.node * t,
  };
}

/**
 * Heliocentric position in the J2000 ecliptic frame, in au.
 */
export function heliocentricEcliptic(
  table: PlanetTable,
  name: PlanetName,
  jd: number,
): Vec3 {
  const entry = table.planets[name];
  if (!entry) throw new Error(`planets.json has no entry for ${name}`);
  return heliocentricFromEntry(entry, jd);
}

/**
 * The same, from a bare element set.
 *
 * Split out because the asteroids keep their elements in their own file but
 * move on exactly the same ellipse -- see asteroids.ts.
 */
export function heliocentricFromEntry(entry: PlanetEntry, jd: number): Vec3 {
  const { a, e, i, L, peri, node } = elementsAt(entry, jd);

  const argumentOfPerihelion = peri - node;
  const meanAnomaly = L - peri;
  const eccentricAnomaly = toRadians(solveKepler(meanAnomaly, e));

  // Position in the orbital plane, perihelion along +x.
  const xOrbital = a * (Math.cos(eccentricAnomaly) - e);
  const yOrbital = a * Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly);

  const w = toRadians(argumentOfPerihelion);
  const n = toRadians(node);
  const inc = toRadians(i);

  const cosW = Math.cos(w);
  const sinW = Math.sin(w);
  const cosN = Math.cos(n);
  const sinN = Math.sin(n);
  const cosI = Math.cos(inc);
  const sinI = Math.sin(inc);

  return {
    x: (cosW * cosN - sinW * sinN * cosI) * xOrbital + (-sinW * cosN - cosW * sinN * cosI) * yOrbital,
    y: (cosW * sinN + sinW * cosN * cosI) * xOrbital + (-sinW * sinN + cosW * cosN * cosI) * yOrbital,
    z: sinW * sinI * xOrbital + cosW * sinI * yOrbital,
  };
}

/**
 * Rotate a J2000-ecliptic vector into the J2000 equatorial frame.
 *
 * Everything this module returns is therefore J2000. Precess it to the equinox
 * of date before mixing it with sidereal time -- `sky.ts` does that for stars
 * and planets alike, so the two stay in the same frame.
 */
function eclipticToEquatorialJ2000(v: Vec3): Vec3 {
  const eps = toRadians(OBLIQUITY_J2000);
  const cosE = Math.cos(eps);
  const sinE = Math.sin(eps);
  return {
    x: v.x,
    y: cosE * v.y - sinE * v.z,
    z: sinE * v.y + cosE * v.z,
  };
}

/** Right ascension and declination of an equatorial vector. */
function vectorToEquatorial(v: Vec3): Equatorial {
  return {
    ra: normalize360(toDegrees(Math.atan2(v.y, v.x))),
    dec: toDegrees(Math.atan2(v.z, Math.hypot(v.x, v.y))),
  };
}

export interface BodyPosition extends Equatorial {
  /** Distance from the observer, au. */
  distance: number;
  /** Distance from the Sun, au. Zero for the Sun itself. */
  heliocentricDistance: number;
  /** Sun-body-Earth angle, degrees. */
  phaseAngle: number;
  /** Apparent visual magnitude. */
  magnitude: number;
}

/**
 * Geocentric position of anything on a fixed ellipse round the Sun.
 *
 * Corrected for light time: what is seen now is where the body was when the
 * light left it, which for Neptune is four hours ago.
 *
 * `earthTable` is consulted for Earth's own position and nothing else, so an
 * asteroid carrying elements from a separate file still measures itself
 * against the same Earth the planets do. Brightness is the caller's business
 * because it is the one thing that genuinely differs between a planet and a
 * rock: one follows the Almanac's polynomials, the other the IAU's H-G law.
 */
export function geocentricPosition(
  earthTable: PlanetTable,
  entry: PlanetEntry,
  jd: number,
  magnitude: (heliocentricDistance: number, distance: number, phaseAngle: number) => number,
): BodyPosition {
  const earth = heliocentricEcliptic(earthTable, 'Earth', jd);

  let body = heliocentricFromEntry(entry, jd);
  let offset: Vec3 = { x: body.x - earth.x, y: body.y - earth.y, z: body.z - earth.z };
  let distance = Math.hypot(offset.x, offset.y, offset.z);

  // One iteration is plenty: the correction to the correction is milliarcseconds.
  body = heliocentricFromEntry(entry, jd - distance * LIGHT_DAYS_PER_AU);
  offset = { x: body.x - earth.x, y: body.y - earth.y, z: body.z - earth.z };
  distance = Math.hypot(offset.x, offset.y, offset.z);

  const heliocentricDistance = Math.hypot(body.x, body.y, body.z);
  const sunDistance = Math.hypot(earth.x, earth.y, earth.z);

  // Law of cosines on the Sun-body-Earth triangle.
  const cosPhase =
    (heliocentricDistance * heliocentricDistance + distance * distance - sunDistance * sunDistance) /
    (2 * heliocentricDistance * distance);
  const phaseAngle = toDegrees(Math.acos(Math.max(-1, Math.min(1, cosPhase))));

  return {
    ...vectorToEquatorial(eclipticToEquatorialJ2000(offset)),
    distance,
    heliocentricDistance,
    phaseAngle,
    magnitude: magnitude(heliocentricDistance, distance, phaseAngle),
  };
}

/** Geocentric position of a planet. */
export function planetPosition(
  table: PlanetTable,
  name: PlanetName,
  jd: number,
): BodyPosition {
  const entry = table.planets[name];
  if (!entry) throw new Error(`planets.json has no entry for ${name}`);

  return geocentricPosition(table, entry, jd, (heliocentric, distance, phase) =>
    planetMagnitude(name, heliocentric, distance, phase),
  );
}

/**
 * Geocentric position of the Sun.
 *
 * The Sun as seen from Earth is just Earth's heliocentric position reflected
 * through the origin -- no separate theory needed.
 */
export function sunPosition(table: PlanetTable, jd: number): BodyPosition {
  const earth = heliocentricEcliptic(table, 'Earth', jd);
  const offset: Vec3 = { x: -earth.x, y: -earth.y, z: -earth.z };
  const distance = Math.hypot(offset.x, offset.y, offset.z);

  return {
    ...vectorToEquatorial(eclipticToEquatorialJ2000(offset)),
    distance,
    heliocentricDistance: 0,
    phaseAngle: 0,
    magnitude: -26.74,
  };
}

/**
 * Apparent visual magnitude, from the Astronomical Almanac's polynomials.
 *
 * Saturn's rings are ignored: their tilt swings its brightness by up to a
 * magnitude, and modelling it is not worth the code for a label that reads
 * "Saturn, bright".
 */
export function planetMagnitude(
  name: PlanetName,
  heliocentricDistance: number,
  distance: number,
  phaseAngle: number,
): number {
  const base = 5 * Math.log10(Math.max(1e-9, heliocentricDistance * distance));
  const a = phaseAngle;

  switch (name) {
    case 'Mercury':
      return -0.42 + base + 0.038 * a - 0.000273 * a * a + 2e-6 * a * a * a;
    case 'Venus':
      return -4.4 + base + 0.0009 * a + 2.39e-4 * a * a - 6.5e-7 * a * a * a;
    case 'Mars':
      return -1.52 + base + 0.016 * a;
    case 'Jupiter':
      return -9.4 + base + 0.005 * a;
    case 'Saturn':
      return -8.88 + base;
    case 'Uranus':
      return -7.19 + base;
    case 'Neptune':
      return -6.87 + base;
    default:
      return 0;
  }
}
