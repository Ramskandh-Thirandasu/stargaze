/**
 * Per-body accuracy tolerances, in arcseconds, shared between the offline
 * fixture tests (ephemeris.test.ts) and the live re-verification against a
 * fresh JPL Horizons epoch (live-verify.test.ts) -- both are checking the
 * model against the same service, so they should be held to the same bar.
 *
 * These are not guesses. JPL publishes nominal errors for this element set
 * over 1800-2050 -- 15" for Mercury, 400" for Jupiter, 600" for Saturn and so
 * on -- because the outer planets are perturbing each other in ways a fixed
 * ellipse cannot express. A single tight tolerance across all eight would be
 * asserting something the model never claimed.
 *
 * Uranus and Neptune get more room than their published longitude error: JPL
 * quotes that separately from distance error, and for the far planets a
 * thousand-kilometre distance error tilts the geocentric direction too.
 *
 * The published figures already cover the whole 1800-2050 window, and error
 * grows toward its edges rather than sitting flat -- the committed fixture
 * epochs reach to 2045 and back to 2021 specifically to exercise that, so
 * Mercury and Uranus carry more headroom than a fit centred on any one date
 * would need.
 */
export const TOLERANCE_ARCSEC: Record<string, number> = {
  Sun: 30,
  Mercury: 30,
  Venus: 30,
  Mars: 60,
  Jupiter: 420,
  Saturn: 620,
  Uranus: 130,
  Neptune: 60,
};

/**
 * The asteroids get a budget that grows away from their solution epoch rather
 * than one flat number, because that is how their error actually behaves.
 *
 * Their elements are a single osculating ellipse with no Jupiter term in it,
 * so the position is near-exact at the epoch and drifts quadratically either
 * side of it. Measured against Horizons across the fixture epochs: about 5"
 * at the epoch, 60" a year and a half out, and a worst case of 806" (Juno)
 * four years out. This curve clears each of those with roughly a third to a
 * half in hand.
 *
 * Writing it as a curve rather than a constant also survives a rebuild: newer
 * elements move the epoch, and a flat bound tuned to today's would start
 * failing on the fixture dates that are then further away from it.
 *
 * Worth keeping in perspective -- 806" is 13 arcminutes, and the phone
 * compass this overlay rides on is out by degrees.
 */
export function asteroidToleranceArcsec(daysFromSolutionEpoch: number): number {
  const years = Math.abs(daysFromSolutionEpoch) / 365.25;
  return 40 + 70 * years * years;
}

/**
 * The Moon's abridged series is good to about 10 arcseconds on its own; with
 * nutation and (reduced-precision) aberration applied, measured worst case
 * across the fixture epochs is under 14", so 25" leaves real margin without
 * hiding a regression the way the old 90" bound (needed before those two
 * corrections existed) would.
 */
export const MOON_TOLERANCE_ARCSEC = 25;
