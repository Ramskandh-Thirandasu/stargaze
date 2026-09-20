/**
 * Sensors, projection and the catalogue.
 *
 * There is no external reference for "the phone is pointed north-east and
 * tilted up 30 degrees", so these tests pin the behaviour against physical
 * situations you can reason about: lie the phone flat and it looks straight
 * down; stand it upright facing north and a star due north lands dead centre;
 * tap a pixel and get back the direction that projects onto it.
 */

import { describe, expect, it } from 'vitest';

import { angularSeparation } from '../src/angles.js';
import {
  basisFromDeviceOrientation,
  basisFromQuaternion,
  directionFromHorizontal,
  headingRateFromDeviceRotation,
  horizontalFromDirection,
  DEFAULT_HEADING_FUSION,
  HeadingFilter,
  HeadingFusion,
  MagneticFieldMonitor,
} from '../src/orientation.js';
import {
  couldBeVisible,
  focalLength,
  project,
  projectHorizontal,
  unproject,
  verticalFov,
  viewConeRadius,
} from '../src/projection.js';
import {
  colorFromBV,
  countBrighterThan,
  createHorizontalBuffer,
  parseStarCatalog,
  precessCatalog,
  resolveConstellations,
  toHorizontal,
  type StarCatalog,
} from '../src/catalog.js';
import {
  magneticDeclination,
  magneticFieldIntensity,
  parseDeclinationGrid,
  decimalYear,
} from '../src/declination.js';
import { equatorialToHorizontal, precessFromJ2000, refraction } from '../src/coords.js';
import { apparentTerms, applyApparentPlace } from '../src/apparent.js';
import { julianDate, localSiderealTime, terrestrialJulianDate } from '../src/time.js';
import { constellationsJson, declinationJson, starsJson } from './fixtures.js';

const VIEWPORT = { width: 390, height: 844, horizontalFov: 66 };

describe('device orientation', () => {
  it('looks straight down when the phone lies flat on its back', () => {
    // alpha/beta/gamma all zero is a phone face-up on a table. The rear camera
    // is then aimed at the floor.
    const basis = basisFromDeviceOrientation({ alpha: 0, beta: 0, gamma: 0 });
    expect(basis.altitude).toBeCloseTo(-90, 6);
  });

  it('looks at the horizon when the phone is held upright', () => {
    // Tilted 90 degrees forward from flat: the back of the phone now faces out
    // horizontally, which is how you photograph a building.
    const basis = basisFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0 });
    expect(basis.altitude).toBeCloseTo(0, 6);
    expect(basis.azimuth).toBeCloseTo(0, 6);
  });

  it('looks straight up when the phone is face-down', () => {
    // The stargazing pose: screen toward the ground, camera at the zenith.
    const basis = basisFromDeviceOrientation({ alpha: 0, beta: 180, gamma: 0 });
    expect(basis.altitude).toBeCloseTo(90, 4);
  });

  it('turns the view with alpha', () => {
    for (const [alpha, expected] of [
      [0, 0],
      [90, 270],
      [180, 180],
      [270, 90],
    ] as const) {
      const basis = basisFromDeviceOrientation({ alpha, beta: 90, gamma: 0 });
      expect(basis.azimuth).toBeCloseTo(expected, 4);
    }
  });

  it('applies magnetic declination to the heading', () => {
    const magnetic = basisFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0 });
    const corrected = basisFromDeviceOrientation({
      alpha: 0,
      beta: 90,
      gamma: 0,
      declination: 10,
    });
    // A magnetic bearing of 0 with 10 degrees east declination is a true
    // bearing of 10.
    expect(magnetic.azimuth).toBeCloseTo(0, 4);
    expect(corrected.azimuth).toBeCloseTo(10, 4);
  });

  it('keeps the basis orthonormal', () => {
    for (const angles of [
      { alpha: 37, beta: 62, gamma: -18 },
      { alpha: 200, beta: 130, gamma: 45, screenAngle: 90 },
      { alpha: 355, beta: 5, gamma: 88, screenAngle: 270 },
    ]) {
      const { forward, right, up } = basisFromDeviceOrientation(angles);
      const dot = (a: typeof forward, b: typeof forward) => a.x * b.x + a.y * b.y + a.z * b.z;

      expect(Math.hypot(forward.x, forward.y, forward.z)).toBeCloseTo(1, 9);
      expect(Math.hypot(right.x, right.y, right.z)).toBeCloseTo(1, 9);
      expect(Math.hypot(up.x, up.y, up.z)).toBeCloseTo(1, 9);
      expect(dot(forward, right)).toBeCloseTo(0, 9);
      expect(dot(forward, up)).toBeCloseTo(0, 9);
      expect(dot(right, up)).toBeCloseTo(0, 9);
    }
  });

  it('does not move the camera when only the screen rotates', () => {
    // Rotating the UI into landscape must not swing where the lens points.
    const portrait = basisFromDeviceOrientation({ alpha: 45, beta: 70, gamma: 0 });
    const landscape = basisFromDeviceOrientation({
      alpha: 45,
      beta: 70,
      gamma: 0,
      screenAngle: 90,
    });

    expect(landscape.altitude).toBeCloseTo(portrait.altitude, 9);
    expect(landscape.azimuth).toBeCloseTo(portrait.azimuth, 9);
    // But the screen axes must swap, or labels come out sideways.
    expect(Math.abs(landscape.roll - portrait.roll)).toBeGreaterThan(80);
  });

  it('agrees with the quaternion path for the identity rotation', () => {
    const euler = basisFromDeviceOrientation({ alpha: 0, beta: 0, gamma: 0 });
    const quaternion = basisFromQuaternion({ x: 0, y: 0, z: 0, w: 1 });
    expect(quaternion.altitude).toBeCloseTo(euler.altitude, 6);
  });

  it('round-trips a direction through horizontal coordinates', () => {
    for (const [altitude, azimuth] of [
      [0, 0],
      [45, 90],
      [-30, 200],
      [80, 359],
    ] as const) {
      const back = horizontalFromDirection(directionFromHorizontal(altitude, azimuth));
      expect(back.altitude).toBeCloseTo(altitude, 9);
      expect(back.azimuth).toBeCloseTo(azimuth, 9);
    }
  });
});

