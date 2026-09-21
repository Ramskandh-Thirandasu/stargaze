/**
 * Guidance onto an object: which way to turn, how far there is to go, when it
 * sets, and where the arrow goes -- including the half of the sky behind the
 * camera, where the projection has nothing to say.
 */

import { describe, expect, it } from 'vitest';
import {
  edgePoint,
  formatDuration,
  guide,
  layoutLabels,
  nextEvent,
  pixelsToDegrees,
  washoutCause,
} from '../src/tracking.js';
import { normalize180 } from '../src/angles.js';
import { directionFromHorizontal, type CameraBasis } from '../src/orientation.js';
import type { Viewport } from '../src/projection.js';

const VIEWPORT: Viewport = { width: 400, height: 800, horizontalFov: 66 };

/** Greenwich, to keep the sidereal arithmetic easy to check by hand. */
const OBSERVER = { latitude: 51.48, longitude: 0 };
const WHEN = new Date(Date.UTC(2026, 8, 19, 21, 30));

/**
 * A camera aimed at one altitude and azimuth with the phone held level about
 * the view axis -- the same basis basisFromDeviceOrientation produces, built
 * straight from the geometry so the test does not depend on sensor handling.
 */
function aimedAt(altitude: number, azimuth: number): CameraBasis {
  const forward = directionFromHorizontal(altitude, azimuth);
  const up = directionFromHorizontal(altitude + 90, azimuth);
  return {
    forward,
    up,
    right: {
      x: forward.y * up.z - forward.z * up.y,
      y: forward.z * up.x - forward.x * up.z,
      z: forward.x * up.y - forward.y * up.x,
    },
    altitude,
    azimuth,
    roll: 0,
  };
}

describe('guidance', () => {
  it('locks on to something dead centre', () => {
    const g = guide({ altitude: 30, azimuth: 120 }, aimedAt(30, 120), VIEWPORT);
    expect(g.separation).toBeCloseTo(0, 6);
    expect(g.locked).toBe(true);
    expect(g.behind).toBe(false);
    expect(g.onScreen).toBe(true);
  });

  it('does not lock on to something outside the reticle', () => {
    // 12 degrees of azimuth is only 10.4 degrees of sky at this altitude --
    // the separation is the real angle, not the difference in the readouts.
    const g = guide({ altitude: 30, azimuth: 132 }, aimedAt(30, 120), VIEWPORT);
    expect(g.locked).toBe(false);
    expect(g.separation).toBeCloseTo(10.4, 1);
  });

  it('points right for something to the right, and left for something to the left', () => {
    const right = guide({ altitude: 0, azimuth: 60 }, aimedAt(0, 20), VIEWPORT);
    expect(right.turn).toBeCloseTo(40, 6);
    expect(right.bearing).toBeCloseTo(90, 4);

    const left = guide({ altitude: 0, azimuth: 340 }, aimedAt(0, 20), VIEWPORT);
    expect(left.turn).toBeCloseTo(-40, 6);
    expect(left.bearing).toBeCloseTo(270, 4);
  });

  it('takes the short way round north rather than the long way', () => {
    const g = guide({ altitude: 0, azimuth: 10 }, aimedAt(0, 350), VIEWPORT);
    expect(g.turn).toBeCloseTo(20, 6);
  });

  it('points up for something overhead', () => {
    const g = guide({ altitude: 70, azimuth: 180 }, aimedAt(20, 180), VIEWPORT);
    expect(g.climb).toBeCloseTo(50, 6);
    // Straight up is the wrap point, so 0 and 360 are the same answer.
    expect(Math.abs(normalize180(g.bearing))).toBeLessThan(0.01);
  });

  it('still says which way to turn when the target is behind the camera', () => {
    // The projection is gone here, which is exactly when someone is lost.
    const g = guide({ altitude: 0, azimuth: 200 }, aimedAt(0, 20), VIEWPORT);
    expect(g.behind).toBe(true);
    expect(g.point).toBeNull();
    expect(g.onScreen).toBe(false);
    expect(g.separation).toBeCloseTo(180, 4);
  });

  it('turns toward the nearer shoulder for something mostly behind', () => {
    const overRight = guide({ altitude: 0, azimuth: 170 }, aimedAt(0, 20), VIEWPORT);
    expect(overRight.behind).toBe(true);
    expect(overRight.turn).toBeCloseTo(150, 6);
    expect(overRight.bearing).toBeCloseTo(90, 4);

    const overLeft = guide({ altitude: 0, azimuth: 230 }, aimedAt(0, 20), VIEWPORT);
    expect(overLeft.behind).toBe(true);
    expect(overLeft.turn).toBeCloseTo(-150, 6);
    expect(overLeft.bearing).toBeCloseTo(270, 4);
  });

  it('calls something at the edge of the view plane off screen without claiming it is behind', () => {
    const g = guide({ altitude: 0, azimuth: 110 }, aimedAt(0, 20), VIEWPORT);
    expect(g.behind).toBe(false);
    expect(g.onScreen).toBe(false);
  });

  it('keeps following as the camera turns, with the gap shrinking monotonically', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (const azimuth of [20, 40, 60, 80, 100, 115, 119, 120]) {
      const g = guide({ altitude: 30, azimuth: 120 }, aimedAt(30, azimuth), VIEWPORT);
      expect(g.separation).toBeLessThan(previous);
      previous = g.separation;
    }
    expect(previous).toBeCloseTo(0, 6);
  });
});

