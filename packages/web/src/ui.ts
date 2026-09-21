/**
 * The chrome.
 *
 * Built by hand rather than with a framework: the whole UI is one HUD, two
 * sheets and a card, and it never re-renders from state -- the sky canvas is
 * the only thing redrawing at 60fps, and it is not part of the DOM.
 */

import {
  DAY_MS,
  formatDuration,
  formatOffset,
  guide,
  HOUR_MS,
  isPresent,
  nextEvent,
  normalize360,
  RISE_SET_ALTITUDE,
  scrubRate,
  washoutCause,
  type CameraBasis,
  type Guidance,
  type Viewport,
} from '@stargaze/core';

import type { ObjectDetail, ObjectKind, SkyFrame, TonightEntry } from './sky.js';

const svg = (paths: string, size = 22): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  tonight: svg(
    '<path d="M19.6 14.3A7.7 7.7 0 0 1 9.7 4.4a7.7 7.7 0 1 0 9.9 9.9Z"></path><path d="M17.4 3.2l.6 1.8 1.8.6-1.8.6-.6 1.8-.6-1.8-1.8-.6 1.8-.6Z"></path>',
  ),
  settings: svg(
    '<line x1="3" y1="8" x2="21" y2="8"></line><line x1="3" y1="16" x2="21" y2="16"></line><circle cx="9" cy="8" r="2.6"></circle><circle cx="16" cy="16" r="2.6"></circle>',
  ),
  compass: svg(
    '<circle cx="12" cy="12" r="8.5"></circle><path d="M15.3 8.7 13.6 13.6 8.7 15.3 10.4 10.4Z"></path>',
    20,
  ),
  camera: svg(
    '<path d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.2-2h8.2l1.2 2h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z"></path><circle cx="12" cy="13" r="3.6"></circle>',
    20,
  ),
  pin: svg(
    '<path d="M12 21s6.5-6.1 6.5-11a6.5 6.5 0 1 0-13 0C5.5 14.9 12 21 12 21Z"></path><circle cx="12" cy="10" r="2.5"></circle>',
    20,
  ),
  close: svg('<line x1="6" y1="6" x2="18" y2="18"></line><line x1="18" y1="6" x2="6" y2="18"></line>', 18),
  arrow: svg('<path d="M12 5 L12 19 M12 5 L8.4 9 M12 5 L15.6 9"></path>', 22),
  search: svg(
    '<circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="15.4" y1="15.4" x2="20.5" y2="20.5"></line>',
  ),
};

export interface TimeHandlers {
  /** The window the ephemeris is fit for, for the date picker's own limits. */
  bounds: { earliest: Date; latest: Date };
  /** Move the shown moment by this many milliseconds. */
  onScrub(deltaMs: number): void;
  /** Show this exact moment instead. */
  onPick(when: Date): void;
  /** Back to the present. */
  onNow(): void;
}

export interface TrackTarget {
  /** The renderer's index encoding -- see SkyFrame.positionOf. */
  index: number;
  /** What to call it, spelled the way the info card spells it. */
  label: string;
}

export interface Shell {
  canvas: HTMLCanvasElement;
  video: HTMLVideoElement;

  modeButton: HTMLButtonElement;
  tonightButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  searchButton: HTMLButtonElement;
  searchInput: HTMLInputElement;
  calibrateButton: HTMLButtonElement;
  calibrateConfirm: HTMLButtonElement;
  calibrateReset: HTMLButtonElement;

  cardClose: HTMLButtonElement;
  stopTrackingButton: HTMLButtonElement;

  magInput: HTMLInputElement;
  magValue: HTMLElement;
  fovInput: HTMLInputElement;
  fovValue: HTMLElement;
  linesToggle: HTMLButtonElement;
  labelsToggle: HTMLButtonElement;
  horizonToggle: HTMLButtonElement;
  refractionToggle: HTMLButtonElement;
  offsetMinus: HTMLButtonElement;
  offsetPlus: HTMLButtonElement;
  offsetValue: HTMLElement;
  locationForm: HTMLFormElement;
  latInput: HTMLInputElement;
  lonInput: HTMLInputElement;
  useGpsButton: HTMLButtonElement;
  permissionsSection: HTMLElement;
  cameraPermissionStatus: HTMLElement;
  enableCameraButton: HTMLButtonElement;

  fatal(title: string, detail: string): void;
  toast(text: string, ms?: number): void;
  wireTime(handlers: TimeHandlers): void;
  /** Say which moment the sky is drawn for, and how far that is from now. */
  showTime(when: Date, offsetMs: number, atLimit: boolean): void;
  updateHud(basis: CameraBasis, frame: SkyFrame, mode: string, magneticInterference: boolean): void;
  /** Start guiding the user onto this object. Null stops. */
  track(target: TrackTarget | null): void;
  /** Refresh the guidance for wherever the phone is pointed now.
   *  headingDoubt says the compass is not to be trusted, which makes every
   *  turn instruction below wrong by the same unknown amount -- see
   *  updateSkyConfidence in main.ts. */
  updateTracking(
    frame: SkyFrame,
    basis: CameraBasis,
    viewport: Viewport,
    headingDoubt?: boolean,
  ): void;
  openCard(detail: ObjectDetail): void;
  closeCard(): void;
  openSettings(): void;
  openTonight(
    entries: TonightEntry[],
    caption: string,
    onPick: (entry: TonightEntry) => void,
  ): void;
  openSearch(onQuery: (query: string) => TonightEntry[], onPick: (entry: TonightEntry) => void): void;
  openCalibrate(
    targets: TonightEntry[],
    onSelect: (entry: TonightEntry) => void,
    currentOffset: number,
  ): void;
  setCalibrationStatus(text: string): void;
  closeSheets(): void;
}