describe('heading filter', () => {
  it('takes the first reading whole', () => {
    expect(new HeadingFilter(0.2).push(123)).toBeCloseTo(123, 9);
  });

  it('converges toward a steady reading', () => {
    const filter = new HeadingFilter(0.3);
    filter.push(0);
    for (let i = 0; i < 60; i += 1) filter.push(90);
    expect(filter.push(90)).toBeCloseTo(90, 4);
  });

  it('crosses north the short way', () => {
    // The bug this exists to prevent: the sky spinning 358 degrees when the
    // compass ticks from 359 to 1.
    const filter = new HeadingFilter(0.5);
    filter.push(359);
    const next = filter.push(1);
    expect(next > 359 || next < 1).toBe(true);
    expect(Math.min(next, 360 - next)).toBeLessThan(1.5);
  });

  it('smooths jitter rather than following it', () => {
    const filter = new HeadingFilter(0.1);
    filter.push(100);
    // A single wild reading must not throw the view across the sky.
    const after = filter.push(160);
    expect(after).toBeLessThan(110);
  });
});

describe('gyroscope heading rate', () => {
  it('reads the heading off the z axis when the phone lies flat', () => {
    // Face-up on a table: spinning the phone on the table top is exactly a
    // change of heading, and nothing else contributes.
    expect(headingRateFromDeviceRotation({ alpha: 10, beta: 4, gamma: -7 }, 0, 0)).toBeCloseTo(
      10,
      9,
    );
  });

  it('reads the heading off the y axis when the phone is held upright', () => {
    // The stargazing pose. This is the case that makes the projection
    // necessary: rotationRate.alpha now barely touches the heading at all.
    expect(headingRateFromDeviceRotation({ alpha: 10, beta: 4, gamma: 6 }, 90, 0)).toBeCloseTo(6, 9);
  });

  it('reverses sign when the phone is rolled onto its edge', () => {
    // gamma of 90 tips the device x axis to point at the ground, so a
    // right-handed turn about it swings the heading the other way.
    expect(headingRateFromDeviceRotation({ alpha: 0, beta: 10, gamma: 0 }, 0, 90)).toBeCloseTo(
      -10,
      9,
    );
  });

  it('never invents rotation that was not measured', () => {
    // Whatever the tilt, projecting onto one axis can only ever lose
    // magnitude. A bug in the trigonometry usually shows up as gain.
    const rate = { alpha: 12, beta: -5, gamma: 8 };
    const magnitude = Math.hypot(rate.alpha, rate.beta, rate.gamma);
    for (let beta = -180; beta <= 180; beta += 15) {
      for (let gamma = -90; gamma <= 90; gamma += 15) {
        const heading = headingRateFromDeviceRotation(rate, beta, gamma);
        expect(Math.abs(heading)).toBeLessThanOrEqual(magnitude + 1e-9);
      }
    }
  });
});