describe('reticle size', () => {
  it('reports the angular size of the drawn circle, not a guess', () => {
    // 400px wide at 66 degrees gives a focal length of about 308px.
    expect(pixelsToDegrees(27, VIEWPORT)).toBeCloseTo(5.0, 1);
  });

  it('shrinks as the field of view narrows', () => {
    const wide = pixelsToDegrees(27, VIEWPORT);
    const narrow = pixelsToDegrees(27, { ...VIEWPORT, horizontalFov: 20 });
    expect(narrow).toBeLessThan(wide);
  });
});

describe('edge arrow', () => {
  const MARGIN = 40;

  it('puts straight-up on the top edge, centred', () => {
    const point = edgePoint(0, VIEWPORT, MARGIN);
    expect(point.x).toBeCloseTo(200, 6);
    expect(point.y).toBeCloseTo(MARGIN, 6);
  });

  it('puts straight-down on the bottom edge', () => {
    const point = edgePoint(180, VIEWPORT, MARGIN);
    expect(point.x).toBeCloseTo(200, 6);
    expect(point.y).toBeCloseTo(800 - MARGIN, 6);
  });

  it('puts right and left on the side walls', () => {
    expect(edgePoint(90, VIEWPORT, MARGIN).x).toBeCloseTo(400 - MARGIN, 6);
    expect(edgePoint(90, VIEWPORT, MARGIN).y).toBeCloseTo(400, 6);
    expect(edgePoint(270, VIEWPORT, MARGIN).x).toBeCloseTo(MARGIN, 6);
    expect(edgePoint(270, VIEWPORT, MARGIN).y).toBeCloseTo(400, 6);
  });

  it('meets the corner on a square viewport at 45 degrees', () => {
    const square: Viewport = { width: 400, height: 400, horizontalFov: 66 };
    const point = edgePoint(45, square, MARGIN);
    expect(point.x).toBeCloseTo(400 - MARGIN, 6);
    expect(point.y).toBeCloseTo(MARGIN, 6);
  });

  it('never leaves the viewport, at any bearing', () => {
    for (let bearing = 0; bearing < 360; bearing += 7) {
      const point = edgePoint(bearing, VIEWPORT, MARGIN);
      expect(point.x).toBeGreaterThanOrEqual(MARGIN - 1e-9);
      expect(point.x).toBeLessThanOrEqual(400 - MARGIN + 1e-9);
      expect(point.y).toBeGreaterThanOrEqual(MARGIN - 1e-9);
      expect(point.y).toBeLessThanOrEqual(800 - MARGIN + 1e-9);
    }
  });
});