const CARDINAL_LABELS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

export function buildShell(root: HTMLElement): Shell {
  root.innerHTML = `
    <video id="camera" playsinline muted autoplay style="display:none"></video>
    <canvas id="sky"></canvas>

    <!-- A bright camera feed washes out the chrome that sits over it. This
         darkens only the bands the chrome occupies, in the page's own colour,
         and leaves the middle of the sky alone. -->
    <div class="skyscrim" aria-hidden="true"></div>

    <!-- Guidance to whatever is being tracked. Outside the HUD column because
         the arrow has to be able to sit anywhere against the screen edge, and
         the HUD is capped at phone width even on a tablet. -->
    <div class="tracker" id="tracker" data-open="false" aria-hidden="true">
      <div class="track-arrow" id="track-arrow" data-behind="false">
        <span class="track-arrow-glyph" id="track-arrow-glyph">${icons.arrow}</span>
        <span class="mono" id="track-arrow-gap">—</span>
      </div>
    </div>

    <!-- Lit only while the sky on screen is not the sky outside. Deliberately
         impossible to miss from the corner of an eye: the failure this guards
         against is walking outside still believing the overlay. -->
    <div class="timeframe" id="timeframe" data-open="false"></div>

    <div class="hud">
      <div class="compass glass">
        <svg id="compass-svg" viewBox="0 0 366 60" preserveAspectRatio="none" width="100%" height="60"></svg>
      </div>
      <div class="readouts">
        <div class="pill glass"><span class="cap">Alt</span><span class="mono" id="alt">—</span></div>
        <div class="pill glass"><span class="cap">Az</span><span class="mono" id="az">—</span></div>
        <div class="pill glass" id="decl-pill"><span class="cap">Dec</span><span class="mono" id="decl">—</span></div>
      </div>
      <div class="spacer"></div>

      <!-- The tracking readout. Sits with the time bar rather than in a sheet
           for the same reason: while something is being followed, which way to
           turn is part of the reading, not a setting to go and look up. -->
      <div class="trackbar glass" id="trackbar" data-open="false" data-locked="false" data-behind="false">
        <div class="track-head">
          <span class="track-dot" aria-hidden="true"></span>
          <div class="track-title">
            <b id="track-name">—</b>
            <span id="track-state">—</span>
          </div>
          <button class="iconbtn" id="track-stop" type="button" aria-label="Stop following this object">${icons.close}</button>
        </div>
        <div class="track-figures">
          <span><span class="cap">Alt</span><span class="mono" id="track-alt">—</span></span>
          <span><span class="cap">Az</span><span class="mono" id="track-az">—</span></span>
          <span><span class="cap" id="track-event-cap">Sets</span><span class="mono" id="track-event">—</span></span>
        </div>
        <!-- Degrees change every frame, so only the coarse state is announced
             -- a live region reading out a counter is unusable. -->
        <span class="sr-only" id="track-status" role="status" aria-live="polite"></span>
      </div>

      <div class="timebar glass" id="timebar" data-travelling="false">
        <div class="timerow">
          <button class="timestep mono" id="time-day-back" type="button" aria-label="Back one day">−1d</button>
          <button class="timestep mono" id="time-hour-back" type="button" aria-label="Back one hour">−1h</button>
          <label class="timepick">
            <span class="cap" id="time-tag">Showing now</span>
            <span class="mono" id="time-value">—</span>
            <input type="datetime-local" id="time-date" aria-label="Show the sky at a date and time" />
          </label>
          <button class="timestep mono" id="time-hour-fwd" type="button" aria-label="Forward one hour">+1h</button>
          <button class="timestep mono" id="time-day-fwd" type="button" aria-label="Forward one day">+1d</button>
        </div>
        <input class="jog" type="range" id="time" min="-1" max="1" step="0.01" value="0"
          aria-label="Scrub the sky backwards and forwards" />
        <button class="timereset" id="btn-now" type="button">Back to now</button>
      </div>
      <div class="navbar glass">
        <button class="navbtn" id="btn-search" type="button">${icons.search}<span>Search</span></button>
        <button class="navbtn" id="btn-tonight" type="button">${icons.tonight}<span>Tonight</span></button>
        <button class="navbtn" id="btn-mode" type="button" aria-pressed="false">${icons.compass}<span>Drag</span></button>
        <button class="navbtn" id="btn-settings" type="button">${icons.settings}<span>Settings</span></button>
      </div>
    </div>

    <div class="toast glass" id="toast"></div>

    <div class="card glass" id="card">
      <div class="card-head">
        <div style="display:flex;flex-direction:column;gap:7px;min-width:0">
          <h1 id="card-title">—</h1>
          <div id="card-sub" class="help" style="font-size:12.5px"></div>
          <div id="card-chips" style="display:flex;gap:7px;flex-wrap:wrap"></div>
        </div>
        <button class="iconbtn" id="card-close" type="button" aria-label="Close">${icons.close}</button>
      </div>
      <div class="rule"></div>
      <div class="stats" id="card-stats"></div>
      <!-- What the static stats above cannot say: when it is highest, and
           whether the sky is drowning it out as you read this. -->
      <p class="card-note" id="card-note" hidden></p>
      <!-- Closing the card by this route keeps the object selected, so the
           track bar takes over. The X beside the title means "done with this
           object" and drops the guidance with it. -->
      <button class="primary" id="card-follow" type="button" style="margin-top:20px">Follow it</button>
      <div style="display:flex;align-items:center;gap:9px;margin-top:18px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.09)">
        <span style="color:var(--accent);display:flex">${icons.compass}</span>
        <span class="help" id="card-footer" style="font-size:12.5px"></span>
      </div>
    </div>

    <div class="sheet glass" id="sheet-tonight">
      <div class="grabber"></div>
      <button class="sheet-close iconbtn" type="button" aria-label="Close">${icons.close}</button>
      <h2>Tonight</h2>
      <div class="help" id="tonight-sub" style="margin-top:6px"></div>
      <div class="sheet-body"><div class="list" id="tonight-list"></div></div>
    </div>

    <div class="sheet glass" id="sheet-search">
      <div class="grabber"></div>
      <button class="sheet-close iconbtn" type="button" aria-label="Close">${icons.close}</button>
      <h2>Search</h2>
      <div class="searchbar">
        <span class="searchbar-icon">${icons.search}</span>
        <input id="search-input" type="search" inputmode="search" autocomplete="off"
          autocapitalize="off" spellcheck="false" placeholder="Star, planet or constellation" />
      </div>
      <div class="sheet-body"><div class="list" id="search-list"></div></div>
    </div>

    <div class="sheet glass" id="sheet-calibrate">
      <div class="grabber"></div>
      <button class="sheet-close iconbtn" type="button" aria-label="Close">${icons.close}</button>
      <h2>Calibrate the compass</h2>
      <div class="sheet-body">
        <p class="help" style="line-height:1.5;margin:0 0 12px">
          A phone compass is out by 5&ndash;15&deg;, and worse near metal or in a car.
          Everything else here is accurate to a fraction of an arcminute, so this
          one sighting is the largest accuracy gain available.
        </p>
        <p class="help" style="line-height:1.5;margin:0 0 18px">
          Pick something you can actually see, put the crosshair on it, hold still,
          then confirm.
        </p>
        <div class="cal-status" id="cal-status">Choose a target.</div>
        <div class="list" id="cal-list"></div>
        <button class="primary" id="cal-confirm" type="button" style="margin-top:20px" disabled>
          Confirm sighting
        </button>
        <button class="secondary" id="cal-reset" type="button">Clear correction</button>
      </div>
    </div>

    <div class="sheet glass" id="sheet-settings">
      <div class="grabber"></div>
      <button class="sheet-close iconbtn" type="button" aria-label="Close">${icons.close}</button>
      <h2>Settings</h2>
      <div class="sheet-body">
        <span class="cap">Catalogue</span>
        <div class="field">
          <div class="field-head"><b>Magnitude cutoff</b><span id="mag-value">4.5</span></div>
          <input type="range" id="mag" min="1" max="6.5" step="0.1" />
          <span class="help">Lower this in a town. 6.5 is the whole catalogue -- the naked-eye limit under a genuinely dark sky.</span>
        </div>
        <div class="row"><b style="font-size:14.5px;font-weight:500">Constellation lines</b>
          <button class="switch" id="t-lines" type="button" aria-pressed="true"></button></div>
        <div class="row"><b style="font-size:14.5px;font-weight:500">Planet labels</b>
          <button class="switch" id="t-labels" type="button" aria-pressed="true"></button></div>
        <div class="row"><b style="font-size:14.5px;font-weight:500">Horizon</b>
          <button class="switch" id="t-horizon" type="button" aria-pressed="true"></button></div>

        <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.08)">
          <span class="cap">Alignment</span>
          <div class="field">
            <div class="field-head"><b>Camera field of view</b><span id="fov-value">66°</span></div>
            <input type="range" id="fov" min="20" max="100" step="1" />
            <span class="help">Widen or narrow until the overlay sits on the real stars.</span>
          </div>
          <div class="row">
            <div style="display:flex;flex-direction:column;gap:4px">
              <b style="font-size:14.5px;font-weight:500">True-north offset</b>
              <span class="help" id="decl-help">Magnetic declination applied automatically.</span>
            </div>
            <div style="display:flex;align-items:center;gap:4px;flex:0 0 auto">
              <button class="iconbtn" id="off-minus" type="button" style="border:1px solid var(--hair);font-size:19px">−</button>
              <span class="mono" id="off-value" style="min-width:62px;text-align:center;font-size:14px;color:var(--accent)">0.0°</span>
              <button class="iconbtn" id="off-plus" type="button" style="border:1px solid var(--hair);font-size:19px">+</button>
            </div>
          </div>
          <div class="row">
            <div style="display:flex;flex-direction:column;gap:4px">
              <b style="font-size:14.5px;font-weight:500">Atmospheric refraction</b>
              <span class="help">The air lifts everything near the horizon by up to half a degree. Off shows the true position instead.</span>
            </div>
            <button class="switch" id="t-refraction" type="button" aria-pressed="true"></button>
          </div>
        </div>

        <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.08)">
          <span class="cap">Observer</span>
          <form id="loc-form" style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
            <div style="display:flex;gap:10px">
              <label style="flex:1;display:flex;flex-direction:column;gap:6px">
                <span class="cap">Latitude</span>
                <input class="mono" id="lat" type="number" step="0.0001" inputmode="decimal"
                  style="width:100%;height:44px;padding:0 12px;border:1px solid var(--hair);border-radius:12px;background:rgba(255,255,255,0.04);color:var(--ink);font-size:14px" />
              </label>
              <label style="flex:1;display:flex;flex-direction:column;gap:6px">
                <span class="cap">Longitude</span>
                <input class="mono" id="lon" type="number" step="0.0001" inputmode="decimal"
                  style="width:100%;height:44px;padding:0 12px;border:1px solid var(--hair);border-radius:12px;background:rgba(255,255,255,0.04);color:var(--ink);font-size:14px" />
              </label>
            </div>
            <button class="secondary" type="submit" style="margin-top:0">Use these coordinates</button>
          </form>
          <button class="secondary" id="use-gps" type="button">Use my location</button>
        </div>

        <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.08)">
          <span class="cap">Accuracy</span>
          <button class="secondary" id="btn-calibrate" type="button" style="margin-top:14px">
            Calibrate on a known star
          </button>
        </div>

        <div id="permissions-section" style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.08)">
          <span class="cap">Permissions</span>
          <p class="help" style="line-height:1.5;margin:8px 0 0">
            Turned something off by mistake, or changed your mind? Ask again here --
            no need to clear site data or reinstall.
          </p>
          <div id="camera-permission-row" class="row">
            <div style="display:flex;flex-direction:column;gap:4px">
              <b style="font-size:14.5px;font-weight:500">Camera</b>
              <span class="help" id="camera-permission-status">Not requested</span>
            </div>
            <button class="secondary" id="btn-enable-camera" type="button" style="margin-top:0;width:auto;padding:0 16px;height:38px">
              Enable
            </button>
          </div>
        </div>

        <div style="margin-top:24px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.08)">
          <span class="cap">Credits</span>
          <p class="help" style="line-height:1.6;margin-top:10px">
            Star positions, magnitudes, colours and names: <a href="https://github.com/astronexus/HYG-Database" target="_blank" rel="noopener">HYG Database v4.0</a>, David Nash / astronexus (CC BY-SA 4.0).
            Constellation figures: <a href="https://github.com/Stellarium/stellarium" target="_blank" rel="noopener">Stellarium</a> sky culture modern_iau (CC BY-SA 4.0).
            Planetary elements: NASA JPL SSD, <a href="https://ssd.jpl.nasa.gov/planets/approx_pos.html" target="_blank" rel="noopener">Approximate Positions of the Planets</a> (public domain).
            Magnetic declination: <a href="https://www.ngdc.noaa.gov/IAGA/vmod/igrf.html" target="_blank" rel="noopener">IGRF-14</a>, IAGA Working Group V-MOD via NOAA NCEI.
          </p>
        </div>
      </div>
    </div>

  `;

  const pick = <T extends HTMLElement>(id: string): T => root.querySelector<T>(`#${id}`)!;

  const canvas = pick<HTMLCanvasElement>('sky');
  const toastEl = pick('toast');
  const card = pick('card');
  const sheetTonight = pick('sheet-tonight');
  const sheetSettings = pick('sheet-settings');
  const compassSvg = pick<SVGSVGElement & HTMLElement>('compass-svg');

  let toastTimer = 0;

  const sheetSearch = pick('sheet-search');
  const sheetCalibrate = pick('sheet-calibrate');

  // Held rather than looked up: unlike the rest of the chrome, these are
  // written on every frame the guidance is running.
  const tracker = pick('tracker');
  const trackArrow = pick('track-arrow');
  const trackArrowGlyph = pick('track-arrow-glyph');
  const trackArrowGap = pick('track-arrow-gap');
  const trackbar = pick('trackbar');
  const trackName = pick('track-name');
  const trackState = pick('track-state');
  const trackAlt = pick('track-alt');
  const trackAz = pick('track-az');
  const trackEventCap = pick('track-event-cap');
  const trackEvent = pick('track-event');
  const trackStatus = pick('track-status');
  const cardNote = pick('card-note');

  /** What is being followed, or null. */
  let tracked: TrackTarget | null = null;
  /** Rise and set move by minutes, not by frames -- see refreshTrackEvents. */
  let eventsKey = '';
  /** Only touch the live region when the coarse state actually changes. */
  let lastStatus = '';

  const closeSheets = (): void => {
    sheetTonight.dataset.open = 'false';
    sheetSettings.dataset.open = 'false';
    sheetSearch.dataset.open = 'false';
    sheetCalibrate.dataset.open = 'false';
  };

  // Tapping the sky dismisses whatever is open.
  canvas.addEventListener('pointerdown', closeSheets);
  // Tapping the sky closes a sheet, but on a phone an open sheet covers
  // most of it -- there has to be a control you can actually see.
  root.querySelectorAll('.sheet-close').forEach((button) =>
    button.addEventListener('click', closeSheets),
  );

  // Deliberately not shell.closeCard(): that clears the selection, and this
  // is the one exit from the card that means "keep pointing me at it".
  pick<HTMLButtonElement>('card-follow').addEventListener('click', () => {
    card.dataset.open = 'false';
  });

  const shell: Shell = {
    canvas,
    video: pick<HTMLVideoElement>('camera'),

    modeButton: pick<HTMLButtonElement>('btn-mode'),
    tonightButton: pick<HTMLButtonElement>('btn-tonight'),
    settingsButton: pick<HTMLButtonElement>('btn-settings'),
    searchButton: pick<HTMLButtonElement>('btn-search'),
    searchInput: pick<HTMLInputElement>('search-input'),
    calibrateButton: pick<HTMLButtonElement>('btn-calibrate'),
    calibrateConfirm: pick<HTMLButtonElement>('cal-confirm'),
    calibrateReset: pick<HTMLButtonElement>('cal-reset'),
    cardClose: pick<HTMLButtonElement>('card-close'),
    stopTrackingButton: pick<HTMLButtonElement>('track-stop'),

    magInput: pick<HTMLInputElement>('mag'),
    magValue: pick('mag-value'),
    fovInput: pick<HTMLInputElement>('fov'),
    fovValue: pick('fov-value'),
    linesToggle: pick<HTMLButtonElement>('t-lines'),
    labelsToggle: pick<HTMLButtonElement>('t-labels'),
    horizonToggle: pick<HTMLButtonElement>('t-horizon'),
    refractionToggle: pick<HTMLButtonElement>('t-refraction'),
    offsetMinus: pick<HTMLButtonElement>('off-minus'),
    offsetPlus: pick<HTMLButtonElement>('off-plus'),
    offsetValue: pick('off-value'),
    locationForm: pick<HTMLFormElement>('loc-form'),
    latInput: pick<HTMLInputElement>('lat'),
    lonInput: pick<HTMLInputElement>('lon'),
    useGpsButton: pick<HTMLButtonElement>('use-gps'),
    permissionsSection: pick('permissions-section'),
    cameraPermissionStatus: pick('camera-permission-status'),
    enableCameraButton: pick<HTMLButtonElement>('btn-enable-camera'),




    fatal(title, detail) {
      // The catalogue failed to load, so there is no sky to show behind
      // anything -- this replaces the whole app rather than overlaying it.
      root.innerHTML = `
        <div class="gate" style="align-items:center;justify-content:center;text-align:center">
        <div style="margin:auto;text-align:center;max-width:320px">
          <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
          <p class="help" style="font-size:13px;line-height:1.5">${detail}</p>
          <p class="help" style="font-size:12px;margin-top:20px">Run <code>npm run data</code> to generate the catalogue.</p>
        </div></div>`;
    },

    wireTime({ bounds, onScrub, onPick, onNow }) {
      const jog = pick<HTMLInputElement>('time');
      const dateInput = pick<HTMLInputElement>('time-date');

      for (const [id, delta] of [
        ['time-day-back', -DAY_MS],
        ['time-hour-back', -HOUR_MS],
        ['time-hour-fwd', HOUR_MS],
        ['time-day-fwd', DAY_MS],
      ] as const) {
        pick<HTMLButtonElement>(id).addEventListener('click', () => onScrub(delta));
      }

      pick<HTMLButtonElement>('btn-now').addEventListener('click', onNow);

      // The browser's own picker, bounded by the browser -- one less way to
      // reach a date the planetary theory was never fit for.
      dateInput.min = datetimeLocalValue(bounds.earliest);
      dateInput.max = datetimeLocalValue(bounds.latest);
      dateInput.addEventListener('click', () => {
        // A desktop browser focuses a date field on click but only opens the
        // calendar from its own icon, which is invisible under this label.
        // Phones open it on the tap alone, and old browsers have neither.
        try {
          dateInput.showPicker?.();
        } catch {
          /* already open, or the browser would rather not */
        }
      });

      dateInput.addEventListener('change', () => {
        // A datetime-local value has no zone, and JS parses that form as local
        // wall-clock time -- which is what the user typed.
        const chosen = new Date(dateInput.value);
        if (!Number.isNaN(chosen.getTime())) onPick(chosen);
      });

      // The jog wheel runs the clock rather than setting it: hold it over and
      // the sky keeps turning, which is the half of this worth watching. It
      // springs back to centre on release, so a control that shows no offset
      // can never be sitting on one.
      let running = 0;
      let previous = 0;
      const step = (stamp: number): void => {
        const elapsed = previous === 0 ? 0 : stamp - previous;
        previous = stamp;
        const rate = scrubRate(Number(jog.value));
        if (rate === 0) {
          running = 0;
          previous = 0;
          return;
        }
        onScrub(rate * elapsed);
        running = requestAnimationFrame(step);
      };

      jog.addEventListener('input', () => {
        if (!running) running = requestAnimationFrame(step);
      });

      const centre = (): void => {
        jog.value = '0';
      };
      for (const event of ['pointerup', 'pointercancel', 'blur', 'keyup'] as const) {
        jog.addEventListener(event, centre);
      }
    },

    showTime(when, offsetMs, atLimit) {
      const travelling = !isPresent(offsetMs);
      pick('timebar').dataset.travelling = String(travelling);
      pick('timeframe').dataset.open = String(travelling);

      pick('time-tag').textContent = atLimit
        ? 'As far as the maths goes'
        : travelling
          ? `Time travel · ${formatOffset(offsetMs)}`
          : 'Showing now';

      // The year is always shown. Everywhere else in this app a date is today,
      // so the one place it might not be is the place to be explicit.
      pick('time-value').textContent = when.toLocaleString([], {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });

      // Leave the picker alone while it has focus, or it rewrites what is
      // being typed into it.
      const dateInput = pick<HTMLInputElement>('time-date');
      if (document.activeElement !== dateInput) dateInput.value = datetimeLocalValue(when);
    },

    toast(text, ms = 3200) {
      toastEl.textContent = text;
      toastEl.dataset.open = 'true';
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => {
        toastEl.dataset.open = 'false';
      }, ms);
    },

    updateHud(basis, frame, mode, magneticInterference) {
      pick('alt').textContent = `${basis.altitude.toFixed(1)}°`;
      pick('az').textContent = `${basis.azimuth.toFixed(1)}°`;

      const azPill = pick('az').closest('.pill');
      azPill?.classList.toggle('warn', magneticInterference);
      azPill?.setAttribute(
        'title',
        magneticInterference
          ? 'The magnetic field reading here does not match what is expected -- something nearby may be throwing the compass off.'
          : '',
      );

      const declPill = pick('decl-pill');
      if (frame.declinationReliable) {
        pick('decl').textContent = `${frame.declination > 0 ? '+' : ''}${frame.declination.toFixed(1)}°`;
        declPill.classList.toggle('warn', frame.declinationStale);
        declPill.setAttribute(
          'title',
          frame.declinationStale
            ? 'This device’s clock is past the magnetic model’s forecast window -- the correction shown is extrapolated, not current.'
            : '',
        );
      } else {
        // Say so rather than showing a zero that looks like a measurement.
        pick('decl').textContent = 'n/a';
        declPill.classList.add('warn');
        declPill.setAttribute('title', '');
      }

      drawCompass(compassSvg, basis.azimuth, mode);
    },

    track(target) {
      tracked = target;
      eventsKey = '';
      lastStatus = '';
      trackbar.dataset.open = String(target !== null);
      if (target) trackName.textContent = target.label;
      if (!target) {
        tracker.dataset.open = 'false';
        cardNote.hidden = true;
      }
    },

    updateTracking(frame, basis, viewport, headingDoubt = false) {
      if (!tracked) return;

      const position = frame.positionOf(tracked.index);
      const facts = trackedFacts(tracked.index, frame);
      if (!position || !facts) {
        // The catalogue cutoff moved under the selection, or the object went
        // out of the frame. Say nothing rather than guess at where it went.
        shell.track(null);
        return;
      }

      const guidance = guide(position, basis, viewport);

      trackbar.dataset.locked = String(guidance.locked);
      trackbar.dataset.behind = String(guidance.behind);
      // Not colour alone: the wording changes with the state, and the dot
      // fills, and the border thickens.
      trackbar.dataset.near = String(!guidance.locked && guidance.separation < 20);

      // A turn instruction is only ever as good as the heading it was
      // measured from. Saying "turn right 47 degrees" off a compass that is
      // pulled off true is worse than saying nothing, because it sounds
      // exact -- so the doubt is stated in the same sentence, not left to a
      // warning elsewhere on screen that the eye is not on.
      trackbar.dataset.doubt = String(headingDoubt);
      setText(
        trackState,
        headingDoubt
          ? `Compass unreliable here, so this bearing may be well off: ${instruction(guidance, position.altitude).toLowerCase()}`
          : instruction(guidance, position.altitude),
      );
      setText(trackAlt, `${position.altitude.toFixed(1)}°`);
      setText(trackAz, `${position.azimuth.toFixed(1)}°`);

      const status = headingDoubt
        ? `${coarseStatus(guidance, position.altitude)}, compass unreliable`
        : coarseStatus(guidance, position.altitude);
      if (status !== lastStatus) {
        lastStatus = status;
        trackStatus.textContent = `${tracked.label}: ${status}`;
      }

      // The arrow is for finding something you cannot see. Once it is on
      // screen the renderer's own marker is sitting on it, and a second
      // pointer to the same place is noise.
      tracker.dataset.open = String(!guidance.onScreen);
      if (!guidance.onScreen) {
        trackArrow.style.left = `${guidance.arrow.x.toFixed(1)}px`;
        trackArrow.style.top = `${guidance.arrow.y.toFixed(1)}px`;
        trackArrow.dataset.behind = String(guidance.behind);
        trackArrowGlyph.style.transform = `rotate(${guidance.bearing.toFixed(1)}deg)`;
        setText(trackArrowGap, `${guidance.separation.toFixed(0)}°`);
      }

      // Recomputed on the minute rather than on the frame: these are Date
      // arithmetic, and none of it moves fast enough to be worth 60 Hz.
      const key = `${tracked.index}|${Math.floor(frame.when.getTime() / 60000)}`;
      if (key !== eventsKey) {
        eventsKey = key;
        refreshTrackEvents(trackEventCap, trackEvent, frame, facts, position.altitude);
        refreshCardNote(cardNote, frame, facts, position.altitude);
      }
    },

    openCard(detail) {
      pick('card-title').textContent = detail.title;
      pick('card-sub').textContent = detail.subtitle;
      pick('card-chips').innerHTML = detail.chips
        .map((chip) => `<span class="chip">${chip}</span>`)
        .join('');
      pick('card-stats').innerHTML = detail.stats
        .map(([label, value]) => `<div class="stat"><span class="cap">${label}</span><b>${value}</b></div>`)
        .join('');
      pick('card-footer').textContent = detail.footer;
      card.dataset.open = 'true';
      closeSheets();
    },

    closeCard() {
      card.dataset.open = 'false';
      // Tracking and selection are one state: every path that closes the card
      // is a path that deselected the object, so the guidance goes with it.
      shell.track(null);
    },

    openSettings() {
      closeSheets();
      card.dataset.open = 'false';
      sheetSettings.dataset.open = 'true';
    },

    openSearch(onQuery, onPick) {
      closeSheets();
      card.dataset.open = 'false';
      sheetSearch.dataset.open = 'true';

      const list = pick('search-list');
      const input = pick<HTMLInputElement>('search-input');

      const run = (): void => {
        const query = input.value;
        if (query.trim().length === 0) {
          list.innerHTML =
            '<p class="empty">Type a name.<br>Sirius, Jupiter, Orion&hellip;</p>';
          return;
        }
        const results = onQuery(query);
        if (results.length === 0) {
          list.innerHTML = `<p class="empty">Nothing matches &ldquo;${escapeHtml(query)}&rdquo;.</p>`;
          return;
        }
        renderList(list, results, onPick);
      };

      // Rebound on every open, so the handler closes over the current sky.
      input.oninput = run;
      run();
      // Deliberately not focused: on a phone that throws the keyboard over the
      // results before the user has decided they want to type.
    },

    openCalibrate(targets, onSelect, currentOffset) {
      closeSheets();
      card.dataset.open = 'false';
      sheetCalibrate.dataset.open = 'true';

      const list = pick('cal-list');
      if (targets.length === 0) {
        list.innerHTML =
          '<p class="empty">Nothing bright enough is well placed right now.<br>Something between 12&deg; and 78&deg; up works best.</p>';
      } else {
        renderList(list, targets, onSelect);
      }

      pick('cal-status').textContent =
        currentOffset === 0
          ? 'Choose a target.'
          : `Correction is ${currentOffset > 0 ? '+' : ''}${currentOffset.toFixed(1)}°. Choose a target to redo it.`;
      pick<HTMLButtonElement>('cal-confirm').disabled = true;
    },

    setCalibrationStatus(text) {
      pick('cal-status').textContent = text;
    },

    openTonight(entries, caption, onPick) {
      card.dataset.open = 'false';
      sheetSettings.dataset.open = 'false';

      pick('tonight-sub').textContent = caption;
      const list = pick('tonight-list');

      if (entries.length === 0) {
        list.innerHTML =
          '<p class="empty">Nothing above the horizon.<br>Wind the sky forward and see what rises.</p>';
      } else {
        renderList(list, entries, onPick);
      }

      sheetTonight.dataset.open = 'true';
    },

    closeSheets,
  };

  return shell;
}