describe('heading fusion', () => {
  const FRAME = 1 / 60;

  it('takes the first magnetometer reading whole', () => {
    // No gyroscope reading can supply a starting bearing, so there is nothing
    // to ease away from -- and easing up from zero would sweep the sky.
    expect(new HeadingFusion().correct(123, FRAME)).toBeCloseTo(123, 9);
  });

  it('gives nothing back until the magnetometer has said where north is', () => {
    const fusion = new HeadingFusion();
    expect(fusion.predict(30, FRAME)).toBeNull();
    expect(fusion.heading).toBeNull();
  });

  it('converges on a steady heading', () => {
    const fusion = new HeadingFusion();
    fusion.correct(0, FRAME);
    for (let i = 0; i < 120; i += 1) fusion.correct(90, FRAME);
    expect(fusion.heading).toBeCloseTo(90, 3);
  });

  it('crosses north the short way', () => {
    const fusion = new HeadingFusion();
    fusion.correct(359, FRAME);
    const next = fusion.correct(1, FRAME);
    expect(next > 359 || next < 1).toBe(true);
  });

  it('lets the gyroscope carry a turn the magnetometer has not caught up with', () => {
    // A real magnetometer smears while the phone is moving. The gyroscope is
    // at its best exactly then, and the point of the filter is that the sky
    // follows the turn rather than the lagging compass.
    const fusion = new HeadingFusion();
    fusion.correct(0, FRAME);

    for (let i = 0; i < 60; i += 1) {
      fusion.predict(20, FRAME);
      fusion.correct(0, FRAME);
    }

    expect(fusion.usingGyro).toBe(true);
    // One second at 20 degrees per second, less a small pull back toward the
    // stale reading.
    expect(fusion.heading).toBeGreaterThan(15);
    expect(fusion.heading).toBeLessThan(20.001);
  });

  it('lets the magnetometer pull out gyroscope drift', () => {
    // The complementary half. A gyro biased by a degree a second walks 60
    // degrees off in a minute on its own; with a magnetometer holding it, the
    // error settles at a couple of degrees and stays there.
    const fusion = new HeadingFusion();
    fusion.correct(0, FRAME);

    for (let i = 0; i < 60 * 60; i += 1) {
      fusion.predict(1, FRAME);
      fusion.correct(0, FRAME);
    }

    const error = Math.abs(((fusion.heading as number) + 180) % 360) - 180;
    expect(Math.abs(error)).toBeLessThan(3);
  });

  it('matches the plain low-pass when there is no gyroscope', () => {
    // The promise made to every phone without the sensor: nothing gets worse.
    const fusion = new HeadingFusion();
    const filter = new HeadingFilter(0.18);
    fusion.correct(0, FRAME);
    filter.push(0);

    for (let i = 0; i < 30; i += 1) {
      fusion.correct(90, FRAME);
      filter.push(90);
    }

    expect(fusion.usingGyro).toBe(false);
    expect(fusion.heading).toBeCloseTo(filter.push(90), 0);
  });

  it('goes back to the magnetometer when the gyroscope stops reporting', () => {
    // Permission withdrawn, page backgrounded, sensor gone. Nobody tells the
    // filter; it has to notice on its own or the heading freezes.
    const fusion = new HeadingFusion();
    fusion.correct(0, FRAME);
    fusion.predict(0, FRAME);
    expect(fusion.usingGyro).toBe(true);

    const silence = Math.ceil(DEFAULT_HEADING_FUSION.gyroTimeoutSeconds / FRAME) + 1;
    for (let i = 0; i < silence; i += 1) fusion.correct(0, FRAME);
    expect(fusion.usingGyro).toBe(false);

    for (let i = 0; i < 60; i += 1) fusion.correct(45, FRAME);
    expect(fusion.heading).toBeCloseTo(45, 2);
  });

  it('snaps rather than crawling when the estimate has lost the plot', () => {
    // Drift is gradual. A gap this size is a dropped burst of gyro samples or
    // a wrong-signed rate, and easing back from it would take minutes.
    const fusion = new HeadingFusion();
    fusion.correct(0, FRAME);
    fusion.predict(0, FRAME);
    expect(fusion.correct(180, FRAME)).toBeCloseTo(180, 9);
  });

  it('ignores a distrusted magnetometer only while the gyroscope is running', () => {
    const fused = new HeadingFusion();
    fused.correct(0, FRAME);
    for (let i = 0; i < 120; i += 1) {
      fused.predict(0, FRAME);
      fused.correct(40, FRAME, 0);
    }
    expect(fused.heading).toBeCloseTo(0, 6);

    // Without a gyroscope there is nothing else to carry the heading, so a
    // doubtful reading still beats a frozen sky.
    const alone = new HeadingFusion();
    alone.correct(0, FRAME);
    for (let i = 0; i < 120; i += 1) alone.correct(40, FRAME, 0);
    expect(alone.heading).toBeCloseTo(40, 3);
  });
});