describe('next rise and set', () => {
  it('finds a set that is still ahead, not one from this morning', () => {
    // Right ascension chosen so today's set is already past at 21:30 UTC.
    const set = nextEvent('set', 30, 10, OBSERVER, WHEN);
    expect(set).not.toBeNull();
    expect((set as Date).getTime()).toBeGreaterThan(WHEN.getTime());
  });

  it('never looks more than a day and a bit ahead for an ordinary star', () => {
    for (const ra of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const set = nextEvent('set', ra, 10, OBSERVER, WHEN);
      expect(set).not.toBeNull();
      const hours = ((set as Date).getTime() - WHEN.getTime()) / 3600000;
      expect(hours).toBeGreaterThan(0);
      expect(hours).toBeLessThan(25);
    }
  });

  it('says nothing sets when nothing sets', () => {
    // Declination 89 from 51 north is circumpolar.
    expect(nextEvent('set', 37, 89, OBSERVER, WHEN)).toBeNull();
  });

  it('says nothing rises when nothing rises', () => {
    expect(nextEvent('rise', 37, -85, OBSERVER, WHEN)).toBeNull();
  });

  it('still gives a transit for something circumpolar -- it still has a highest point', () => {
    const transit = nextEvent('transit', 37, 89, OBSERVER, WHEN);
    expect(transit).not.toBeNull();
    expect((transit as Date).getTime()).toBeGreaterThan(WHEN.getTime());
  });
});

describe('countdown wording', () => {
  it('spells out hours and minutes', () => {
    expect(formatDuration(3 * 3600000 + 20 * 60000)).toBe('3h 20m');
  });

  it('drops the sign, whichever way the interval was measured', () => {
    expect(formatDuration(-45 * 60000)).toBe('45m');
  });

  it('refuses to call a countdown "now"', () => {
    expect(formatDuration(20000)).toBe('under a minute');
  });
});

describe('what is washing it out', () => {
  it('blames the Sun while it is up', () => {
    expect(washoutCause(20)).toBe('daylight');
  });

  it('blames twilight between sunset and astronomical dark', () => {
    expect(washoutCause(-5)).toBe('twilight');
    expect(washoutCause(-17)).toBe('twilight');
  });

  it('blames the Moon once the sky is as dark as the model gets', () => {
    expect(washoutCause(-40)).toBe('moonlight');
  });
});

describe('label layout', () => {
  const box = (x: number, y: number): { x: number; y: number; width: number; height: number } => ({
    x,
    y,
    width: 50,
    height: 12,
  });

  it('leaves labels that do not touch exactly where they were', () => {
    expect(layoutLabels([box(0, 100), box(200, 100)])).toEqual([100, 100]);
  });

  it('lifts the second of two labels that overlap', () => {
    const [first, second] = layoutLabels([box(0, 100), box(10, 104)]);
    expect(first).toBe(100);
    expect(second).not.toBeNull();
    expect(second as number).toBeLessThan(100 - 12);
  });

  it('never moves the first label -- priority order is brightest first', () => {
    const result = layoutLabels([box(0, 100), box(0, 100), box(0, 100)]);
    expect(result[0]).toBe(100);
  });

  it('drops a label rather than stack it once there is nowhere to put it', () => {
    const crowd = Array.from({ length: 8 }, () => box(0, 100));
    const result = layoutLabels(crowd);
    expect(result.filter((y) => y === null).length).toBeGreaterThan(0);
  });

  it('leaves no two placed labels overlapping', () => {
    const input = [box(0, 100), box(8, 106), box(16, 98), box(300, 100), box(305, 103)];
    const result = layoutLabels(input);

    const placed = input
      .map((label, i) => (result[i] === null ? null : { ...label, y: result[i] as number }))
      .filter((label): label is { x: number; y: number; width: number; height: number } =>
        Boolean(label),
      );

    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i] as { x: number; y: number; width: number; height: number };
        const b = placed[j] as { x: number; y: number; width: number; height: number };
        const clash =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(clash).toBe(false);
      }
    }
  });
});
