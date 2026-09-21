/**
 * Drawing the sky.
 *
 * One canvas, one requestAnimationFrame loop. The work splits in two by how
 * fast it changes:
 *
 *   slow (about 1 Hz)  -- where things are in the sky. The sky turns 15 degrees
 *                         an hour, so recomputing nine thousand stars every
 *                         frame is wasted effort.
 *   fast (every frame) -- where the phone is pointed, and the projection.
 *
 * The cull matters more than anything else here: a dot product per object
 * rejects the ~95 per cent of the sky that is not on screen before any
 * trigonometry happens.
 */

import {
  colorFromBV,
  couldBeVisible,
  directionFromHorizontal,
  focalLength,
  project,
  viewConeRadius,
  type CameraBasis,
  type Viewport,
} from '@stargaze/core';

import type { StarCatalog } from '@stargaze/core';

import type { SkyFrame, SkyObject } from './sky.js';
import type { SkyData } from './data.js';

export interface RenderOptions {
  showConstellations: boolean;
  showLabels: boolean;
  showHorizon: boolean;
  magnitudeLimit: number;
  /**
   * The selected object, in the encoding `pick` returns, or null.
   *
   * Nullable rather than a -1 sentinel: objects encode as `-1 - index`, so the
   * Moon (object 0) IS -1. Using -1 to mean "nothing" made the most important
   * object in the app permanently unselectable.
   */
  selected: number | null;
}

const CARDINALS: [number, string][] = [
  [0, 'N'],
  [45, 'NE'],
  [90, 'E'],
  [135, 'SE'],
  [180, 'S'],
  [225, 'SW'],
  [270, 'W'],
  [315, 'NW'],
];

/** Rough colours for the planets, so they read as themselves at a glance. */
const PLANET_COLOR: Record<string, string> = {
  Mercury: '#d8d2c8',
  Venus: '#fff2d0',
  Mars: '#ff8a5c',
  Jupiter: '#ffe0b0',
  Saturn: '#f0d9a8',
  Uranus: '#a8e4e0',
  Neptune: '#8fb4f0',
  // The asteroids share one muted grey: they are rocks, they are points, and
  // giving each a colour would imply the app knows something about them that
  // it does not.
  Vesta: '#cfc6bb',
  Ceres: '#cfc6bb',
  Pallas: '#cfc6bb',
  Juno: '#cfc6bb',
  Sun: '#fff1c4',
  Moon: '#f2e6ce',
};

/**
 * Deep-sky markers get their own colour, away from the blues and creams the
 * stars occupy, so a smudge never reads as a bright star at a glance.
 */
const DEEP_SKY_COLOR = '154, 214, 196';

/** Radiants get a warm colour of their own: not a star, not a smudge. */
const SHOWER_COLOR = '240, 176, 108';

/**
 * Keep a centre-aligned label fully on screen.
 *
 * Labels are drawn centred on the object, so one near an edge gets its name
 * sliced in half -- "Jupiter" rendering as "upiter" is not a subtle defect.
 * Nudging it inward keeps the whole word readable; the object it belongs to
 * is still directly below it.
 */
function clampLabelX(ctx: CanvasRenderingContext2D, text: string, x: number, width: number): number {
  const half = ctx.measureText(text).width / 2;
  const margin = 6;
  return Math.max(half + margin, Math.min(width - half - margin, x));
}

export class SkyRenderer {
  private readonly context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private pixelRatio = 1;

  /** Screen positions of everything drawn this frame, for hit-testing. */
  private readonly hits: { x: number; y: number; index: number; radius: number }[] = [];