/* ------------------------------------------------------------------ *
 * Tracking readouts
 * ------------------------------------------------------------------ */

interface TrackedFacts {
  ra: number;
  dec: number;
  magnitude: number;
  kind: ObjectKind;
  /** The horizon this object counts as risen at -- see RISE_SET_ALTITUDE. */
  standardAltitude: number;
}

/**
 * The tracked object's catalogue side, dug out of the frame by the same index
 * encoding the renderer hit-tests with.
 *
 * Deliberately not routed through describe(): that builds a card's worth of
 * strings, and this runs while the user is turning on the spot.
 */
function trackedFacts(index: number, frame: SkyFrame): TrackedFacts | null {
  if (index < 0) {
    const object = frame.objects[-1 - index];
    if (!object) return null;
    return {
      ra: object.ra,
      dec: object.dec,
      magnitude: object.magnitude,
      kind: object.kind,
      standardAltitude:
        object.kind === 'moon'
          ? RISE_SET_ALTITUDE.moon
          : object.kind === 'sun'
            ? RISE_SET_ALTITUDE.sun
            : RISE_SET_ALTITUDE.star,
    };
  }

  if (index >= frame.starCount) return null;
  return {
    ra: frame.catalog.ra[index] as number,
    dec: frame.catalog.dec[index] as number,
    magnitude: frame.catalog.mag[index] as number,
    kind: 'star',
    standardAltitude: RISE_SET_ALTITUDE.star,
  };
}

