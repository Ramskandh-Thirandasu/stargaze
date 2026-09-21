/**
 * How bright the sky itself is, and what that leaves visible.
 *
 * A star's catalogue magnitude alone does not say whether a phone could
 * actually see it: the sky background does most of the work. Two things
 * brighten it -- the Sun, even below the horizon, and the Moon, when it is up
 * and lit. Both raise the faintest magnitude that is actually observable,
 * which is a different number from the catalogue's own ceiling
 * (packages/web/public/data/stars.json stops at 6.5, the naked-eye limit under
 * a genuinely dark sky) and a different number again from the user's own
 * magnitude setting, which is a preference rather than a measurement.
 *
 * This is deliberately not astronomical-twilight-table precision. The bands
 * below are derived from where each twilight boundary is conventionally
 * drawn and what becomes visible there, not copied from a lookup table --
 * see the breakpoints for the reasoning at each one.
 */

/**
 * Faintest magnitude a phone could plausibly show right now, from solar
 * altitude and the Moon alone, before anything else (light pollution, haze)
 * makes it worse. Smaller/more-negative is brighter-only; larger is fainter
 * objects becoming visible too.
 */
export function limitingMagnitude(
  sunAltitude: number,
  moonAltitude: number,
  moonIllumination: number,
): number {
  return twilightLimit(sunAltitude) - moonPenalty(moonAltitude, moonIllumination);
}

/**
 * The solar-altitude term, piecewise linear between the conventional
 * twilight boundaries so the model has no discontinuity to explain.
 *
 *   sun > 0 deg (day):        -4.0  -- only Venus (mag ~-4) and the Moon
 *                                      stand a chance against a daylit sky.
 *   sun = -6 (civil end):     +2.0  -- the brightest planets and a handful
 *                                      of first-magnitude stars (Sirius,
 *                                      Vega, Arcturus) are typically <2.
 *   sun = -12 (nautical end): +4.0  -- squarely in the "magnitude 3-4" band
 *                                      the spec for this asks for.
 *   sun = -18 (astronomical
 *              end) and below: 6.5  -- the catalogue's own ceiling; the sky
 *                                      is dark enough that the observer and
 *                                      the phone, not the sky, are the
 *                                      limiting factor. A suburban sky never
 *                                      gets here in practice, which is what
 *                                      the user's magnitude setting is for --
 *                                      this function models the sky, not the
 *                                      light pollution standing on it.
 */
function twilightLimit(sunAltitude: number): number {
  const BREAKPOINTS: [sun: number, limit: number][] = [
    [0, -4.0],
    [-6, 2.0],
    [-12, 4.0],
    [-18, 6.5],
  ];

  if (sunAltitude >= (BREAKPOINTS[0]?.[0] as number)) return BREAKPOINTS[0]?.[1] as number;
  const last = BREAKPOINTS[BREAKPOINTS.length - 1] as [number, number];
  if (sunAltitude <= last[0]) return last[1];

  for (let i = 0; i + 1 < BREAKPOINTS.length; i += 1) {
    const [sunHi, limHi] = BREAKPOINTS[i] as [number, number];
    const [sunLo, limLo] = BREAKPOINTS[i + 1] as [number, number];
    if (sunAltitude <= sunHi && sunAltitude >= sunLo) {
      const t = (sunAltitude - sunHi) / (sunLo - sunHi);
      return limHi + (limLo - limHi) * t;
    }
  }
  return last[1]; // unreachable given the bounds checks above
}

/** A full Moon directly overhead is the worst case this models. */
const MAX_MOON_PENALTY = 2.5;

/**
 * How many magnitudes the Moon washes out, on top of the twilight term.
 *
 * Scales with how lit it is (a crescent barely matters) and how high it is
 * (below the horizon it does nothing, and its glow falls off away from the
 * zenith the same rough way atmospheric brightening does for any source).
 * Only matters at night -- in daylight the twilight term already dominates
 * and the Moon adds nothing measurable on top of the Sun.
 */
function moonPenalty(moonAltitude: number, moonIllumination: number): number {
  if (moonAltitude <= 0) return 0;
  const heightFactor = Math.sin((moonAltitude * Math.PI) / 180);
  return MAX_MOON_PENALTY * Math.max(0, Math.min(1, moonIllumination)) * heightFactor;
}
