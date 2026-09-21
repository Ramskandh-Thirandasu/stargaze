/**
 * Following one object.
 *
 * The rest of the package answers "where is it"; this answers "which way do I
 * turn". Same convention as everything else here: degrees in, degrees out, no
 * DOM, no state. The readout on the other side of this is a readout -- none of
 * the arithmetic below belongs in an event handler.
 *
 * The case worth designing for is the target being BEHIND the camera.
 * {@link project} returns null there, correctly, and that is precisely the
 * moment someone is most lost -- so the direction to turn is taken from the
 * camera's own right/up axes, which stay meaningful all the way round, rather
 * than from a projection that has gone to infinity.
 */

import { angularDelta, angularSeparation, normalize360, toDegrees, toRadians } from './angles.js';
import {
  riseTransitSet,
  RISE_SET_ALTITUDE,
  type Horizontal,
  type Observer,
} from './coords.js';
import { directionFromHorizontal, type CameraBasis } from './orientation.js';
import { focalLength, project, type ScreenPoint, type Viewport } from './projection.js';
import { DAY_MS, formatOffset, PRESENT_TOLERANCE_MS } from './timetravel.js';

/**
 * The radius of the reticle render.ts draws at the centre of view, in pixels.
 * Locking on means the object is inside the circle you can actually see, so
 * the two numbers have to be the same one.
 */
export const RETICLE_RADIUS_PX = 27;

/** How far in from the edge the guidance arrow sits, in pixels. */
export const ARROW_MARGIN_PX = 38;

export interface Guidance {
  /** Angle between where the camera is aimed and the target, degrees. */
  separation: number;
  /**
   * Which way the arrow points, degrees clockwise from screen-up. Valid even
   * when the target is behind the camera, which is the point of it.
   */
  bearing: number;
  /** Shortest turn in azimuth, degrees. Positive is to the right. */
  turn: number;
  /** How much higher to aim, degrees. Positive is up. */
  climb: number;
  /** True when the target is behind the plane of the screen. */
  behind: boolean;
  /** True when the target is actually within the viewport's bounds. */
  onScreen: boolean;
  /** True when the target sits inside the reticle. */
  locked: boolean;
  /** Where the target lands on screen, or null when it has no projection. */
  point: ScreenPoint | null;
  /** Where to put the edge arrow, in viewport pixels. */
  arrow: { x: number; y: number };
}

export interface GuideOptions {
  /** Reticle radius in pixels; the lock threshold is its angular size. */
  lockPixels?: number;
  /** Inset from the viewport edge for the arrow, in pixels. */
  arrowMargin?: number;
}

/**
 * Everything the guidance display needs, from a target and where the phone is
 * pointed.
 */
export function guide(
  target: Horizontal,
  basis: CameraBasis,
  viewport: Viewport,
  options: GuideOptions = {},
): Guidance {
  const direction = directionFromHorizontal(target.altitude, target.azimuth);

  const forward =
    direction.x * basis.forward.x +
    direction.y * basis.forward.y +
    direction.z * basis.forward.z;
  const right =
    direction.x * basis.right.x + direction.y * basis.right.y + direction.z * basis.right.z;
  const up = direction.x * basis.up.x + direction.y * basis.up.y + direction.z * basis.up.z;

  // Vincenty rather than acos of the dot product above: this number decides
  // whether the app claims to be locked on, and acos loses its precision at
  // exactly the small angles that decision is made at. Azimuth runs clockwise
  // where right ascension runs the other way, but a separation is unchanged
  // by that mirror.
  const separation = angularSeparation(
    basis.azimuth,
    basis.altitude,
    target.azimuth,
    target.altitude,
  );

  const point = project(direction, basis, viewport);
  const bearing = normalize360(toDegrees(Math.atan2(right, up)));

  return {
    separation,
    bearing,
    turn: angularDelta(basis.azimuth, target.azimuth),
    climb: target.altitude - basis.altitude,
    behind: forward < 0,
    onScreen:
      point !== null &&
      point.x >= 0 &&
      point.x <= viewport.width &&
      point.y >= 0 &&
      point.y <= viewport.height,
    locked: separation <= pixelsToDegrees(options.lockPixels ?? RETICLE_RADIUS_PX, viewport),
    point,
    arrow: edgePoint(bearing, viewport, options.arrowMargin ?? ARROW_MARGIN_PX),
  };
}