/**
 * What to do with the phone, in one sentence.
 *
 * Turn and climb rather than a bare separation: "47 degrees away" does not
 * tell a cold hand which way to move, and the arrow alone does not survive
 * being glanced at. Anything under a degree is dropped -- no phone compass is
 * good to a degree, and pretending otherwise sends people hunting a target
 * that is already in the reticle.
 */
function instruction(guidance: Guidance, altitude: number): string {
  if (guidance.locked) {
    return altitude < 0
      ? 'Aimed at it, but it is below the horizon.'
      : 'Locked on. Hold still.';
  }

  const moves: string[] = [];
  if (Math.abs(guidance.turn) >= 1) {
    moves.push(`turn ${guidance.turn > 0 ? 'right' : 'left'} ${Math.abs(guidance.turn).toFixed(0)}°`);
  }
  if (Math.abs(guidance.climb) >= 1) {
    moves.push(`look ${guidance.climb > 0 ? 'up' : 'down'} ${Math.abs(guidance.climb).toFixed(0)}°`);
  }
  if (moves.length === 0) return 'Almost on it.';

  const sentence = `${moves[0]?.charAt(0).toUpperCase()}${moves[0]?.slice(1)}${moves[1] ? `, ${moves[1]}` : ''}.`;
  // Behind you is the case the whole guidance exists for: at that point the
  // object has no projection at all, and a lone arrow reads as "off to the
  // right" when the answer is "the other way entirely".
  return guidance.behind ? `Behind you -- ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;
}

/** The coarse state, for the live region. Changes rarely, unlike the degrees. */
function coarseStatus(guidance: Guidance, altitude: number): string {
  if (guidance.locked) return altitude < 0 ? 'aimed at it, below the horizon' : 'locked on';
  if (guidance.behind) return 'behind you';
  if (guidance.onScreen) return 'in view';
  return 'off screen';
}

/**
 * The third figure in the track bar: when it sets, or when it rises if it has
 * not yet. Never a countdown to an event that does not happen -- a circumpolar
 * star gets "never", not a number quietly measured against tomorrow.
 */
function refreshTrackEvents(
  capElement: HTMLElement,
  valueElement: HTMLElement,
  frame: SkyFrame,
  facts: TrackedFacts,
  altitude: number,
): void {
  const rising = altitude <= 0;
  const at = nextEvent(
    rising ? 'rise' : 'set',
    facts.ra,
    facts.dec,
    frame.observer,
    frame.when,
    facts.standardAltitude,
  );

  setText(capElement, rising ? 'Rises in' : 'Sets in');
  setText(
    valueElement,
    at ? formatDuration(at.getTime() - frame.when.getTime()) : rising ? 'never here' : 'never sets',
  );
}

/**
 * The card's live line: when the object is highest, and whether the sky is
 * drowning it out as you read this.
 *
 * The static stats above it are true for the moment the card opened; these two
 * are the ones worth keeping current, and the second is the one the honesty
 * rule in this app hangs on -- a card that lists a magnitude without saying
 * the Moon has washed it out is promising something the sky is not giving.
 */
function refreshCardNote(
  note: HTMLElement,
  frame: SkyFrame,
  facts: TrackedFacts,
  altitude: number,
): void {
  const sentences: string[] = [];

  const transit = nextEvent(
    'transit',
    facts.ra,
    facts.dec,
    frame.observer,
    frame.when,
    facts.standardAltitude,
  );
  if (transit) {
    sentences.push(
      `Highest at ${transit.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}.`,
    );
  }

  if (altitude <= 0) {
    sentences.push('Below the horizon right now, so there is nothing to see there yet.');
  } else if (facts.kind !== 'moon' && facts.magnitude > frame.limitingMagnitude) {
    sentences.push(`Too faint to see through the ${washoutCause(frame.sunAltitude)} right now.`);
  }

  note.textContent = sentences.join(' ');
  note.hidden = sentences.length === 0;
}

/** Writing the same string back costs a layout pass at 60 Hz. */
function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** One list of objects. Shared by the tonight, search and calibration sheets. */
function renderList(
  list: HTMLElement,
  entries: TonightEntry[],
  onPick: (entry: TonightEntry) => void,
): void {
  list.innerHTML = entries
    .map(
      (entry, i) => `
    <button class="item" type="button" data-i="${i}">
      <span class="item-name">
        <b>${escapeHtml(entry.label)}</b>
        <span>${entry.detail}</span>
      </span>
      <span class="item-num">
        <b>${entry.magnitude > 0 ? '+' : ''}${entry.magnitude.toFixed(1)}</b>
        <span>alt ${entry.altitude.toFixed(0)}°</span>
      </span>
      <span class="arrow"><span class="arrow-glyph" style="transform:rotate(${entry.azimuth.toFixed(1)}deg)">${icons.arrow}</span></span>
    </button>`,
    )
    .join('');

  list.querySelectorAll<HTMLButtonElement>('.item').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = entries[Number(button.dataset.i)];
      if (entry) onPick(entry);
    });
  });
}

/** `<input type="datetime-local">` wants local wall-clock time, not an instant. */
function datetimeLocalValue(when: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}

/** Catalogue names are trusted; a search query is not. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;';
    if (character === '<') return '&lt;';
    if (character === '>') return '&gt;';
    if (character === '"') return '&quot;';
    return '&#39;';
  });
}

/**
 * The compass strip: a ruler of bearings with the current heading under a
 * caret. 120 degrees across, so at least two cardinal points are always in
 * view and the reading has context rather than being a bare number.
 */
function drawCompass(target: SVGSVGElement, heading: number, mode: string): void {
  const span = 120;
  const width = 366;
  const perDegree = width / span;
  const start = heading - span / 2;

  const parts: string[] = [];

  for (let tick = Math.ceil(start / 5) * 5; tick <= start + span; tick += 5) {
    const x = (tick - start) * perDegree;
    if (x < 7 || x > width - 7) continue;

    const bearing = normalize360(tick);
    const major = Math.abs(bearing % 15) < 0.001 || Math.abs((bearing % 15) - 15) < 0.001;
    const cardinal = CARDINAL_LABELS[Math.round(bearing)];

    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${major ? 8 : 13}" x2="${x.toFixed(1)}" y2="20" stroke="rgba(238,242,248,${major ? 0.55 : 0.24})" stroke-width="1"/>`,
    );

    if (cardinal) {
      parts.push(
        `<text x="${x.toFixed(1)}" y="35" text-anchor="middle" font-family="'Space Grotesk',sans-serif" font-size="11.5" font-weight="600" letter-spacing="1" fill="rgba(238,242,248,0.88)">${cardinal}</text>`,
      );
    } else if (major) {
      parts.push(
        `<text x="${x.toFixed(1)}" y="34" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="9.5" fill="rgba(238,242,248,0.40)">${Math.round(bearing)}</text>`,
      );
    }
  }

  const centre = width / 2;
  parts.push(
    `<path d="M${centre},3 L${centre + 5},11 L${centre - 5},11 Z" fill="var(--accent)"/>`,
    `<line x1="${centre}" y1="11" x2="${centre}" y2="23" stroke="var(--accent)" stroke-width="1.25"/>`,
    `<text x="${centre}" y="51" text-anchor="middle" font-family="'IBM Plex Mono',monospace" font-size="12" font-weight="500" fill="var(--accent)">${heading.toFixed(1)}°</text>`,
  );

  if (mode === 'manual') {
    parts.push(
      `<text x="${width - 10}" y="51" text-anchor="end" font-family="'Space Grotesk',sans-serif" font-size="9.5" font-weight="600" letter-spacing="1.4" fill="rgba(238,242,248,0.32)">DRAG</text>`,
    );
  }

  target.innerHTML = parts.join('');
}