describe('magnetic interference', () => {
  /** Roughly what the Earth makes over southern England, in microtesla. */
  const EXPECTED = 49;

  it('is confident about a field that matches the model and holds still', () => {
    const monitor = new MagneticFieldMonitor();
    let quality = monitor.push(EXPECTED, EXPECTED);
    for (let i = 0; i < 10; i += 1) quality = monitor.push(EXPECTED + 0.3, EXPECTED);
    expect(quality.confidence).toBeCloseTo(1, 6);
    expect(quality.interference).toBe(false);
  });

  it('flags a field the Earth could not be making here', () => {
    expect(new MagneticFieldMonitor().push(110, EXPECTED).interference).toBe(true);
    expect(new MagneticFieldMonitor().push(14, EXPECTED).interference).toBe(true);
  });

  it('treats half the field and twice the field as equally wrong', () => {
    // A percentage would not: 50% under and 100% over are the same mistake.
    const strong = new MagneticFieldMonitor().push(EXPECTED * 1.5, EXPECTED);
    const weak = new MagneticFieldMonitor().push(EXPECTED / 1.5, EXPECTED);
    expect(strong.confidence).toBeCloseTo(weak.confidence, 9);
    expect(strong.confidence).toBeGreaterThan(0);
  });

  it('keeps firing where the boolean it replaces did', () => {
    // The old test was ratio > 1.8 or < 0.55, tuned against real handsets.
    // Grading the signal must not quietly move the point it warns at.
    expect(new MagneticFieldMonitor().push(EXPECTED * 1.85, EXPECTED).interference).toBe(true);
    expect(new MagneticFieldMonitor().push(EXPECTED * 0.53, EXPECTED).interference).toBe(true);
    expect(new MagneticFieldMonitor().push(EXPECTED * 1.3, EXPECTED).interference).toBe(false);
  });

  it('flags a field that lurches when the Earth\'s does not', () => {
    // Every reading here is a plausible field strength on its own -- this is
    // the case the magnitude check alone cannot see. Something ferrous is
    // moving past, and the bearing is being dragged with it.
    const monitor = new MagneticFieldMonitor();
    let quality = monitor.push(EXPECTED, EXPECTED);
    for (let i = 0; i < 10; i += 1) {
      quality = monitor.push(i % 2 === 0 ? EXPECTED + 10 : EXPECTED, EXPECTED);
      expect(Math.abs(Math.log(quality.ratio))).toBeLessThan(Math.log(1.25));
    }
    expect(quality.interference).toBe(true);
  });

  it('recovers once the disturbance passes', () => {
    const monitor = new MagneticFieldMonitor();
    for (let i = 0; i < 10; i += 1) monitor.push(i % 2 === 0 ? EXPECTED + 10 : EXPECTED, EXPECTED);

    let quality = monitor.push(EXPECTED, EXPECTED);
    for (let i = 0; i < 20; i += 1) quality = monitor.push(EXPECTED, EXPECTED);
    expect(quality.interference).toBe(false);
    expect(quality.confidence).toBeCloseTo(1, 6);
  });

  it('stays quiet when there is nothing to compare against', () => {
    // Above 85 degrees latitude the model has no answer. Warning there would
    // be inventing a fault out of not knowing.
    const quality = new MagneticFieldMonitor().push(EXPECTED, 0);
    expect(quality.interference).toBe(false);
    expect(quality.confidence).toBe(1);
  });
});

