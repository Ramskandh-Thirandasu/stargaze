/**
 * The "is there actually sky in front of the lens" model.
 *
 * The frame statistics here are hand-built to have the shape each scene
 * produces rather than copied off a real camera -- there is no camera in a
 * test runner. So these check the discriminators, not the thresholds: that a
 * dark room and a dark sky come out on opposite sides, that a lit ceiling is
 * rejected, that daylight is only believed when the Sun is actually up, and
 * that nothing here ever returns a verdict confident enough to justify
 * hiding the sky.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKY_CONFIDENCE,
  skyConfidence,
  structureRatio,
  type FrameStatistics,
  type SkyEvidence,
} from '../src/skyconfidence.js';

/** Sensible nothing-is-wrong evidence, for overriding one field at a time. */
function evidence(overrides: Partial<SkyEvidence> = {}): SkyEvidence {
  return {
    frame: null,
    sunAltitude: -30,
    gpsAccuracyMetres: 6,
    magneticConfidence: 1,
    ...overrides,
  };
}

function frame(overrides: Partial<FrameStatistics> = {}): FrameStatistics {
  return {
    meanLuminance: 0.02,
    variance: 0,
    neighbourVariance: 0,
    pointSources: 0,
    saturatedFraction: 0,
    ...overrides,
  };
}

/**
 * A dark room: nothing but read noise. Independent cells of variance s^2
 * differ from their neighbours by 2*s^2 in expectation, which is what makes
 * this uncorrelated rather than merely dark.
 */
const DARK_ROOM = frame({
  meanLuminance: 0.015,
  variance: 1e-4,
  neighbourVariance: 2e-4,
  pointSources: 0,
});

/** A moonless sky with no star bright enough to survive the downsample, but
 *  the skyglow gradient every inhabited part of the world has. */
const SKYGLOW = frame({
  meanLuminance: 0.03,
  variance: 4e-4,
  neighbourVariance: 2e-5,
  pointSources: 0,
});

/** A darker sky than that, carried entirely by point sources: the gradient is
 *  absent, so the variance looks exactly like noise. */
const STARFIELD = frame({
  meanLuminance: 0.02,
  variance: 3e-4,
  neighbourVariance: 6e-4,
  pointSources: 6,
});

/** A ceiling with the light on. */
const LIT_CEILING = frame({
  meanLuminance: 0.45,
  variance: 0.02,
  neighbourVariance: 0.004,
  pointSources: 1,
  saturatedFraction: 0.03,
});

/** A ceiling with the light off: dimmer than the fitting suggests, but the
 *  fitting is still in shot and still saturating. */
const DIM_CEILING_WITH_FITTING = frame({
  meanLuminance: 0.08,
  variance: 0.006,
  neighbourVariance: 0.001,
  pointSources: 2,
  saturatedFraction: 0.02,
});

describe('structure ratio', () => {
  it('is zero for spatially uncorrelated noise, which is what a dark room is', () => {
    expect(structureRatio(DARK_ROOM)).toBeCloseTo(0, 6);
  });

  it('is near one for a smooth gradient, which is what skyglow is', () => {
    expect(structureRatio(SKYGLOW)).toBeGreaterThan(0.9);
  });

  it('is zero for a flat frame -- a covered lens has no structure to find', () => {
    expect(structureRatio(frame({ variance: 0, neighbourVariance: 0 }))).toBe(0);
  });

  it('cannot see isolated points, which is why the point count exists separately', () => {
    // A sparse scattering differs from its neighbours by as much as it differs
    // from the mean, so this metric reads it as noise. Documented behaviour,
    // not a defect -- STARFIELD is rescued by pointSources below.
    expect(structureRatio(STARFIELD)).toBeCloseTo(0, 6);
  });
});

