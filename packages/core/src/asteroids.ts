/**
 * The four bright minor planets: Vesta, Ceres, Pallas and Juno.
 *
 * The orbital mechanics are the planets' -- same Kepler solve, same rotation
 * into equatorial, same light-time correction, all of it reached through
 * `geocentricPosition` rather than copied. Two things differ, and both are
 * here:
 *
 *   - the elements are a single osculating solution rather than a fitted
 *     polynomial, so they carry a validity window and go quietly wrong
 *     outside it. See {@link asteroidsValidAt}.
 *   - brightness follows the IAU H-G law rather than the Almanac's
 *     per-planet polynomials. A rock's phase curve is much sharper than a
 *     gas giant's, which is most of why Vesta swings between magnitude 5 and
 *     magnitude 8 over a couple of years.
 */

import { toRadians } from './angles.js';
import { geocentricPosition, type BodyPosition, type PlanetEntry, type PlanetTable } from './planets.js';

export interface AsteroidEntry extends PlanetEntry {
  /** Catalogue designation, e.g. "4 Vesta". */
  designation: string;
  /** Absolute magnitude: how bright it would be 1 au from both Sun and Earth. */
  H: number;
  /** IAU H-G slope parameter -- how fast it dims away from full phase. */
  G: number;
}

/** Shape of the generated `asteroids.json`. */
export interface AsteroidTable {
  /** Julian date the elements were fitted at; error grows either side of it. */
  solutionEpoch: number;
  /** Calendar years the two-body solution is honest for. */
  validFrom: number;
  validTo: number;
  asteroids: Record<string, AsteroidEntry>;
}

export type AsteroidName = 'Ceres' | 'Pallas' | 'Juno' | 'Vesta';

/**
 * Brightest first at a typical opposition, which is the order the app wants
 * them in and not the numbering order they were discovered in.
 */
export const ASTEROIDS: readonly AsteroidName[] = ['Vesta', 'Ceres', 'Pallas', 'Juno'];

/**
 * Apparent visual magnitude from the IAU two-parameter (H, G) phase law.
 *
 * The two basis functions are the standard empirical fits: Phi1 is the sharp
 * opposition surge, Phi2 the broad wing, and G says how much of each a given
 * surface shows. Outside the fit's 0-120 degree range the tangent blows up,
 * so the phase angle is clamped -- a main-belt asteroid never gets anywhere
 * near it from here, but a clamp is cheaper than a NaN reaching the renderer.
 */
export function asteroidMagnitude(
  h: number,
  g: number,
  heliocentricDistance: number,
  distance: number,
  phaseAngle: number,
): number {
  const halfPhase = toRadians(Math.max(0, Math.min(120, phaseAngle)) / 2);
  const tanHalf = Math.tan(halfPhase);

  const phi1 = Math.exp(-3.33 * Math.pow(tanHalf, 0.63));
  const phi2 = Math.exp(-1.87 * Math.pow(tanHalf, 1.22));

  return (
    h +
    5 * Math.log10(Math.max(1e-9, heliocentricDistance * distance)) -
    2.5 * Math.log10(Math.max(1e-9, (1 - g) * phi1 + g * phi2))
  );
}

/** Geocentric position of one asteroid, J2000, corrected for light time. */
export function asteroidPosition(
  table: AsteroidTable,
  planets: PlanetTable,
  name: AsteroidName,
  jd: number,
): BodyPosition {
  const entry = table.asteroids[name];
  if (!entry) throw new Error(`asteroids.json has no entry for ${name}`);

  return geocentricPosition(planets, entry, jd, (heliocentric, distance, phase) =>
    asteroidMagnitude(entry.H, entry.G, heliocentric, distance, phase),
  );
}

/**
 * Whether the two-body solution still claims to be right at `when`.
 *
 * Unlike the planets, these elements ignore Jupiter, so the error grows out
 * from the solution epoch instead of staying flat. The app keeps drawing past
 * the window -- a slowly-degrading position beats a body that silently
 * vanishes from the sky -- but it has to be able to say so.
 */
export function asteroidsValidAt(table: AsteroidTable, when: Date): boolean {
  const year = when.getUTCFullYear();
  return year >= table.validFrom && year <= table.validTo;
}