/** Angular size of a radius drawn in pixels at the centre of view, degrees. */
export function pixelsToDegrees(pixels: number, viewport: Viewport): number {
  return toDegrees(Math.atan(pixels / focalLength(viewport)));
}

/**
 * Where a ray from the centre of the screen meets the edge.
 *
 * `bearing` is degrees clockwise from screen-up, the same convention
 * {@link guide} reports, so an arrow placed here and rotated by the same
 * number points along its own offset from the centre.
 */
export function edgePoint(
  bearing: number,
  viewport: Viewport,
  margin: number,
): { x: number; y: number } {
  const dx = Math.sin(toRadians(bearing));
  const dy = -Math.cos(toRadians(bearing)); // screen y grows downward

  const halfWidth = Math.max(0, viewport.width / 2 - margin);
  const halfHeight = Math.max(0, viewport.height / 2 - margin);

  // Whichever wall the ray reaches first.
  const scale = Math.min(
    Math.abs(dx) < 1e-9 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx),
    Math.abs(dy) < 1e-9 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy),
  );

  return {
    x: viewport.width / 2 + dx * scale,
    y: viewport.height / 2 + dy * scale,
  };
}

/**
 * The next rise, transit or set after `when`.
 *
 * {@link riseTransitSet} answers for the UTC day containing `when`, so the
 * time it gives back may already be in the past -- which is no use for a
 * countdown. This walks forward until it finds one that is not. Null means the
 * event does not happen at all from here: circumpolar, or never rises.
 */
export function nextEvent(
  kind: 'rise' | 'transit' | 'set',
  ra: number,
  dec: number,
  observer: Observer,
  when: Date,
  standardAltitude: number = RISE_SET_ALTITUDE.star,
): Date | null {
  // A star crosses the meridian about four minutes earlier each day, so
  // today and tomorrow always contain the next one; the third day is there
  // only so the boundary is never the thing that decides.
  for (let day = 0; day <= 2; day += 1) {
    const events = riseTransitSet(
      ra,
      dec,
      observer,
      new Date(when.getTime() + day * DAY_MS),
      standardAltitude,
    );
    if (events.circumpolar && kind !== 'transit') return null;
    if (events.neverRises) return null;

    const at = events[kind];
    if (at && at.getTime() > when.getTime()) return at;
  }
  return null;
}

/**
 * A countdown in words: "3h 20m", "14m".
 *
 * {@link formatOffset} already has the arithmetic; it just calls anything
 * under a minute "now", which is the right answer for a clock offset and the
 * wrong one for a countdown.
 */
export function formatDuration(ms: number): string {
  const total = Math.abs(ms);
  if (total < PRESENT_TOLERANCE_MS) return 'under a minute';
  return formatOffset(total).slice(1);
}

/**
 * What is drowning the faint stuff out.
 *
 * Below -18 degrees the sky is as dark as the visibility model gets, so
 * anything still washed out down there is the Moon's doing, not the Sun's.
 */
export function washoutCause(sunAltitude: number): 'daylight' | 'twilight' | 'moonlight' {
  return sunAltitude > 0 ? 'daylight' : sunAltitude > -18 ? 'twilight' : 'moonlight';
}

/** A label's footprint on screen: `y` is its top edge. */
export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Stop labels sitting on top of each other.
 *
 * Takes boxes in priority order -- brightest first, as the renderer already
 * walks the catalogue -- and returns the y each should be drawn at, or null
 * for one that should not be drawn at all. Dropping a label beats stacking
 * two: a name that has drifted far enough to sit over a different star is
 * worse than no name, and this app does not claim things it cannot back up.
 *
 * Labels move up rather than down because a label belongs above the dot it
 * names, so upward is the direction that keeps it off its own object.
 */
export function layoutLabels(
  labels: LabelBox[],
  gap = 3,
  maxNudge = 26,
): (number | null)[] {
  const placed: LabelBox[] = [];

  return labels.map((label) => {
    let y = label.y;

    // Each pass clears the one box that clashed, and y only ever decreases,
    // so this cannot cycle.
    for (let pass = 0; pass <= placed.length; pass += 1) {
      const clash = placed.find((other) => overlaps({ ...label, y }, other));
      if (!clash) break;
      y = clash.y - label.height - gap;
    }

    if (label.y - y > maxNudge || placed.some((other) => overlaps({ ...label, y }, other))) {
      return null;
    }

    placed.push({ ...label, y });
    return y;
  });
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