  /**
   * Per-star fill colours, built once per catalogue.
   *
   * A star's colour and its alpha both come from numbers that never change --
   * its B-V index and its magnitude -- so rebuilding the rgba() string every
   * frame is pure waste. It was cheap enough to ignore at a thousand stars;
   * measured at nine thousand it is about half the CPU the star loop spends
   * before a single pixel is drawn. Two variants because the only thing that
   * does vary is whether the sky has washed the star out.
   */
  private colors: { catalog: StarCatalog | null; normal: string[]; washedOut: string[] } = {
    catalog: null,
    normal: [],
    washedOut: [],
  };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('this browser has no 2D canvas context');
    this.context = context;
  }

  /** Size the backing store to the display, accounting for device pixels. */
  resize(): Viewport {
    const rect = this.canvas.getBoundingClientRect();
    // Cap at 2: beyond that the extra pixels cost real frame time on a phone
    // and buy nothing visible on a field of small dots.
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.width = Math.round(rect.width);
    this.height = Math.round(rect.height);

    this.canvas.width = Math.round(this.width * this.pixelRatio);
    this.canvas.height = Math.round(this.height * this.pixelRatio);

    return { width: this.width, height: this.height, horizontalFov: 66 };
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  draw(
    frame: SkyFrame,
    data: SkyData,
    basis: CameraBasis,
    viewport: Viewport,
    options: RenderOptions,
  ): void {
    const ctx = this.context;
    this.hits.length = 0;

    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const cosCone = Math.cos((viewConeRadius(viewport) * Math.PI) / 180);

    if (options.showHorizon) this.drawHorizon(basis, viewport, cosCone);
    if (options.showConstellations) this.drawConstellations(frame, data, basis, viewport);

    this.drawStars(frame, basis, viewport, cosCone, options);
    this.drawObjects(frame, basis, viewport, cosCone, options);
    this.drawReticle();
  }

  /* ---------------------------------------------------------------- *
   * Layers
   * ---------------------------------------------------------------- */

  private drawHorizon(basis: CameraBasis, viewport: Viewport, cosCone: number): void {
    const ctx = this.context;

    // The horizon as a polyline sampled every two degrees of azimuth. Drawing
    // it as a line rather than filling below it keeps the camera feed visible,
    // which is the whole point of pointing a camera at the ground.
    ctx.save();
    ctx.strokeStyle = 'rgba(148, 174, 226, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    let penDown = false;
    for (let azimuth = 0; azimuth <= 360; azimuth += 2) {
      const point = project(directionFromHorizontal(0, azimuth), basis, viewport);
      if (!point || Math.abs(point.x) > 1e5 || Math.abs(point.y) > 1e5) {
        penDown = false;
        continue;
      }
      if (penDown) ctx.lineTo(point.x, point.y);
      else ctx.moveTo(point.x, point.y);
      penDown = true;
    }
    ctx.stroke();

    // Cardinal marks sit on the horizon line.
    ctx.font = '600 12px "Space Grotesk", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [azimuth, label] of CARDINALS) {
      const direction = directionFromHorizontal(0, azimuth);
      if (!couldBeVisible(direction, basis, cosCone)) continue;
      const point = project(direction, basis, viewport);
      if (!point) continue;

      ctx.fillStyle = label.length === 1 ? 'rgba(236,229,215,0.85)' : 'rgba(236,229,215,0.46)';
      ctx.fillText(label, clampLabelX(ctx, label, point.x, this.width), point.y - 14);
    }

    ctx.restore();
  }

  private drawConstellations(
    frame: SkyFrame,
    data: SkyData,
    basis: CameraBasis,
    viewport: Viewport,
  ): void {
    const ctx = this.context;
    const { segments } = data.figures;
    const { altitude, azimuth } = frame.stars;

    ctx.save();
    ctx.strokeStyle = 'rgba(152, 182, 236, 0.26)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let i = 0; i < segments.length; i += 2) {
      const a = segments[i] as number;
      const b = segments[i + 1] as number;

      // Both ends have to be above the horizon, or the figure gets a leg
      // running off through the ground.
      if ((altitude[a] as number) < 0 || (altitude[b] as number) < 0) continue;

      const from = project(
        directionFromHorizontal(altitude[a] as number, azimuth[a] as number),
        basis,
        viewport,
      );
      if (!from) continue;
      const to = project(
        directionFromHorizontal(altitude[b] as number, azimuth[b] as number),
        basis,
        viewport,
      );
      if (!to) continue;

      // A segment spanning most of the screen is almost always one that wraps
      // round the back of the view; skip it rather than draw a wild diagonal.
      if (Math.hypot(to.x - from.x, to.y - from.y) > this.width * 1.8) continue;

      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  /** Fill colours for `catalog`, computed on first sight of it. */
  private starColors(catalog: StarCatalog): { normal: string[]; washedOut: string[] } {
    if (this.colors.catalog === catalog) return this.colors;

    const normal: string[] = new Array(catalog.count);
    const washedOut: string[] = new Array(catalog.count);

    for (let i = 0; i < catalog.count; i += 1) {
      const magnitude = catalog.mag[i] as number;
      // Brightness spans a factor of 100 over five magnitudes; alpha is
      // deliberately compressed against that, and floored so the faintest
      // star is dim rather than invisible.
      const alpha = Math.max(0.28, Math.min(1, 1.15 - magnitude * 0.14));
      const { r, g, b } = colorFromBV(catalog.ci[i] as number);
      const rgb = `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
      normal[i] = `rgba(${rgb},${alpha.toFixed(3)})`;
      washedOut[i] = `rgba(${rgb},${(alpha * 0.3).toFixed(3)})`;
    }

    this.colors = { catalog, normal, washedOut };
    return this.colors;
  }

  private drawStars(
    frame: SkyFrame,
    basis: CameraBasis,
    viewport: Viewport,
    cosCone: number,
    options: RenderOptions,
  ): void {
    const ctx = this.context;
    const { altitude, azimuth } = frame.stars;
    const { mag, ci } = frame.catalog;
    const colors = this.starColors(frame.catalog);

    // Scale dots with the zoom, so a narrow field looks like a telescope view
    // rather than the same dots further apart.
    const zoom = focalLength(viewport) / (viewport.width / 2);

    for (let i = 0; i < frame.starCount; i += 1) {
      const magnitude = mag[i] as number;
      if (magnitude > options.magnitudeLimit) break; // sorted brightest first
      if ((altitude[i] as number) < -1) continue;

      const direction = directionFromHorizontal(altitude[i] as number, azimuth[i] as number);
      if (!couldBeVisible(direction, basis, cosCone)) continue;

      const point = project(direction, basis, viewport);
      if (!point) continue;

      // Brightness spans a factor of 100 over five magnitudes; radius is
      // deliberately compressed against that, or Sirius becomes a disc.
      const radius = Math.max(0.55, (2.9 - 0.42 * magnitude) * Math.sqrt(zoom));
      // Washed out by the sky's own brightness (see visibility.ts): still
      // drawn, not silently dropped, just dim -- "there, but you won't see
      // it" rather than a marker over what looks like empty sky.
      const washedOut = magnitude > frame.limitingMagnitude;

      // Bright stars get a halo. It is not decoration: it is what makes a
      // first-magnitude star read as brighter rather than merely bigger. A
      // washed-out star has already been asked to look unremarkable. Only a
      // few dozen stars are this bright, so the gradient and its strings stay
      // out of the cached path.
      if (magnitude < 2.2 && !washedOut) {
        const alpha = Math.max(0.28, Math.min(1, 1.15 - magnitude * 0.14));
        const { r, g, b } = colorFromBV(ci[i] as number);
        const color = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},`;
        const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 4.5);
        glow.addColorStop(0, `${color}${(alpha * 0.5).toFixed(3)})`);
        glow.addColorStop(1, `${color}0)`);
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(point.x, point.y, radius * 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = (washedOut ? colors.washedOut[i] : colors.normal[i]) as string;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();

      this.hits.push({ x: point.x, y: point.y, index: i, radius });
    }
  }

  private drawObjects(
    frame: SkyFrame,
    basis: CameraBasis,
    viewport: Viewport,
    cosCone: number,
    options: RenderOptions,
  ): void {
    const ctx = this.context;
    const zoom = focalLength(viewport) / (viewport.width / 2);

    ctx.save();
    ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';

    frame.objects.forEach((object, index) => {
      if (object.altitude < -2) return;
      // One rule for the whole sky: nothing fainter than the user's setting
      // gets drawn, stars and planets and smudges alike. The Sun and Moon
      // clear it by twenty magnitudes, so in practice this is what keeps
      // Uranus, Neptune and the asteroids out of the default view.
      if (object.magnitude > options.magnitudeLimit) return;

      const direction = directionFromHorizontal(object.altitude, object.azimuth);
      if (!couldBeVisible(direction, basis, cosCone)) return;

      const point = project(direction, basis, viewport);
      if (!point) return;

      if (object.kind === 'deepsky') {
        this.drawDeepSky(object, point, viewport, index, frame.limitingMagnitude, options);
        return;
      }

      if (object.kind === 'shower') {
        this.drawRadiant(object, point, viewport, index, frame.limitingMagnitude, options);
        return;
      }

      const color = PLANET_COLOR[object.name] ?? '#ffffff';

      // The Moon is drawn at its true angular size; everything else is a point
      // source that only looks like a disc because the eye insists.
      const radius =
        object.angularDiameter > 0
          ? Math.max(4, (object.angularDiameter / 2) * (focalLength(viewport) * (Math.PI / 180)))
          : Math.max(2.6, (3.6 - 0.34 * object.magnitude) * Math.sqrt(zoom));

      // The Moon stays prominent regardless of daylight -- it's the easiest
      // thing in the sky to photograph and the best alignment target there
      // is. Everything else dims when the sky itself washes it out.
      const washedOut = object.name !== 'Moon' && object.magnitude > frame.limitingMagnitude;
      ctx.globalAlpha = washedOut ? 0.35 : 1;

      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 3.2);
      glow.addColorStop(0, `${color}88`);
      glow.addColorStop(1, `${color}00`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();

      if (object.name === 'Moon' && object.illumination !== undefined && radius > 6) {
        this.shadeMoon(point.x, point.y, radius, object.illumination, object.phase ?? 0);
      }

      if (options.showLabels) {
        ctx.fillStyle = 'rgba(236, 229, 215, 0.82)';
        ctx.fillText(
          object.name,
          clampLabelX(ctx, object.name, point.x, this.width),
          point.y - radius - 8,
        );
      }

      this.hits.push({
        x: point.x,
        y: point.y,
        index: -1 - index, // negative indices mean "an object, not a star"
        radius: Math.max(radius, 10),
      });
    });

    ctx.restore();

    if (options.selected !== null) this.drawSelection(frame, basis, viewport, options.selected);
  }

  /**
   * A deep-sky object, as an outline at its real apparent size.
   *
   * Deliberately not a dot. These are extended things -- M31 is six Moons
   * wide -- and drawing one as a point would promise a pinprick of light that
   * is not what turns up in the eyepiece or the photograph. The outline is
   * dashed because a galaxy has no edge: it says "roughly this big" rather
   * than claiming a boundary the object does not have.
   *
   * No position angle: the source catalogue leaves it blank for most entries,
   * and an ellipse rotated to a default of zero would be confidently wrong
   * more often than it was right.
   */
  private drawDeepSky(
    object: SkyObject,
    point: { x: number; y: number },
    viewport: Viewport,
    index: number,
    limitingMagnitude: number,
    options: RenderOptions,
  ): void {
    const ctx = this.context;
    const pixelsPerDegree = focalLength(viewport) * (Math.PI / 180);

    // A floor of 5 pixels: most of these are a few arcminutes across and
    // would otherwise draw smaller than the finger trying to tap them.
    const rx = Math.max(5, (object.angularDiameter / 2) * pixelsPerDegree);
    const ry = Math.max(4, ((object.angularMinor ?? object.angularDiameter) / 2) * pixelsPerDegree);

    const washedOut = object.magnitude > limitingMagnitude;
    ctx.globalAlpha = washedOut ? 0.32 : 0.85;

    ctx.strokeStyle = `rgba(${DEEP_SKY_COLOR},1)`;
    ctx.lineWidth = 1.1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.ellipse(point.x, point.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // A faint wash inside, so a large outline does not read as an empty ring.
    ctx.fillStyle = `rgba(${DEEP_SKY_COLOR},0.07)`;
    ctx.fill();

    // No label on something the sky has already washed out: the marker is
    // there to be found if you go looking, but a name floating over what
    // looks like empty sky is a promise the sky is not keeping tonight.
    if (options.showLabels && !washedOut) {
      ctx.fillStyle = `rgba(${DEEP_SKY_COLOR},0.82)`;
      ctx.fillText(
        object.name,
        clampLabelX(ctx, object.name, point.x, this.width),
        point.y - ry - 8,
      );
    }

    this.hits.push({ x: point.x, y: point.y, index: -1 - index, radius: Math.max(rx, 10) });
  }

  /**
   * A meteor radiant: a ring with spokes running outward from it.
   *
   * Drawn deliberately unlike everything else in the app, because it is the
   * one marker that is not an object. There is nothing at a radiant to look
   * at -- the meteors appear all over the sky and only trace back to here --
   * so the spokes point outward to say "watch around this", and the ring is
   * open rather than filled to avoid promising anything inside it.
   */
  private drawRadiant(
    object: SkyObject,
    point: { x: number; y: number },
    viewport: Viewport,
    index: number,
    limitingMagnitude: number,
    options: RenderOptions,
  ): void {
    const ctx = this.context;
    const radius = Math.max(
      14,
      (object.angularDiameter / 2) * focalLength(viewport) * (Math.PI / 180),
    );

    // Same rule as the stars: a sky bright enough to hide second-magnitude
    // meteors is a sky where this shower is not happening for the observer,
    // whatever the calendar says.
    const washedOut = object.magnitude > limitingMagnitude;
    ctx.globalAlpha = washedOut ? 0.3 : 0.85;

    ctx.strokeStyle = `rgba(${SHOWER_COLOR},1)`;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    for (let spoke = 0; spoke < 8; spoke += 1) {
      const angle = (spoke * Math.PI) / 4;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      ctx.beginPath();
      ctx.moveTo(point.x + dx * radius * 1.25, point.y + dy * radius * 1.25);
      ctx.lineTo(point.x + dx * radius * 1.9, point.y + dy * radius * 1.9);
      ctx.stroke();
    }

    // Labelled with the rate, because "Perseids" alone does not tell anyone
    // whether it is worth staying out. Suppressed when washed out, same as
    // the deep-sky labels: no confident name over sky that is not delivering.
    if (options.showLabels && !washedOut) {
      ctx.fillStyle = `rgba(${SHOWER_COLOR},0.85)`;
      const label = `${object.name} ~${object.hourlyRate}/hr`;
      ctx.fillText(
        label,
        clampLabelX(ctx, label, point.x, this.width),
        point.y - radius * 1.9 - 8,
      );
    }

    this.hits.push({ x: point.x, y: point.y, index: -1 - index, radius });
  }

  /** Darken the unlit part of the Moon's disc. */
  private shadeMoon(
    x: number,
    y: number,
    radius: number,
    illumination: number,
    phase: number,
  ): void {
    const ctx = this.context;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(7, 10, 18, 0.88)';
    // The terminator is an ellipse whose width tracks the illuminated fraction;
    // which side is dark flips at full moon.
    const waxing = phase < 0.5;
    const terminator = radius * (1 - 2 * illumination);

    ctx.beginPath();
    ctx.ellipse(x, y, Math.abs(terminator), radius, 0, 0, Math.PI * 2);
    const shadowRight = waxing ? -1 : 1;
    ctx.rect(x + (shadowRight < 0 ? -radius * 2 : 0), y - radius, radius * 2, radius * 2);

    ctx.fill('evenodd');
    ctx.restore();
  }

  private drawSelection(
    frame: SkyFrame,
    basis: CameraBasis,
    viewport: Viewport,
    selected: number,
  ): void {
    const ctx = this.context;
    const position = frame.positionOf(selected);
    if (!position) return;

    const point = project(
      directionFromHorizontal(position.altitude, position.azimuth),
      basis,
      viewport,
    );
    if (!point) return;

    ctx.save();
    ctx.strokeStyle = '#e2673c';
    ctx.lineWidth = 1.25;

    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 26, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 34, 0, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.9;
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(point.x + dx * 40, point.y + dy * 40);
      ctx.lineTo(point.x + dx * 30, point.y + dy * 30);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawReticle(): void {
    const ctx = this.context;
    const x = this.width / 2;
    const y = this.height / 2;

    ctx.save();
    ctx.strokeStyle = 'rgba(236, 229, 215, 0.22)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.arc(x, y, 27, 0, Math.PI * 2);
    ctx.stroke();

    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x + dx * 42, y + dy * 42);
      ctx.lineTo(x + dx * 22, y + dy * 22);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(236, 229, 215, 0.52)';
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * What was tapped.
   *
   * Returns a star index, or a negative value encoding an object index, or null.
   * The search radius is generous because a fingertip is about 8 mm and a
   * fourth-magnitude star is about one pixel.
   */
  pick(x: number, y: number, tolerance = 32): number | null {
    let best: number | null = null;
    let bestDistance = tolerance;

    for (const hit of this.hits) {
      const distance = Math.hypot(hit.x - x, hit.y - y);
      // Bias toward whatever is drawn larger when two are equally close: that
      // is the one the user could actually see to aim at.
      const effective = distance - hit.radius * 0.5;
      if (effective < bestDistance) {
        bestDistance = effective;
        best = hit.index;
      }
    }

    return best;
  }
}
