/**
 * Is there actually sky in front of the lens?
 *
 * Everything else in this package answers "where is that object", and answers
 * it well. None of it can answer "is there a roof in the way". Geometry does
 * not know about roofs: point a phone at a ceiling and the stars overhead are
 * genuinely above the horizon, so the app draws them, confidently, through
 * eight inches of plasterboard. That is the single worst thing this app does.
 *
 * The only things that can tell are the sensors that look outward, and none of
 * them is conclusive on its own. So this grades three independent kinds of
 * evidence and multiplies them:
 *
 *   camera frame statistics -- by far the strongest, when the camera is on
 *   location accuracy       -- free, and a roof wrecks it
 *   magnetic field quality  -- steel frames distort it; see MagneticFieldMonitor
 *
 * Multiplied rather than averaged, because they fail together indoors and
 * that agreement is itself the evidence. Within a single sensor the tells are
 * not independent, so there the worst one wins -- the same call
 * {@link MagneticFieldMonitor} makes.
 *
 * This produces a doubt, never a verdict. A false negative -- real sky judged
 * indoors -- that hid the app would be a far worse bug than the one this
 * fixes, so every signal is floored and the caller is expected to warn and
 * de-emphasise rather than hide. Nothing here justifies blocking anything.
 *
 * Pure and DOM-free, like the rest of core: the frame statistics arrive as
 * plain numbers and whatever produced them is the web layer's problem.
 */

/**
 * What one downsampled camera frame looks like, as numbers.
 *
 * Luminance is 0 to 1. The sampling grid is assumed small -- 32x32 is what
 * the web client uses -- which matters mostly for {@link pointSources}, a raw
 * count rather than a fraction.
 */
export interface FrameStatistics {
  /** Average luminance over the whole frame. */
  meanLuminance: number;
  /** Variance of cell luminance across the whole frame. */
  variance: number;
  /**
   * Mean squared difference between horizontally and vertically adjacent
   * cells. This is the high-spatial-frequency energy, and separating it from
   * the total variance is what makes a dark room distinguishable from a dark
   * sky -- see {@link structureRatio}.
   */
  neighbourVariance: number;
  /** Cells sitting well above their own immediate neighbourhood: stars, or
   *  anything else small and bright. */
  pointSources: number;
  /** Fraction of the frame at or near full scale -- light fittings, the Sun,
   *  a streetlamp in shot. */
  saturatedFraction: number;
}

/** The evidence available this frame. Any of it may be missing. */
export interface SkyEvidence {
  /** Null when the camera is off, denied, or has not produced a frame yet. */
  frame: FrameStatistics | null;
  /** Degrees; from the same ephemeris that drives the visibility model. */
  sunAltitude: number;
  /** Metres of horizontal uncertainty, or null if unknown -- Position.accuracy. */
  gpsAccuracyMetres: number | null;
  /** MagneticQuality.confidence, or 1 where nothing is measuring the field. */
  magneticConfidence: number;
}

export interface SkyConfidence {
  /** 1 when nothing suggests anything is in the way, 0 when several things do.
   *  Everything between is a degree of doubt. */
  confidence: number;
  /** Whether it is worth telling the user. */
  warn: boolean;
  /** One short clause naming the worst signal, for the warning to show.
   *  Null when there is nothing worth saying. */
  reason: string | null;
}

/**
 * Tuning. Every number below is a guess about how phone cameras behave in
 * rooms and under skies, which is not something that can be derived -- it has
 * to be measured on real hardware under a real sky. They are knobs for that
 * reason, the same way {@link DEFAULT_MAGNETIC_LIMITS} is.
 */
