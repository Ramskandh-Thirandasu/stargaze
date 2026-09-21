/**
 * Looking at what the camera is actually seeing, and saying so.
 *
 * The app's geometry cannot tell a sky from a ceiling -- the stars really are
 * up there either way. The camera can, roughly, and this is the part that
 * turns its pixels into the plain numbers `skyConfidence` in core wants, plus
 * the one piece of UI that reports the answer.
 *
 * Both halves live here because they are the same feature and neither is big
 * enough to be worth its own file.
 */

import type { FrameStatistics } from '@stargaze/core';

/* ------------------------------------------------------------------ *
 * Sampling the camera
 * ------------------------------------------------------------------ */

/**
 * Side of the grid the frame is squashed down to.
 *
 * Small on purpose. The browser's own downscale does the averaging in native
 * code, a thousand cells is enough to see a gradient or a light fitting, and
 * reading back a 1080p frame several times a second would cost more than the
 * renderer does. It is also what kills the sensor noise a dark room is made
 * of: averaging two thousand pixels per cell shrinks read noise far more than
 * it shrinks anything with real structure behind it.
 */
const GRID = 32;

/** Roughly twice a second. Often enough to notice a phone being lowered, rare
 *  enough that a readback stall cannot stutter the sky. */
const SAMPLE_INTERVAL_MS = 450;

/** How far above its own neighbourhood a cell has to sit to count as a point
 *  source. In an 8-bit frame this is about 8 levels -- well past what survives
 *  of sensor noise after the downscale, and inside what a bright star or a
 *  distant lamp leaves behind. */
const POINT_EXCESS = 0.03;

/** At or above this, a cell has clipped. */
const SATURATED = 0.95;

/**
 * Periodically reduces the live camera frame to {@link FrameStatistics}.
 *
 * Every failure -- no 2D context, a video that has not decoded a frame yet, a
 * readback the browser refuses -- leaves `statistics` null, which the
 * confidence model reads as "no evidence" rather than as bad news.
 */
export class SkySampler {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D | null;
  private lastSampleMs = 0;

  /** The most recent reading, or null while there is nothing to report. */
  statistics: FrameStatistics | null = null;

  constructor() {
    this.canvas.width = GRID;
    this.canvas.height = GRID;
    // Without this hint Chrome keeps the canvas on the GPU and every
    // getImageData is a stall while it is copied back.
    this.context = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Call every frame; it decides for itself how often to actually look. */
  update(video: HTMLVideoElement, nowMs: number): void {
    if (!this.context) return;
    if (nowMs - this.lastSampleMs < SAMPLE_INTERVAL_MS) return;
    // HAVE_CURRENT_DATA. Below it there is no frame to draw, only a black one.
    if (video.readyState < 2 || video.videoWidth === 0) return;
    this.lastSampleMs = nowMs;

    try {
      this.context.drawImage(video, 0, 0, GRID, GRID);
      this.statistics = measure(this.context.getImageData(0, 0, GRID, GRID).data);
    } catch {
      // A tainted canvas, or a readback refused mid-teardown. Either way there
      // is nothing to say about this frame.
      this.statistics = null;
    }
  }

  /** For when the camera goes away -- a stale reading would keep answering for
   *  a lens that is no longer looking at anything. */
  clear(): void {
    this.statistics = null;
    this.lastSampleMs = 0;
  }
}

/** Rec. 709 luminance, 0 to 1, from the RGBA bytes of a GRID x GRID frame. */
function measure(pixels: Uint8ClampedArray): FrameStatistics {
  const cells = new Float32Array(GRID * GRID);
  let sum = 0;
  let saturated = 0;

  for (let i = 0; i < cells.length; i += 1) {
    const p = i * 4;
    const luminance =
      (0.2126 * (pixels[p] ?? 0) + 0.7152 * (pixels[p + 1] ?? 0) + 0.0722 * (pixels[p + 2] ?? 0)) /
      255;
    cells[i] = luminance;
    sum += luminance;
    if (luminance >= SATURATED) saturated += 1;
  }

  const mean = sum / cells.length;

  let squared = 0;
  for (const value of cells) squared += (value - mean) * (value - mean);

  // Horizontal and vertical adjacencies only. The diagonals carry the same
  // information at a longer baseline, which would bias the noise estimate.
  let neighbourSquared = 0;
  let pairs = 0;
  for (let y = 0; y < GRID; y += 1) {
    for (let x = 0; x < GRID; x += 1) {
      const here = cells[y * GRID + x] as number;
      if (x + 1 < GRID) {
        const right = cells[y * GRID + x + 1] as number;
        neighbourSquared += (here - right) * (here - right);
        pairs += 1;
      }
      if (y + 1 < GRID) {
        const below = cells[(y + 1) * GRID + x] as number;
        neighbourSquared += (here - below) * (here - below);
        pairs += 1;
      }
    }
  }

  return {
    meanLuminance: mean,
    variance: squared / cells.length,
    neighbourVariance: pairs === 0 ? 0 : neighbourSquared / pairs,
    pointSources: countPointSources(cells),
    saturatedFraction: saturated / cells.length,
  };
}

/**
 * Cells standing well clear of their own eight neighbours.
 *
 * Measured against the local background rather than the frame mean, so a star
 * over a bright patch of skyglow still counts and the interior of a large
 * saturated blob does not -- a light fitting's middle is surrounded by more of
 * itself. Its rim still counts, which is harmless: the confidence model only
 * consults this number for frames too dark to have a light fitting in them.
 * Edge cells are skipped rather than special-cased; the frame has nine hundred
 * interior ones.
 */
function countPointSources(cells: Float32Array): number {
  let found = 0;
  for (let y = 1; y < GRID - 1; y += 1) {
    for (let x = 1; x < GRID - 1; x += 1) {
      const here = cells[y * GRID + x] as number;
      let around = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx !== 0 || dy !== 0) around += cells[(y + dy) * GRID + x + dx] as number;
        }
      }
      if (here - around / 8 >= POINT_EXCESS) found += 1;
    }
  }
  return found;
}