describe('projection', () => {
  const upright = basisFromDeviceOrientation({ alpha: 0, beta: 90, gamma: 0 });

  it('puts the view axis at the centre of the screen', () => {
    const point = projectHorizontal(0, 0, upright, VIEWPORT);
    expect(point).not.toBeNull();
    expect(point?.x).toBeCloseTo(VIEWPORT.width / 2, 6);
    expect(point?.y).toBeCloseTo(VIEWPORT.height / 2, 6);
    expect(point?.angleFromCenter).toBeCloseTo(0, 6);
  });

  it('puts the field-of-view edge at the edge of the screen', () => {
    const edge = projectHorizontal(0, VIEWPORT.horizontalFov / 2, upright, VIEWPORT);
    expect(edge?.x).toBeCloseTo(VIEWPORT.width, 4);
  });

  it('puts higher altitudes higher up the screen', () => {
    const low = projectHorizontal(5, 0, upright, VIEWPORT);
    const high = projectHorizontal(20, 0, upright, VIEWPORT);
    expect(high?.y).toBeLessThan(low?.y as number);
  });

  it('puts eastward azimuths to the right', () => {
    const east = projectHorizontal(0, 10, upright, VIEWPORT);
    const west = projectHorizontal(0, -10, upright, VIEWPORT);
    expect(east?.x).toBeGreaterThan(VIEWPORT.width / 2);
    expect(west?.x).toBeLessThan(VIEWPORT.width / 2);
  });

  it('refuses to project anything behind the camera', () => {
    // Without this the sky behind your head smears across the screen.
    expect(projectHorizontal(0, 180, upright, VIEWPORT)).toBeNull();
    expect(projectHorizontal(0, 91, upright, VIEWPORT)).toBeNull();
    expect(projectHorizontal(0, 269, upright, VIEWPORT)).toBeNull();
    expect(projectHorizontal(-90, 0, upright, VIEWPORT)).toBeNull();
  });

  it('sends steep off-axis directions far off screen rather than nowhere', () => {
    // 89 degrees off the view axis is still technically in front, so it
    // projects -- to a coordinate nothing like on screen. The renderer culls
    // these with viewConeRadius; project() stays honest about the geometry.
    const steep = projectHorizontal(-89, 0, upright, VIEWPORT);
    expect(steep).not.toBeNull();
    expect(Math.abs(steep?.y as number)).toBeGreaterThan(VIEWPORT.height * 4);
    expect(steep?.angleFromCenter).toBeCloseTo(89, 3);
  });

  it('round-trips through unproject', () => {
    for (const [x, y] of [
      [195, 422],
      [40, 120],
      [350, 700],
    ] as const) {
      const direction = unproject(x, y, upright, VIEWPORT);
      const back = project(direction, upright, VIEWPORT);
      expect(back?.x).toBeCloseTo(x, 6);
      expect(back?.y).toBeCloseTo(y, 6);
    }
  });

  it('derives a sensible vertical field of view', () => {
    // Taller than wide on a phone, so the vertical field must be the larger.
    expect(verticalFov(VIEWPORT)).toBeGreaterThan(VIEWPORT.horizontalFov);
    expect(verticalFov(VIEWPORT)).toBeLessThan(140);
  });

  it('has a view cone that contains everything on screen', () => {
    const radius = viewConeRadius(VIEWPORT);
    const cosRadius = Math.cos((radius * Math.PI) / 180);

    // The screen corner is exactly on the cone.
    const corner = unproject(0, 0, upright, VIEWPORT);
    expect(couldBeVisible(corner, upright, cosRadius - 1e-9)).toBe(true);

    // Something well outside is rejected.
    expect(couldBeVisible(directionFromHorizontal(0, 120), upright, cosRadius)).toBe(false);
  });

  it('scales the focal length with the field of view', () => {
    // Narrower field = longer lens = more pixels per degree.
    const wide = focalLength({ ...VIEWPORT, horizontalFov: 90 });
    const narrow = focalLength({ ...VIEWPORT, horizontalFov: 40 });
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe('star catalogue', () => {
  const catalog = parseStarCatalog(starsJson);

  it('loads the generated catalogue', () => {
    // Trimmed to what a phone can photograph: around a thousand stars, not the
    // 2,850 a dark-adapted eye would reach.
    expect(catalog.count).toBeGreaterThan(800);
    expect(catalog.count).toBeLessThan(1400);
    expect(catalog.ra.length).toBe(catalog.count);
    expect(catalog.indexOfHip.size).toBe(catalog.count);
  });

  it('is sorted brightest first', () => {
    for (let i = 1; i < catalog.count; i += 1) {
      expect(catalog.mag[i] as number).toBeGreaterThanOrEqual(catalog.mag[i - 1] as number);
    }
  });

  it('has Sirius as the brightest star', () => {
    // Sirius is HIP 32349, and nothing else in the sky comes close.
    expect(catalog.hip[0]).toBe(32349);
    expect(catalog.mag[0] as number).toBeLessThan(-1.4);
  });

  it('finds the cutoff index by binary search', () => {
    for (const limit of [1.5, 3, 4, 4.5]) {
      const count = countBrighterThan(catalog, limit);
      expect(catalog.mag[count - 1] as number).toBeLessThanOrEqual(limit);
      if (count < catalog.count) {
        expect(catalog.mag[count] as number).toBeGreaterThan(limit);
      }
    }
  });

  it('transforms the whole catalogue consistently with the single-star path', () => {
    const jd = julianDate(new Date('2026-02-14T18:30:00Z'));
    const lst = localSiderealTime(jd, 77.59);
    const latitude = 12.97;

    const precessed = precessCatalog(catalog, jd);
    const buffer = createHorizontalBuffer(catalog.count);
    // Refraction off: this test is about the bulk loop agreeing with the
    // single-star transform, not about the atmosphere.
    toHorizontal(precessed, lst, latitude, buffer, precessed.count, false);

    for (const index of [0, 1, 17, 250, 1000, catalog.count - 1]) {
      const single = equatorialToHorizontal(
        precessed.ra[index] as number,
        precessed.dec[index] as number,
        lst,
        latitude,
      );
      expect(buffer.altitude[index] as number).toBeCloseTo(single.altitude, 3);
      expect(buffer.azimuth[index] as number).toBeCloseTo(single.azimuth, 3);
    }
  });

  it('moves a fast-proper-motion star by roughly the expected amount, isolated from everything else', () => {
    // HIP 19849 (40 Eridani / o2 Eridani) -- one of the fastest-moving naked-
    // eye stars, about 4.09"/yr. Over ~26 years since J2000 that is on the
    // order of 100". Precession moves every star by much more than that over
    // the same span (~0.36 degree, well over 1000"), and nutation/aberration
    // add tens more on top -- so the comparison runs the identical
    // precession+apparent-place pipeline with and without proper motion,
    // which cancels everything except proper motion's own contribution.
    const index = catalog.indexOfHip.get(19849);
    expect(index).toBeDefined();
    const i = index as number;
    expect(catalog.pmra[i]).not.toBe(0);

    const jd = julianDate(new Date('2026-01-01T00:00:00Z'));
    const terms = apparentTerms(terrestrialJulianDate(jd));

    const precessionOnly = precessFromJ2000(catalog.ra[i] as number, catalog.dec[i] as number, jd);
    const withoutPM = applyApparentPlace(precessionOnly.ra, precessionOnly.dec, terms);
    const withPM = precessCatalog(catalog, jd);

    const pmContributionArcsec =
      angularSeparation(
        withoutPM.ra,
        withoutPM.dec,
        withPM.ra[i] as number,
        withPM.dec[i] as number,
      ) * 3600;

    expect(pmContributionArcsec).toBeGreaterThan(60);
    expect(pmContributionArcsec).toBeLessThan(200);
  });

  it('leaves a star with no proper motion to precession, nutation and aberration alone', () => {
    // A hand-built single-star catalogue, rather than searching the real data
    // for a literal (0, 0) entry -- real HYG measurements essentially always
    // carry some nonzero value, however small.
    const noMotion: StarCatalog = {
      count: 1,
      hip: Int32Array.from([1]),
      ra: Float64Array.from([88.7929]), // Betelgeuse, for a plausible position
      dec: Float64Array.from([7.407]),
      mag: Float32Array.from([0.5]),
      ci: Float32Array.from([1.85]),
      pmra: Float32Array.from([0]),
      pmdec: Float32Array.from([0]),
      indexOfHip: new Map([[1, 0]]),
    };

    const jd = julianDate(new Date('2026-01-01T00:00:00Z'));
    const terms = apparentTerms(terrestrialJulianDate(jd));
    const precessed = precessFromJ2000(noMotion.ra[0] as number, noMotion.dec[0] as number, jd);
    const direct = applyApparentPlace(precessed.ra, precessed.dec, terms);
    const viaCatalog = precessCatalog(noMotion, jd);

    expect(viaCatalog.ra[0]).toBeCloseTo(direct.ra, 6);
    expect(viaCatalog.dec[0]).toBeCloseTo(direct.dec, 6);
  });

  it('lifts stars near the horizon by refraction, and can be told not to', () => {
    const jd = julianDate(new Date('2026-02-14T18:30:00Z'));
    const lst = localSiderealTime(jd, 77.59);
    const latitude = 12.97;
    const precessed = precessCatalog(catalog, jd);

    const refracted = createHorizontalBuffer(catalog.count);
    toHorizontal(precessed, lst, latitude, refracted);
    const bare = createHorizontalBuffer(catalog.count);
    toHorizontal(precessed, lst, latitude, bare, catalog.count, false);

    // Find a star sitting close to the horizon, where the effect is largest.
    let index = -1;
    for (let i = 0; i < catalog.count; i += 1) {
      const alt = bare.altitude[i] as number;
      if (alt > -1 && alt < 3) {
        index = i;
        break;
      }
    }
    expect(index).toBeGreaterThanOrEqual(0);

    const trueAltitude = bare.altitude[index] as number;
    const lift = (refracted.altitude[index] as number) - trueAltitude;
    expect(lift).toBeCloseTo(refraction(trueAltitude), 5);
    expect(lift).toBeGreaterThan(0.1);

    // High overhead the correction is negligible either way.
    let overhead = -1;
    for (let i = 0; i < catalog.count; i += 1) {
      if ((bare.altitude[i] as number) > 80) {
        overhead = i;
        break;
      }
    }
    if (overhead >= 0) {
      expect(
        Math.abs((refracted.altitude[overhead] as number) - (bare.altitude[overhead] as number)),
      ).toBeLessThan(0.01);
    }
  });

  it('puts roughly half the sky above the horizon', () => {
    const jd = julianDate(new Date('2026-02-14T18:30:00Z'));
    const precessed = precessCatalog(catalog, jd);
    const buffer = createHorizontalBuffer(catalog.count);
    toHorizontal(precessed, localSiderealTime(jd, 0), 45, buffer);

    let above = 0;
    for (let i = 0; i < catalog.count; i += 1) above += buffer.visible[i] as number;
    const fraction = above / catalog.count;

    expect(fraction).toBeGreaterThan(0.3);
    expect(fraction).toBeLessThan(0.7);
  });

  it('resolves constellation figures to catalogue indices', () => {
    const figures = resolveConstellations(constellationsJson, catalog);
    expect(figures.byName.length).toBe(88);
    expect(figures.segments.length).toBeGreaterThan(1000);

    // Trimming the catalogue must not break a single figure: line vertices are
    // kept whatever their brightness, so all 88 stay whole.
    let dropped = 0;
    for (const constellation of constellationsJson.constellations) {
      for (const polyline of constellation.lines) {
        for (let i = 0; i + 1 < polyline.length; i += 1) {
          if (
            !catalog.indexOfHip.has(polyline[i] as number) ||
            !catalog.indexOfHip.has(polyline[i + 1] as number)
          ) {
            dropped += 1;
          }
        }
      }
    }
    expect(dropped, 'constellation segments with a missing vertex').toBe(0);

    // Every index must be in range, or the renderer reads past the buffer.
    for (const index of figures.segments) {
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(catalog.count);
    }

    const orion = figures.byName.find((c) => c.abbr === 'Ori');
    // The Latin IAU name is the label; the translation rides alongside it.
    expect(orion?.name).toBe('Orion');
    expect(orion?.common).toBe('Hunter');
    expect(figures.byName.find((c) => c.abbr === 'UMa')?.name).toBe('Ursa Major');
    expect((orion?.end as number) - (orion?.start as number)).toBeGreaterThan(5);
  });

  it('colours hot stars blue and cool stars red', () => {
    const hot = colorFromBV(-0.3); // Rigel
    const cool = colorFromBV(1.85); // Betelgeuse
    expect(hot.b).toBeGreaterThan(hot.r);
    expect(cool.r).toBeGreaterThan(cool.b);
    // And nothing outside the displayable range.
    for (const bv of [-5, -0.4, 0, 1, 3, 10]) {
      const c = colorFromBV(bv);
      for (const channel of [c.r, c.g, c.b]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('magnetic declination', () => {
  const grid = parseDeclinationGrid(declinationJson);

  it('reproduces known declinations', () => {
    // Published values for 2025, to the nearest degree.
    const places: [string, number, number, number][] = [
      ['Bengaluru', 12.97, 77.59, -1.1],
      ['Seattle', 47.61, -122.33, 15.1],
      ['New York', 40.71, -74.01, -12.5],
      ['Sydney', -33.87, 151.21, 12.8],
      ['London', 51.51, -0.13, 0.9],
    ];

    for (const [name, lat, lon, expected] of places) {
      const result = magneticDeclination(grid, lat, lon, new Date('2025-01-01T00:00:00Z'));
      expect(result.reliable, name).toBe(true);
      // Bilinear interpolation over a 5 degree grid costs a little accuracy;
      // a degree is still far better than the compass that consumes it.
      expect(Math.abs(result.degrees - expected), `${name}: ${result.degrees}`).toBeLessThan(1.2);
    }
  });

  it('interpolates smoothly rather than stepping between cells', () => {
    let previous = magneticDeclination(grid, 40, -74, new Date('2025-01-01T00:00:00Z')).degrees;
    for (let lon = -74; lon <= -69; lon += 0.25) {
      const next = magneticDeclination(grid, 40, lon, new Date('2025-01-01T00:00:00Z')).degrees;
      expect(Math.abs(next - previous)).toBeLessThan(0.5);
      previous = next;
    }
  });

  it('wraps across the date line', () => {
    const west = magneticDeclination(grid, 20, -179.9, new Date('2025-01-01T00:00:00Z'));
    const east = magneticDeclination(grid, 20, 179.9, new Date('2025-01-01T00:00:00Z'));
    expect(Math.abs(west.degrees - east.degrees)).toBeLessThan(0.5);
  });

  it('reports the polar regions as unreliable instead of guessing', () => {
    expect(magneticDeclination(grid, 88, 0).reliable).toBe(false);
    expect(magneticDeclination(grid, 88, 0).degrees).toBe(0);
    expect(magneticDeclination(grid, -87, 30).reliable).toBe(false);
  });

  it('flags itself stale once the device clock is past the model validity window', () => {
    expect(grid.validUntil).toBeDefined();

    const withinWindow = magneticDeclination(grid, 51.5, 0, new Date('2026-01-01T00:00:00Z'));
    expect(withinWindow.stale).toBe(false);

    const pastWindow = magneticDeclination(
      grid,
      51.5,
      0,
      new Date(`${Math.ceil(grid.validUntil as number) + 1}-06-01T00:00:00Z`),
    );
    expect(pastWindow.stale).toBe(true);
    // Staleness is a time check, not a location one -- a stale result still
    // carries a (extrapolated) number rather than silently zeroing out.
    expect(pastWindow.reliable).toBe(true);
    expect(pastWindow.degrees).not.toBe(0);
  });

  it('does not confuse "stale" with "unreliable" -- they are independent', () => {
    const farFuturePole = magneticDeclination(
      grid,
      88,
      0,
      new Date(`${Math.ceil((grid.validUntil as number) + 5)}-01-01T00:00:00Z`),
    );
    // Outside the grid AND past the validity window: both flags fire, neither
    // masks the other.
    expect(farFuturePole.reliable).toBe(false);
    expect(farFuturePole.stale).toBe(true);
  });

  it('drifts with the secular variation', () => {
    const now = magneticDeclination(grid, 51.5, 0, new Date('2025-01-01T00:00:00Z')).degrees;
    const later = magneticDeclination(grid, 51.5, 0, new Date('2030-01-01T00:00:00Z')).degrees;
    // The field really does move; a model that returns the same answer forever
    // has silently dropped the rate term.
    expect(Math.abs(later - now)).toBeGreaterThan(0.05);
    expect(Math.abs(later - now)).toBeLessThan(3);
  });

  it('computes decimal years', () => {
    expect(decimalYear(new Date('2025-01-01T00:00:00Z'))).toBeCloseTo(2025, 4);
    expect(decimalYear(new Date('2025-07-02T12:00:00Z'))).toBeCloseTo(2025.5, 2);
  });
});

describe('magnetic field intensity', () => {
  const grid = parseDeclinationGrid(declinationJson);

  it('falls in the real-world range everywhere on the grid', () => {
    // Earth's field runs roughly 22,000-67,000 nT depending on location; the
    // weakest is the South Atlantic Anomaly, the strongest is near the poles.
    for (const [name, lat, lon] of [
      ['Bengaluru', 12.97, 77.59],
      ['equator/mid-Pacific', 0, -160],
      ['South Atlantic Anomaly', -25, -45],
      ['near north pole', 80, 0],
      ['near south pole', -80, 0],
    ] as const) {
      const result = magneticFieldIntensity(grid, lat, lon);
      expect(result.reliable, name).toBe(true);
      expect(result.nanotesla, name).toBeGreaterThan(18000);
      expect(result.nanotesla, name).toBeLessThan(70000);
    }
  });

  it('is stronger near the poles than near the equator', () => {
    // The field is roughly dipolar: about twice as strong at the poles as at
    // the magnetic equator.
    const equator = magneticFieldIntensity(grid, 0, 0).nanotesla;
    const pole = magneticFieldIntensity(grid, 80, 0).nanotesla;
    expect(pole).toBeGreaterThan(equator);
  });

  it('interpolates smoothly rather than stepping between cells', () => {
    let previous = magneticFieldIntensity(grid, 40, -74).nanotesla;
    for (let lon = -74; lon <= -69; lon += 0.25) {
      const next = magneticFieldIntensity(grid, 40, lon).nanotesla;
      expect(Math.abs(next - previous)).toBeLessThan(200);
      previous = next;
    }
  });

  it('reports the polar regions as unreliable, matching declination', () => {
    expect(magneticFieldIntensity(grid, 88, 0).reliable).toBe(false);
    expect(magneticFieldIntensity(grid, 88, 0).nanotesla).toBe(0);
  });
});

describe('the whole chain', () => {
  it('places a star at the centre of the screen when the phone points at it', () => {
    // The end-to-end claim the app makes: aim the phone at a star and the
    // marker lands on it. Every stage has to agree for this to pass.
    const catalog = parseStarCatalog(starsJson);
    const when = new Date('2026-02-14T18:30:00Z');
    const jd = julianDate(when);
    const observer = { latitude: 12.97, longitude: 77.59 };
    const lst = localSiderealTime(jd, observer.longitude);

    const precessed = precessCatalog(catalog, jd);
    const buffer = createHorizontalBuffer(catalog.count);
    toHorizontal(precessed, lst, observer.latitude, buffer);

    // Pick a star that happens to be well up in the sky.
    let index = -1;
    for (let i = 0; i < catalog.count; i += 1) {
      if ((buffer.altitude[i] as number) > 40 && (buffer.altitude[i] as number) < 60) {
        index = i;
        break;
      }
    }
    expect(index).toBeGreaterThanOrEqual(0);

    const altitude = buffer.altitude[index] as number;
    const azimuth = buffer.azimuth[index] as number;

    // Aim a phone exactly at it: beta tilts up from flat, alpha turns the view.
    const basis = basisFromDeviceOrientation({ alpha: -azimuth, beta: 90 + altitude, gamma: 0 });
    expect(angularSeparation(basis.azimuth, basis.altitude, azimuth, altitude)).toBeLessThan(1e-6);

    const point = projectHorizontal(altitude, azimuth, basis, VIEWPORT);
    expect(point).not.toBeNull();
    expect(point?.x).toBeCloseTo(VIEWPORT.width / 2, 3);
    expect(point?.y).toBeCloseTo(VIEWPORT.height / 2, 3);
  });
});