export interface SkyConfidenceLimits {
  /**
   * Solar altitude below which daylight can no longer explain a bright frame.
   * The end of civil twilight, matching where the visibility model puts the
   * first real darkening.
   */
  nightSunAltitude: number;
  /** Solar altitude below which the sky has stopped getting darker -- the end
   *  of astronomical twilight, where visibility.ts also stops. Between here
   *  and {@link nightSunAltitude} the sky is legitimately brighter than it
   *  will be later, and the night thresholds are lifted to match. */
  darkSunAltitude: number;
  /** Solar altitude at which the daytime test bites at full strength. Below
   *  it the test eases off, because a phone under a dusk sky reads dimmer
   *  every minute and a fixed threshold turns that into a false alarm. */
  fullDaylightAltitude: number;
  /** Mean luminance that is still plausibly sky under a fully dark sky. */
  nightMeanCeiling: number;
  /** Mean luminance that is certainly a lit room under a fully dark sky. */
  nightMeanReject: number;
  /** Daytime mean luminance below which something is between lens and sky. */
  dayMeanFloor: number;
  /** Daytime mean luminance that is unambiguously the open outdoors. */
  dayMeanAccept: number;
  /** Below this mean, brightness says nothing and structure has to decide. */
  darkFrameMean: number;
  /** Saturated fraction a distant streetlamp in shot could explain. A star
   *  does not survive the downsample as a saturated cell; a light fitting a
   *  few feet away fills several. */
  saturatedTolerance: number;
  /** Saturated fraction that means a light fitting is in shot. */
  saturatedReject: number;
  /** Structure ratio at which a dark frame is credited as real scene. */
  structureForOpenSky: number;
  /** Point sources in the grid at which a dark frame is credited as sky. */
  pointSourcesForOpenSky: number;
  /** Horizontal accuracy, metres, consistent with a clear view of the sky. */
  accuracyTolerance: number;
  /** Horizontal accuracy that means the satellites are being blocked. */
  accuracyReject: number;
  /**
   * Worst a bad fix alone may drive confidence. Deliberately above
   * {@link doubtConfidence}, so a poor fix on its own never raises a warning:
   * tree cover, urban canyons and a cold start all do this outdoors. It takes
   * a second signal agreeing before the product drops far enough to say
   * anything.
   */
  gpsFloor: number;
  /** The same for a distorted field, and higher still: a magnet on a desk
   *  says nothing at all about a roof, and magnetic interference already has
   *  a warning of its own. This is only a nudge. */
  magneticFloor: number;
  /** Worst the camera alone may drive confidence. Not zero: a lens can be
   *  smeared, misted or thumbed while pointing at a perfect sky. */
  cameraFloor: number;
  /** Confidence below which to warn the user. */
  doubtConfidence: number;
}