/* ------------------------------------------------------------------ *
 * Telling the user, without taking the sky away
 * ------------------------------------------------------------------ */

export interface BannerAction {
  label: string;
  onPress: () => void;
}

/**
 * A single line of doubt over the sky, with a way out of it.
 *
 * Deliberately not a gate and not a toast. Not a gate because being wrong
 * about a ceiling must never cost someone the whole app, and not a toast
 * because a warning that vanishes after three seconds cannot be argued with
 * -- and this one has to be, since the override lives on it.
 *
 * Built here rather than in the shell because it carries its own styling and
 * has no business in the main layout; it borrows the shell's `glass` class and
 * custom properties so it still looks like the rest of the instrument.
 */
export class SkyBanner {
  private readonly root = document.createElement('div');
  private readonly text = document.createElement('p');
  private readonly buttons = document.createElement('div');
  /** The message currently on screen, so an unchanged one is not rebuilt every
   *  frame -- rebuilding it would steal focus and restart the fade. */
  private showing = '';
  /** The message the user has waved away. Stays hidden until what we have to
   *  say actually changes. */
  private dismissed = '';

  constructor(parent: HTMLElement) {
    this.root.className = 'glass';
    this.root.setAttribute('role', 'status');
    this.root.style.cssText = [
      'position:absolute',
      'left:12px',
      'right:12px',
      'bottom:calc(env(safe-area-inset-bottom, 0px) + 172px)',
      'max-width:calc(var(--shell-max) - 24px)',
      'margin-inline:auto',
      'padding:12px 14px',
      'border-radius:var(--r)',
      'z-index:5',
      'display:none',
      'font-size:13px',
      'line-height:1.45',
    ].join(';');

    this.text.style.cssText = 'margin:0 0 10px;color:var(--ink)';
    this.buttons.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    this.root.append(this.text, this.buttons);
    parent.append(this.root);
  }

  /**
   * Show `message`, or nothing if it is null. Actions are rendered right to
   * left in the order given, so the primary way out comes last.
   */
  show(message: string | null, actions: BannerAction[] = []): void {
    if (message === null || message === this.dismissed) {
      this.root.style.display = 'none';
      this.showing = '';
      return;
    }
    if (message === this.showing) return;

    const shown = message;
    this.showing = shown;
    this.text.textContent = shown;
    this.buttons.replaceChildren(
      ...actions.map((action) => this.button(action.label, action.onPress)),
      this.button('Dismiss', () => {
        this.dismissed = shown;
        this.root.style.display = 'none';
        this.showing = '';
      }),
    );
    this.root.style.display = 'block';
  }

  private button(label: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.style.cssText = [
      'min-height:36px',
      'padding:0 12px',
      'border:1px solid var(--hair-strong)',
      'border-radius:var(--r)',
      'background:transparent',
      'color:var(--ink)',
      'font:inherit',
      'font-size:13px',
      'cursor:pointer',
    ].join(';');
    button.addEventListener('click', onPress);
    return button;
  }
}