describe('a dark room versus a dark sky', () => {
  // The case the whole module exists for: both frames are near black, so mean
  // luminance cannot separate them and only the spatial arrangement can.
  it('doubts a dark room', () => {
    const result = skyConfidence(evidence({ frame: DARK_ROOM }));
    expect(result.warn).toBe(true);
    expect(result.reason).toMatch(/flat darkness/);
  });

  it('believes a dark sky with a skyglow gradient', () => {
    const result = skyConfidence(evidence({ frame: SKYGLOW }));
    expect(result.warn).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('believes a dark sky carried by point sources alone', () => {
    const result = skyConfidence(evidence({ frame: STARFIELD }));
    expect(result.warn).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('separates the two by far more than their brightness differs', () => {
    const room = skyConfidence(evidence({ frame: DARK_ROOM })).confidence;
    const sky = skyConfidence(evidence({ frame: SKYGLOW })).confidence;
    expect(sky - room).toBeGreaterThan(0.5);
    // Both frames are black to within two percent of full scale.
    expect(Math.abs(DARK_ROOM.meanLuminance - SKYGLOW.meanLuminance)).toBeLessThan(0.02);
  });

  it('needs the point sources to be more than one or two before believing them', () => {
    const barely = skyConfidence(evidence({ frame: { ...DARK_ROOM, pointSources: 1 } }));
    expect(barely.warn).toBe(true);
  });
});

describe('indoors with the light on', () => {
  it('rejects a lit ceiling at night', () => {
    const result = skyConfidence(evidence({ frame: LIT_CEILING }));
    expect(result.warn).toBe(true);
    expect(result.reason).toMatch(/indoor ceiling/);
  });

  it('rejects an unlit ceiling with a light fitting still in shot', () => {
    const result = skyConfidence(evidence({ frame: DIM_CEILING_WITH_FITTING }));
    expect(result.warn).toBe(true);
    expect(result.reason).toMatch(/bright lights/);
  });

  it('gets less confident the brighter the frame is at night', () => {
    let previous = 1;
    for (const meanLuminance of [0.05, 0.12, 0.2, 0.3, 0.5]) {
      const result = skyConfidence(evidence({ frame: SKYGLOW && { ...SKYGLOW, meanLuminance } }));
      expect(result.confidence).toBeLessThanOrEqual(previous + 1e-9);
      previous = result.confidence;
    }
  });
});

describe('cross-checking brightness against the Sun', () => {
  it('accepts a bright frame when the Sun is up', () => {
    const daylight = frame({ meanLuminance: 0.6, variance: 0.01, neighbourVariance: 0.002 });
    const result = skyConfidence(evidence({ frame: daylight, sunAltitude: 35 }));
    expect(result.warn).toBe(false);
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it('rejects the same bright frame in the middle of the night', () => {
    const daylight = frame({ meanLuminance: 0.6, variance: 0.01, neighbourVariance: 0.002 });
    const result = skyConfidence(evidence({ frame: daylight, sunAltitude: -35 }));
    expect(result.warn).toBe(true);
    expect(result.reason).toMatch(/indoor ceiling/);
  });

  it('doubts a dark frame while the Sun is high -- that is a room in daytime', () => {
    const result = skyConfidence(evidence({ frame: DARK_ROOM, sunAltitude: 35 }));
    expect(result.warn).toBe(true);
    expect(result.reason).toMatch(/Sun is up/);
  });

  it('does not call the open air a ceiling at dusk', () => {
    // The sky dims continuously through twilight, so a frame that would be
    // damning at noon is ordinary here. Both sides of the civil boundary.
    for (const sunAltitude of [-2, -5, -7, -10]) {
      const dusk = frame({
        meanLuminance: 0.16,
        variance: 2e-3,
        neighbourVariance: 1e-4,
      });
      expect(skyConfidence(evidence({ frame: dusk, sunAltitude })).warn).toBe(false);
    }
  });
});

describe('the signals that are not the camera', () => {
  it('says nothing about a poor fix on its own -- trees and cities do that too', () => {
    const result = skyConfidence(evidence({ frame: null, gpsAccuracyMetres: 150 }));
    expect(result.warn).toBe(false);
    expect(result.confidence).toBeLessThan(1);
  });

  it('says nothing about a distorted field on its own -- that has its own warning', () => {
    const result = skyConfidence(evidence({ frame: null, magneticConfidence: 0 }));
    expect(result.warn).toBe(false);
    expect(result.confidence).toBeLessThan(1);
  });

  it('warns once a poor fix and a distorted field agree', () => {
    const result = skyConfidence(
      evidence({ frame: null, gpsAccuracyMetres: 150, magneticConfidence: 0 }),
    );
    expect(result.warn).toBe(true);
  });

  it('gets less confident as the fix degrades', () => {
    let previous = 1;
    for (const gpsAccuracyMetres of [5, 15, 30, 60, 200]) {
      const result = skyConfidence(evidence({ gpsAccuracyMetres }));
      expect(result.confidence).toBeLessThanOrEqual(previous + 1e-9);
      previous = result.confidence;
    }
  });

  it('treats an unknown fix as no evidence rather than bad evidence', () => {
    const unknown = skyConfidence(evidence({ gpsAccuracyMetres: null }));
    expect(unknown.confidence).toBe(1);
    expect(unknown.warn).toBe(false);
  });

  it('is fully confident when there is nothing to measure at all', () => {
    // No camera, no fix, no magnetometer. Silence is not suspicion.
    const result = skyConfidence(
      evidence({ frame: null, gpsAccuracyMetres: null, magneticConfidence: 1 }),
    );
    expect(result).toEqual({ confidence: 1, warn: false, reason: null });
  });
});

describe('signals in combination', () => {
  it('deepens doubt when several signals agree, rather than taking the worst', () => {
    const cameraOnly = skyConfidence(evidence({ frame: DARK_ROOM })).confidence;
    const everything = skyConfidence(
      evidence({ frame: DARK_ROOM, gpsAccuracyMetres: 150, magneticConfidence: 0.1 }),
    ).confidence;
    expect(everything).toBeLessThan(cameraOnly);
  });

  it('names the worst signal, not merely the first', () => {
    // Camera is clean, so the reason has to come from the other two.
    const result = skyConfidence(
      evidence({ frame: SKYGLOW, gpsAccuracyMetres: 400, magneticConfidence: 0 }),
    );
    expect(result.reason).toMatch(/location fix/);
  });

  it('does not let one soft signal drag a clean camera into a warning', () => {
    const result = skyConfidence(evidence({ frame: SKYGLOW, gpsAccuracyMetres: 150 }));
    expect(result.warn).toBe(false);
  });
});

describe('the honesty rules', () => {
  it('never reports zero confidence, however bad the evidence', () => {
    // Nothing here is ever certain enough to justify hiding the sky, and a
    // zero would invite a caller to treat it as one.
    const result = skyConfidence(
      evidence({
        frame: LIT_CEILING,
        sunAltitude: -40,
        gpsAccuracyMetres: 5000,
        magneticConfidence: 0,
      }),
    );
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('keeps confidence inside 0 to 1 across absurd inputs', () => {
    for (const gpsAccuracyMetres of [-10, 0, 1e9]) {
      for (const magneticConfidence of [-1, 0, 2]) {
        const result = skyConfidence(evidence({ gpsAccuracyMetres, magneticConfidence }));
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
      }
    }
  });

  it('gives a reason whenever it warns, and none when it does not', () => {
    const doubtful = skyConfidence(evidence({ frame: LIT_CEILING }));
    expect(doubtful.warn).toBe(true);
    expect(doubtful.reason).toBeTruthy();

    const clear = skyConfidence(evidence({ frame: SKYGLOW }));
    expect(clear.warn).toBe(false);
    expect(clear.reason).toBeNull();
  });

  it('warns exactly when confidence falls below the stated threshold', () => {
    const cases: SkyEvidence[] = [
      evidence({ frame: DARK_ROOM }),
      evidence({ frame: SKYGLOW }),
      evidence({ frame: LIT_CEILING, gpsAccuracyMetres: 80 }),
      evidence({ gpsAccuracyMetres: 150, magneticConfidence: 0.5 }),
    ];
    for (const input of cases) {
      const result = skyConfidence(input);
      expect(result.warn).toBe(result.confidence < DEFAULT_SKY_CONFIDENCE.doubtConfidence);
    }
  });

  it('honours caller-supplied limits, since the defaults are guesses', () => {
    const strict = { ...DEFAULT_SKY_CONFIDENCE, doubtConfidence: 0.99 };
    expect(skyConfidence(evidence({ frame: SKYGLOW }), strict).warn).toBe(false);
    expect(skyConfidence(evidence({ frame: SKYGLOW, gpsAccuracyMetres: 40 }), strict).warn).toBe(
      true,
    );
  });
});