export const DEFAULT_SKY_CONFIDENCE: SkyConfidenceLimits = {
  nightSunAltitude: -6,
  darkSunAltitude: -18,
  fullDaylightAltitude: 5,
  nightMeanCeiling: 0.1,
  nightMeanReject: 0.32,
  dayMeanFloor: 0.18,
  dayMeanAccept: 0.35,
  darkFrameMean: 0.06,
  saturatedTolerance: 0.002,
  saturatedReject: 0.015,
  structureForOpenSky: 0.35,
  pointSourcesForOpenSky: 3,
  accuracyTolerance: 12,
  accuracyReject: 60,
  gpsFloor: 0.6,
  magneticFloor: 0.65,
  cameraFloor: 0.1,
  doubtConfidence: 0.55,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** 1 at `good`, 0 at `bad`, linear between. Either may be the larger. */
function fade(value: number, good: number, bad: number): number {
  if (good === bad) return value === good ? 1 : 0;
  return clamp01((bad - value) / (bad - good));
}

/** One graded piece of evidence and what it would say if it were the worst. */
interface Signal {
  score: number;
  reason: string;
}

const worst = (signals: Signal[]): Signal =>
  signals.reduce((a, b) => (b.score < a.score ? b : a));

/**
 * How much of the frame's variation is structure rather than sensor noise,
 * 0 to 1.
 *
 * This is the whole answer to the hard case, so it is worth being explicit
 * about why it works. A dark room and a moonless sky produce frames with
 * almost the same mean luminance -- near zero, both of them -- so brightness
 * cannot separate them and never will. What differs is how the variation is
 * arranged in space.
 *
 * In a dark room the only thing varying is the sensor's own read noise, and
 * that is spatially uncorrelated: each cell is an independent draw, so
 * adjacent cells differ by as much as distant ones. For independent cells of
 * variance s^2, the expected squared difference between two of them is 2*s^2 --
 * so `neighbourVariance / 2` estimates exactly the part of the variance that
 * is noise, and subtracting it leaves the part that is not. For pure noise
 * that remainder is zero.
 *
 * A real sky is never arranged that way. Even with no star resolvable it has
 * a skyglow gradient -- brighter toward the horizon, brighter toward the town
 * -- and a gradient is smooth, so adjacent cells barely differ while distant
 * ones differ a lot. Total variance stays high, neighbour variance collapses,
 * and the ratio goes to 1.
 *
 * What this deliberately does NOT catch is a starfield with no gradient: a
 * sparse scattering of isolated bright cells is, to this metric,
 * indistinguishable from noise, because an isolated point differs from its
 * neighbours by exactly as much as it differs from the mean. That case is
 * {@link FrameStatistics.pointSources}' job, and the two are combined below
 * as alternatives rather than as a sum for precisely that reason.
 *
 * A flat frame -- no variance at all -- is a covered lens, and scores zero.
 */
export function structureRatio(frame: FrameStatistics): number {
  if (!(frame.variance > 0)) return 0;
  return clamp01((frame.variance - frame.neighbourVariance / 2) / frame.variance);
}

/**
 * What the camera frame alone says.
 *
 * The solar altitude is not decoration here: a bright frame is the expected
 * reading under a daylit sky and damning evidence of artificial light at
 * midnight, and nothing in the frame itself can tell those apart.
 */
function cameraSignal(
  frame: FrameStatistics,
  sunAltitude: number,
  limits: SkyConfidenceLimits,
): Signal {
  if (sunAltitude > limits.nightSunAltitude) {
    // Daylight inverts the test. Outdoors under any sky bright enough to be
    // called day, the camera cannot help but see it; a dark frame means
    // something opaque is in the way.
    //
    // Eased off as the Sun drops toward the horizon, because the sky dims
    // continuously through dusk and a fixed threshold would start calling the
    // open air a ceiling somewhere around sunset.
    const bite = fade(sunAltitude, limits.fullDaylightAltitude, limits.nightSunAltitude);
    const dark = fade(frame.meanLuminance, limits.dayMeanAccept, limits.dayMeanFloor);
    return {
      score: limits.cameraFloor + (1 - limits.cameraFloor) * (1 - bite * (1 - dark)),
      reason: 'the Sun is up but the camera sees darkness',
    };
  }

  // The sky is still draining of light between civil and astronomical
  // twilight, so what counts as suspiciously bright depends on how far down
  // the Sun is. Same boundaries the visibility model uses.
  const lift = clamp01(
    (sunAltitude - limits.darkSunAltitude) / (limits.nightSunAltitude - limits.darkSunAltitude),
  );
  const ceiling = limits.nightMeanCeiling + lift * (limits.dayMeanAccept - limits.nightMeanCeiling);

  const signals: Signal[] = [
    {
      score: fade(
        frame.meanLuminance,
        ceiling,
        ceiling + (limits.nightMeanReject - limits.nightMeanCeiling),
      ),
      reason: 'this looks like a lit indoor ceiling',
    },
    {
      score: fade(frame.saturatedFraction, limits.saturatedTolerance, limits.saturatedReject),
      reason: 'there are bright lights in view, not stars',
    },
  ];

  // Only a genuinely dark frame needs the structure test. Above that the
  // brightness terms have already formed a view, and a dim wall's smooth
  // falloff would read as skyglow -- see the known gap in the module comment.
  if (frame.meanLuminance <= limits.darkFrameMean) {
    signals.push({
      score: Math.max(
        clamp01(structureRatio(frame) / limits.structureForOpenSky),
        clamp01(frame.pointSources / limits.pointSourcesForOpenSky),
      ),
      reason: 'the camera sees flat darkness -- a covered lens, or an unlit room',
    });
  }

  const result = worst(signals);
  return { score: limits.cameraFloor + (1 - limits.cameraFloor) * result.score, reason: result.reason };
}

/**
 * Grade the evidence.
 *
 * Missing evidence scores 1 rather than 0. The caller cannot tell an
 * uncontaminated signal from an unmeasured one, and warning about the second
 * is worse than staying quiet -- the same principle MagneticFieldMonitor.push
 * applies to an absent field reading.
 */
export function skyConfidence(
  evidence: SkyEvidence,
  limits: SkyConfidenceLimits = DEFAULT_SKY_CONFIDENCE,
): SkyConfidence {
  const signals: Signal[] = [];

  if (evidence.frame) {
    signals.push(cameraSignal(evidence.frame, evidence.sunAltitude, limits));
  }

  if (evidence.gpsAccuracyMetres !== null && evidence.gpsAccuracyMetres > 0) {
    const fix = fade(evidence.gpsAccuracyMetres, limits.accuracyTolerance, limits.accuracyReject);
    signals.push({
      score: limits.gpsFloor + (1 - limits.gpsFloor) * fix,
      reason: 'the location fix is poor, the way it goes under a roof',
    });
  }

  const magnetic = clamp01(evidence.magneticConfidence);
  if (magnetic < 1) {
    signals.push({
      score: limits.magneticFloor + (1 - limits.magneticFloor) * magnetic,
      reason: 'the compass is unreliable here, as it is around steel',
    });
  }

  if (signals.length === 0) {
    return { confidence: 1, warn: false, reason: null };
  }

  const confidence = clamp01(signals.reduce((product, signal) => product * signal.score, 1));
  const warn = confidence < limits.doubtConfidence;
  return { confidence, warn, reason: warn ? worst(signals).reason : null };
}
