/**
 * StarGaze web client.
 *
 * Two control modes, and the fallback is a first-class one:
 *
 *   sensors -- the phone knows where it is pointed
 *   manual  -- drag to look, pinch to zoom
 *
 * Manual mode is how this gets developed (desktops have no magnetometer) and
 * how it stays usable when a browser refuses motion permission, which Safari
 * does routinely. It is also how Stellarium's own web version works.
 */

import './styles.css';

import {
  basisFromDeviceOrientation,
  boundsFromYears,
  clampOffset,
  HeadingFilter,
  isCalibrationStale,
  magneticFieldIntensity,
  MagneticFieldMonitor,
  normalize360,
  skyConfidence,
  type CameraBasis,
  type ClockBounds,
  type SkyConfidence,
  type Viewport,
} from '@stargaze/core';

import { loadSkyData, type SkyData } from './data.js';
import {
  DEFAULT_POSITION,
  MagnetometerSource,
  motionNeedsGesture,
  OrientationSource,
  primaryPointerIsCoarse,
  requestCamera,
  requestPosition,
  isSecureContextForSensors,
  screenAngle,
  type OrientationSample,
  type PermissionState,
  type Position,
} from './sensors.js';
import { startRotationVector } from './native.js';
import { SkyBanner, SkySampler } from './skycheck.js';
import { SkyRenderer, type RenderOptions } from './render.js';
import {
  calibrate,
  calibrationTargets,
  combineCalibrations,
  describe,
  search,
  SkyModel,
  skyCaption,
  tonight,
  type CalibrationResult,
  type SkyFrame,
  type TonightEntry,
} from './sky.js';
import { buildShell, type Shell } from './ui.js';

/* ------------------------------------------------------------------ *
 * Settings, remembered between visits
 * ------------------------------------------------------------------ */

interface Settings {
  magnitudeLimit: number;
  fov: number;
  showConstellations: boolean;
  showLabels: boolean;
  showHorizon: boolean;
  northOffset: number;
  /** Where and when northOffset was last measured, so it can be judged stale
   *  -- see isCalibrationStale. Null until the first calibration. */
  calibratedAt: { atMs: number; lat: number; lon: number } | null;
  /** Atmospheric refraction lifts everything near the horizon by up to half a
   *  degree -- on by default, since that is what is actually visible. Off
   *  gives the true (airless) altitude. */
  refraction: boolean;
}

const DEFAULTS: Settings = {
  magnitudeLimit: 4.5,
  fov: 66,
  showConstellations: true,
  showLabels: true,
  showHorizon: true,
  northOffset: 0,
  calibratedAt: null,
  refraction: true,
};

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem('stargaze.settings');
    return stored ? { ...DEFAULTS, ...(JSON.parse(stored) as Partial<Settings>) } : { ...DEFAULTS };
  } catch {
    // Private browsing, or storage disabled. Defaults are fine.
    return { ...DEFAULTS };
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem('stargaze.settings', JSON.stringify(settings));
  } catch {
    /* not worth telling the user about */
  }
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */

type Mode = 'sensors' | 'manual';

class StarGaze {
  private settings = loadSettings();
  private data!: SkyData;
  private model!: SkyModel;
  private renderer!: SkyRenderer;
  private shell!: Shell;

  private frame: SkyFrame | null = null;
  private viewport: Viewport = { width: 0, height: 0, horizontalFov: 66 };

  private mode: Mode = 'manual';
  private observer: Position = DEFAULT_POSITION;
  /** null means nothing is selected. See RenderOptions.selected. */
  private selected: number | null = null;

  /** Manual-mode look direction. */
  private lookAltitude = 25;
  private lookAzimuth = 180;

  private readonly orientation = new OrientationSource();
  private readonly heading = new HeadingFilter(0.18);
  private latest: OrientationSample | null = null;

  /** Set once the native rotation-vector sensor (RotationVectorPlugin.java)
   *  starts reporting -- Android only, and only where the hardware has that
   *  sensor. Preferred over DeviceOrientationEvent when it's running. */
  private usingNativeRotationVector = false;
  private latestNative: { azimuth: number; pitch: number; roll: number } | null = null;

  private readonly magnetometer = new MagnetometerSource();
  private readonly fieldMonitor = new MagneticFieldMonitor();
  private liveFieldMicrotesla: number | null = null;
  /** True when the live field reading disagrees with the IGRF model by more
   *  than ordinary sensor variation explains -- a nearby magnet or ferrous
   *  object, not a compass calibration error. Chrome/Android only; stays
   *  false everywhere else, since there is nothing to compare. */
  private magneticInterference = false;

  /* --- Is there actually sky in front of the lens? ---------------- *
   * The geometry cannot tell a ceiling from a sky; the outward-facing
   * sensors half can. skyconfidence.ts in core weighs them, skycheck.ts
   * produces the camera half and shows the answer. */

  private readonly skySampler = new SkySampler();
  private skyBanner!: SkyBanner;
  private sky: SkyConfidence = { confidence: 1, warn: false, reason: null };
  /** Latest MagneticQuality.confidence, 1 where nothing is measuring. */
  private magneticConfidence = 1;
  /** Set when the user has told us this really is the sky. Cleared again the
   *  moment the evidence agrees with them, so the check still works the next
   *  time they walk indoors. */
  private skyOverride = false;
  /* --------------------------------------------------------------- */

  private permissions: Record<'camera' | 'location' | 'motion', PermissionState> = {
    camera: 'unknown',
    location: 'unknown',
    motion: 'unknown',
  };

  private lastSkyUpdate = 0;
  /** How far the shown sky is from the present. Deliberately not part of
   *  Settings: this one resets on every launch -- see setTimeOffset. */
  private timeOffsetMs = 0;
  /** True when the last scrub ran into the end of the ephemeris. */
  private atClockLimit = false;

  /** The object being sighted during compass calibration, if any. */
  private calibrationTarget: TonightEntry | null = null;
  /** Sightings collected in the current calibration session. */
  private calibrationSightings: CalibrationResult[] = [];
  /** The correction in effect when the session started -- every sighting's
   *  raw reading is measured against this, not against a value that changes
   *  mid-session, or sightings would stop being comparable to each other. */
  private calibrationBaseline = 0;

  private static readonly MAX_CALIBRATION_SIGHTINGS = 3;

  async start(root: HTMLElement): Promise<void> {
    this.shell = buildShell(root);
    this.renderer = new SkyRenderer(this.shell.canvas);
    this.skyBanner = new SkyBanner(root);

    try {
      this.data = await loadSkyData();
    } catch (error) {
      this.shell.fatal(
        'Could not load the star catalogue.',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    this.model = new SkyModel(this.data);

    this.wireSettings();
    this.wireCanvas();
    this.wireNav();
    this.wireKeyboard();

    window.addEventListener('resize', () => this.onResize());
    screen.orientation?.addEventListener?.('change', () => this.onResize());

    this.onResize();
    this.updateSky(true);
    requestAnimationFrame(() => this.tick());

    // The sky is the first thing anyone sees. A full-screen consent wall in
    // front of an app nobody has seen yet is both hostile and unnecessary:
    // drag mode works with no permissions at all, so there is nothing to gate.
    // Permissions are asked for in the background, the way ordinary apps do.
    this.enterSky();
    this.warnIfInsecureContext();

    // Ask for everything that can be asked for silently. Where the browser
    // demands a gesture for orientation, that one request is held back.
    await this.requestEverything(!motionNeedsGesture());

    if (!this.usingNativeRotationVector && motionNeedsGesture()) {
      // Only reached when there is no native sensor and the browser insists
      // on a gesture -- so ask on the first touch of the sky rather than
      // behind a wall, and only on devices that genuinely need it.
      const askOnFirstTouch = (): void => {
        this.shell.canvas.removeEventListener('pointerdown', askOnFirstTouch);
        void this.requestEverything(true);
      };
      this.shell.canvas.addEventListener('pointerdown', askOnFirstTouch);
    }
  }

  /* ---------------------------------------------------------------- *
   * Permissions
   * ---------------------------------------------------------------- */

  /**
   * Sensors need a secure context and fail silently without one, which is the
   * single most confusing way this can break. Worth saying, but as a message
   * over the sky rather than a screen standing in front of it.
   */
  private warnIfInsecureContext(): void {
    if (isSecureContextForSensors()) return;
    this.shell.toast(
      'This page is not on a secure origin, so the camera, location and motion sensors are all blocked. Use https, or localhost.',
      7000,
    );
  }

  /**
   * `includeMotion` is false only while waiting on a gesture the browser
   * demands for orientation. Location and camera never need one, so they are
   * asked for straight away rather than held hostage to it.
   */
  private async requestEverything(includeWebMotion = true): Promise<void> {
    // The native sensor first, because it needs no permission of any kind.
    // Asking the browser for orientation before trying this was prompting on
    // every launch for something Android was already willing to give for
    // free -- and that particular grant does not persist, so the prompt came
    // back forever.
    this.usingNativeRotationVector = await startRotationVector((reading) => {
      this.latestNative = reading;
    });

    if (this.usingNativeRotationVector) {
      this.permissions.motion = 'granted';
    } else if (includeWebMotion) {
      // No native sensor, so fall back to the browser's -- which is the only
      // path that can raise a prompt, and now only runs when it is the only
      // way to get a heading at all.
      const motion = await this.orientation.start((sample) => {
        this.latest = sample;
        if (!sample.absolute) this.permissions.motion = 'granted';
      });
      this.permissions.motion = motion;
    }

    // No permission prompt of its own, and every failure mode is silent --
    // safe to just try, regardless of platform.
    this.magnetometer.start((microtesla) => {
      this.liveFieldMicrotesla = microtesla;
    });

    const position = await requestPosition();
    if (position) {
      this.observer = position;
      this.permissions.location = 'granted';
    } else {
      this.permissions.location = 'denied';
    }

    // A device whose primary pointer is a mouse or trackpad is a laptop or
    // desktop -- its camera, if it has one, faces the user, not the sky.
    // Asking for it would put the user's own face behind the overlay.
    const camera = primaryPointerIsCoarse()
      ? await requestCamera()
      : { stream: null, state: 'unsupported' as const, fov: null };
    this.permissions.camera = camera.state;

    if (camera.stream) {
      this.shell.video.srcObject = camera.stream;
      await this.shell.video.play().catch(() => undefined);
      this.shell.video.style.display = 'block';
      if (camera.fov) {
        this.settings.fov = camera.fov;
        saveSettings(this.settings);
      }
    }

    this.mode =
      this.permissions.motion === 'granted' || this.usingNativeRotationVector
        ? 'sensors'
        : 'manual';
    this.reportSensorState();
  }

  private enterSky(): void {
    this.updateSky(true);
    this.syncModeButton();
  }

  /**
   * Say what the sensors actually gave us, once asking has finished. Kept
   * apart from entering the sky because at that point nothing has been
   * granted or refused yet, so there is nothing truthful to report.
   */
  private reportSensorState(): void {
    this.syncModeButton();

    if (this.mode === 'manual') {
      this.shell.toast(
        this.permissions.motion === 'granted'
          ? 'Drag to look around.'
          : 'No compass available — drag to look around, pinch to zoom.',
        5200,
      );
    } else if (!this.usingNativeRotationVector && !this.orientation.absolute) {
      // The native rotation-vector sensor is hardware-fused and always
      // reports a compass-referenced heading -- this warning is about
      // DeviceOrientationEvent's own gap, which does not apply here.
      this.shell.toast(
        'Your browser is reporting orientation without a compass reference, so north is a guess. ' +
          'Use the true-north offset in settings to correct it.',
        7000,
      );
    }

    if (this.permissions.location === 'denied') {
      this.shell.toast('No location — showing the sky from Greenwich. Set yours in settings.', 6000);
    }

    this.warnIfCalibrationStale();
  }

  /**
   * A compass correction measured next to a car, or weeks ago in another
   * city, is not trustworthy here and now. This does not touch the offset
   * itself -- it is still better than nothing -- it just says so, once, when
   * it might matter: entering the sky and after the observer location moves.
   */
  private warnIfCalibrationStale(): void {
    if (this.settings.northOffset === 0 || !this.settings.calibratedAt) return;

    const stale = isCalibrationStale(this.settings.calibratedAt, {
      atMs: Date.now(),
      lat: this.observer.latitude,
      lon: this.observer.longitude,
    });
    if (stale) {
      this.shell.toast(
        'Your compass correction was measured somewhere else, or a while ago — it may no longer be right. Settings → Calibrate to redo it.',
        6000,
      );
    }
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  private wireCanvas(): void {
    const canvas = this.shell.canvas;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 1) {
        dragging = true;
        moved = 0;
        lastX = event.clientX;
        lastY = event.clientY;
      } else if (pointers.size === 2) {
        dragging = false;
        pinchDistance = this.spread(pointers);
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      if (pointers.size === 2) {
        const spread = this.spread(pointers);
        if (pinchDistance > 0 && spread > 0) {
          this.setFov(this.settings.fov * (pinchDistance / spread));
          pinchDistance = spread;
        }
        return;
      }

      if (!dragging || this.mode !== 'manual') return;

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      moved += Math.abs(dx) + Math.abs(dy);

      // Drag by the same number of degrees the pixels represent, so the sky
      // tracks the finger instead of sliding at some arbitrary rate.
      const degreesPerPixel = this.settings.fov / Math.max(1, this.viewport.width);
      this.lookAzimuth = normalize360(this.lookAzimuth - dx * degreesPerPixel);
      this.lookAltitude = Math.max(-90, Math.min(90, this.lookAltitude + dy * degreesPerPixel));
    });

    const release = (event: PointerEvent): void => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinchDistance = 0;
      if (pointers.size === 0 && dragging) {
        dragging = false;
        // A tap, not a drag.
        if (moved < 8) this.onTap(event.clientX, event.clientY);
      }
    };

    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.setFov(this.settings.fov * (event.deltaY > 0 ? 1.08 : 1 / 1.08));
      },
      { passive: false },
    );
  }

  private spread(pointers: Map<number, { x: number; y: number }>): number {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private setFov(value: number): void {
    this.settings.fov = Math.max(12, Math.min(110, value));
    this.viewport.horizontalFov = this.settings.fov;
    this.shell.fovInput.value = String(Math.round(this.settings.fov));
    this.shell.fovValue.textContent = `${Math.round(this.settings.fov)}°`;
    saveSettings(this.settings);
  }

  private onTap(clientX: number, clientY: number): void {
    const rect = this.shell.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const hit = this.renderer.pick(x, y);
    if (hit === null) {
      this.selected = null;
      this.shell.closeCard();
      return;
    }

    this.selected = hit;
    this.showCard();
  }

  private showCard(): void {
    if (!this.frame || this.selected === null) return;
    const detail = describe(this.selected, this.frame, this.data);
    if (detail) this.shell.openCard(detail);
  }

  /* ---------------------------------------------------------------- *
   * Chrome wiring
   * ---------------------------------------------------------------- */

  private wireNav(): void {
    this.shell.tonightButton.addEventListener('click', () => {
      if (!this.frame) return;
      const entries = tonight(this.frame, this.data);
      this.shell.openTonight(entries, skyCaption(this.frame, entries), (entry) =>
        this.goTo(entry),
      );
    });

    this.shell.searchButton.addEventListener('click', () => {
      this.shell.openSearch(
        (query) => (this.frame ? search(query, this.frame, this.data) : []),
        (entry) => this.goTo(entry),
      );
    });

    this.shell.settingsButton.addEventListener('click', () => this.shell.openSettings());
    this.wireCalibration();
    this.shell.modeButton.addEventListener('click', () => void this.toggleMode());
    this.shell.cardClose.addEventListener('click', () => {
      this.selected = null;
      this.shell.closeCard();
    });
  }

  /**
   * Keyboard controls, for a mouse-and-keyboard device where dragging the
   * canvas with a pointer still works but is not the natural way to look
   * around. Arrows/zoom only act in drag mode -- there is no phone to move
   * out from under a sensor-mode reading, so redefining what the keys do
   * there would be surprising rather than useful.
   */
  private wireKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (event.key === 'Escape') {
        if (typing) target.blur();
        this.selected = null;
        this.shell.closeCard();
        this.shell.closeSheets();
        return;
      }

      if (typing) return; // never hijack keys while editing a field

      const STEP = 3; // degrees per press -- a comfortable single tap
      switch (event.key) {
        case 'ArrowLeft':
          if (this.mode === 'manual') this.lookAzimuth = normalize360(this.lookAzimuth - STEP);
          break;
        case 'ArrowRight':
          if (this.mode === 'manual') this.lookAzimuth = normalize360(this.lookAzimuth + STEP);
          break;
        case 'ArrowUp':
          if (this.mode === 'manual') this.lookAltitude = Math.min(90, this.lookAltitude + STEP);
          break;
        case 'ArrowDown':
          if (this.mode === 'manual') this.lookAltitude = Math.max(-90, this.lookAltitude - STEP);
          break;
        case '+':
        case '=':
          this.setFov(this.settings.fov / 1.08);
          break;
        case '-':
        case '_':
          this.setFov(this.settings.fov * 1.08);
          break;
        case '/':
          event.preventDefault();
          this.shell.openSearch(
            (query) => (this.frame ? search(query, this.frame, this.data) : []),
            (entry) => this.goTo(entry),
          );
          window.setTimeout(() => this.shell.searchInput.focus(), 0);
          return;
        default:
          return;
      }
      event.preventDefault();
    });
  }

  /**
   * Select an object and aim at it.
   *
   * In drag mode the view turns to face it, which is the whole answer to "where
   * is Jupiter". With sensors that would fight the phone, so instead the object
   * is selected and the user swings the phone until the marker appears.
   */
  private goTo(entry: TonightEntry): void {
    this.selected = entry.index;
    this.shell.closeSheets();

    if (this.mode === 'manual') {
      this.lookAltitude = entry.altitude;
      this.lookAzimuth = entry.azimuth;
    } else {
      const turn = ((entry.azimuth - this.currentBasis().azimuth + 540) % 360) - 180;
      const direction = turn > 0 ? 'right' : 'left';
      this.shell.toast(
        entry.altitude > 0
          ? `${entry.label} is ${Math.abs(turn).toFixed(0)}° to your ${direction}, ${entry.altitude.toFixed(0)}° up.`
          : `${entry.label} is below the horizon right now.`,
        4200,
      );
    }

    this.showCard();
  }

  private wireCalibration(): void {
    const shell = this.shell;

    shell.calibrateButton.addEventListener('click', () => {
      if (!this.frame) return;
      this.calibrationTarget = null;
      this.calibrationSightings = [];
      this.calibrationBaseline = this.settings.northOffset;
      shell.openCalibrate(
        calibrationTargets(this.frame, this.data),
        (entry) => {
          if (this.calibrationSightings.length >= StarGaze.MAX_CALIBRATION_SIGHTINGS) {
            shell.setCalibrationStatus('Three sightings is plenty — close when done, or clear to start over.');
            return;
          }
          this.calibrationTarget = entry;
          shell.calibrateConfirm.disabled = false;
          shell.setCalibrationStatus(
            `Put the crosshair on ${entry.label} — ${entry.altitude.toFixed(0)}° up, bearing ${entry.azimuth.toFixed(0)}° — hold still, then confirm.`,
          );
        },
        this.settings.northOffset,
      );

      if (
        this.settings.northOffset !== 0 &&
        this.settings.calibratedAt &&
        isCalibrationStale(this.settings.calibratedAt, {
          atMs: Date.now(),
          lat: this.observer.latitude,
          lon: this.observer.longitude,
        })
      ) {
        shell.setCalibrationStatus(
          'Your last correction was measured somewhere else, or a while ago. Worth redoing.',
        );
      }
    });

    shell.calibrateConfirm.addEventListener('click', () => {
      const target = this.calibrationTarget;
      if (!target) return;

      if (this.mode !== 'sensors') {
        // In drag mode the heading is whatever the user dragged it to, so a
        // sighting would measure nothing but their own aim.
        shell.setCalibrationStatus(
          'Calibration needs the phone’s own compass. Switch to sensor mode first.',
        );
        return;
      }

      // Measure against the raw sensor heading, with the correction that was
      // in effect when this session started removed -- every sighting in the
      // session has to be relative to the same baseline, or a second sighting
      // would be measuring the first one instead of the compass.
      const raw = this.currentBasis().azimuth - this.calibrationBaseline;
      const result = calibrate(raw, target);
      this.calibrationSightings.push(result);
      this.calibrationTarget = null;
      shell.calibrateConfirm.disabled = true;

      const combined = combineCalibrations(this.calibrationSightings.map((s) => s.offset));
      this.settings.northOffset = Number(combined.offset.toFixed(1));
      this.settings.calibratedAt = {
        atMs: Date.now(),
        lat: this.observer.latitude,
        lon: this.observer.longitude,
      };
      saveSettings(this.settings);
      shell.offsetValue.textContent = `${this.settings.northOffset > 0 ? '+' : ''}${this.settings.northOffset.toFixed(1)}°`;

      const n = this.calibrationSightings.length;
      const discardNote = combined.discarded > 0 ? `, ${combined.discarded} discarded as off` : '';
      const next =
        n < StarGaze.MAX_CALIBRATION_SIGHTINGS
          ? ' Pick another target for a steadier correction, or close when done.'
          : ' That is plenty — close when done.';
      shell.setCalibrationStatus(
        `${n} sighting${n === 1 ? '' : 's'}${discardNote}. Corrected by ` +
          `${combined.offset > 0 ? '+' : ''}${combined.offset.toFixed(1)}°.${next}`,
      );
      shell.toast(
        `Compass corrected by ${combined.offset > 0 ? '+' : ''}${combined.offset.toFixed(1)}°.`,
        3600,
      );
    });

    shell.calibrateReset.addEventListener('click', () => {
      this.settings.northOffset = 0;
      this.settings.calibratedAt = null;
      this.calibrationTarget = null;
      this.calibrationSightings = [];
      this.calibrationBaseline = 0;
      saveSettings(this.settings);
      shell.offsetValue.textContent = '0.0°';
      shell.calibrateConfirm.disabled = true;
      shell.setCalibrationStatus('Correction cleared. Choose a target to redo it.');
    });
  }

  private async toggleMode(): Promise<void> {
    if (this.mode === 'sensors') {
      this.mode = 'manual';
      // Carry the current view across, so the sky does not jump.
      this.lookAltitude = this.currentBasis().altitude;
      this.lookAzimuth = this.currentBasis().azimuth;
      this.shell.toast('Drag to look around.', 2600);
    } else if (this.usingNativeRotationVector) {
      this.mode = 'sensors';
      this.shell.toast('Following the phone.', 2200);
    } else {
      const state = this.orientation.receiving
        ? 'granted'
        : await this.orientation.start((sample) => {
            this.latest = sample;
          });
      if (state !== 'granted') {
        this.shell.toast('This device is not reporting orientation.', 3200);
        return;
      }
      this.mode = 'sensors';
      this.shell.toast('Following the phone.', 2200);
    }
    this.syncModeButton();
  }

  private syncModeButton(): void {
    this.shell.modeButton.setAttribute('aria-pressed', String(this.mode === 'sensors'));
    this.shell.modeButton.querySelector('span')!.textContent =
      this.mode === 'sensors' ? 'Sensors' : 'Drag';
  }

  private wireSettings(): void {
    const s = this.shell;

    s.magInput.value = String(this.settings.magnitudeLimit);
    s.magValue.textContent = this.settings.magnitudeLimit.toFixed(1);
    s.fovInput.value = String(Math.round(this.settings.fov));
    s.fovValue.textContent = `${Math.round(this.settings.fov)}°`;
    s.offsetValue.textContent = `${this.settings.northOffset > 0 ? '+' : ''}${this.settings.northOffset.toFixed(1)}°`;

    s.magInput.addEventListener('input', () => {
      this.settings.magnitudeLimit = Number(s.magInput.value);
      s.magValue.textContent = this.settings.magnitudeLimit.toFixed(1);
      saveSettings(this.settings);
      this.updateSky(true);
    });

    s.fovInput.addEventListener('input', () => this.setFov(Number(s.fovInput.value)));

    for (const [button, key] of [
      [s.linesToggle, 'showConstellations'],
      [s.labelsToggle, 'showLabels'],
      [s.horizonToggle, 'showHorizon'],
    ] as const) {
      button.setAttribute('aria-pressed', String(this.settings[key]));
      button.addEventListener('click', () => {
        this.settings[key] = !this.settings[key];
        button.setAttribute('aria-pressed', String(this.settings[key]));
        saveSettings(this.settings);
      });
    }

    // Unlike the display toggles above, refraction changes the computed
    // altitude itself, so it needs a recompute rather than just a redraw.
    s.refractionToggle.setAttribute('aria-pressed', String(this.settings.refraction));
    s.refractionToggle.addEventListener('click', () => {
      this.settings.refraction = !this.settings.refraction;
      s.refractionToggle.setAttribute('aria-pressed', String(this.settings.refraction));
      saveSettings(this.settings);
      this.updateSky(true);
    });

    for (const [button, delta] of [
      [s.offsetMinus, -0.5],
      [s.offsetPlus, 0.5],
    ] as const) {
      button.addEventListener('click', () => {
        this.settings.northOffset = Math.max(-30, Math.min(30, this.settings.northOffset + delta));
        s.offsetValue.textContent = `${this.settings.northOffset > 0 ? '+' : ''}${this.settings.northOffset.toFixed(1)}°`;
        saveSettings(this.settings);
      });
    }

    s.locationForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const latitude = Number(s.latInput.value);
      const longitude = Number(s.lonInput.value);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
        this.shell.toast('Latitude is -90 to 90, longitude -180 to 180.', 3600);
        return;
      }
      this.observer = { latitude, longitude, elevation: 0, accuracy: null };
      this.permissions.location = 'granted';
      this.updateSky(true);
      this.shell.closeSheets();
      this.shell.toast(`Observing from ${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°.`, 3200);
    });

    s.useGpsButton.addEventListener('click', async () => {
      s.useGpsButton.disabled = true;
      const position = await requestPosition();
      s.useGpsButton.disabled = false;
      if (!position) {
        this.shell.toast('Location unavailable.', 3000);
        return;
      }
      this.observer = position;
      this.permissions.location = 'granted';
      s.latInput.value = position.latitude.toFixed(4);
      s.lonInput.value = position.longitude.toFixed(4);
      this.updateSky(true);
      this.shell.toast('Location updated.', 2400);
    });

    const bounds = this.clockBounds();
    s.wireTime({
      bounds: { earliest: new Date(bounds.earliestMs), latest: new Date(bounds.latestMs) },
      onScrub: (delta) => this.setTimeOffset(this.timeOffsetMs + delta),
      onPick: (when) => this.setTimeOffset(when.getTime() - Date.now()),
      onNow: () => this.setTimeOffset(0),
    });

    this.wirePermissionRecovery();
  }

  /* ---------------------------------------------------------------- *
   * Time travel
   * ---------------------------------------------------------------- */

  /** The years the planetary theory is fit for, straight from planets.json. */
  private clockBounds(): ClockBounds {
    return boundsFromYears(this.data.planets.validFrom, this.data.planets.validTo);
  }

  /**
   * Move the shown moment.
   *
   * Never saved. Someone who scrubbed to next Tuesday and closed the app has
   * to get the real sky back when they open it again -- a remembered offset
   * is a wrong overlay that looks exactly like a right one.
   */
  private setTimeOffset(offsetMs: number): void {
    const clamped = clampOffset(offsetMs, Date.now(), this.clockBounds());
    this.atClockLimit = clamped !== offsetMs;
    this.timeOffsetMs = clamped;
    this.updateSky(true);
  }

  /**
   * Lets a revoked or skipped permission be asked for again from here,
   * without clearing site data or reinstalling. Motion isn't offered a
   * button of its own: the mode toggle in the nav bar already re-attempts it
   * every time it is pressed from drag mode, so a second control here would
   * just be the same recovery path wearing a different label. Location's
   * equivalent is "Use my location" above, already present. Camera is the
   * one permission with no existing way back in, which is what this adds --
   * and only on a device where a camera view makes sense at all.
   */
  private wirePermissionRecovery(): void {
    const s = this.shell;

    if (!primaryPointerIsCoarse()) {
      s.permissionsSection.style.display = 'none';
      return;
    }

    s.cameraPermissionStatus.textContent =
      this.permissions.camera === 'granted' ? 'On' : 'Off';

    s.enableCameraButton.addEventListener('click', async () => {
      s.enableCameraButton.disabled = true;
      const camera = await requestCamera();
      s.enableCameraButton.disabled = false;
      this.permissions.camera = camera.state;
      s.cameraPermissionStatus.textContent = camera.state === 'granted' ? 'On' : 'Off';

      if (!camera.stream) {
        this.shell.toast(
          camera.state === 'denied'
            ? 'Camera permission is denied at the browser or OS level -- it has to be re-enabled there, not just here.'
            : 'Camera unavailable.',
          4200,
        );
        return;
      }

      this.shell.video.srcObject = camera.stream;
      await this.shell.video.play().catch(() => undefined);
      this.shell.video.style.display = 'block';
      if (camera.fov) {
        this.settings.fov = camera.fov;
        saveSettings(this.settings);
      }
      this.shell.toast('Camera enabled.', 2400);
    });
  }

  /* ---------------------------------------------------------------- *
   * Loop
   * ---------------------------------------------------------------- */

  private onResize(): void {
    const viewport = this.renderer.resize();
    this.viewport = { ...viewport, horizontalFov: this.settings.fov };
  }

  private now(): Date {
    return new Date(Date.now() + this.timeOffsetMs);
  }

  private updateSky(force = false): void {
    const now = performance.now();
    if (!force && now - this.lastSkyUpdate < 1000) return;
    this.lastSkyUpdate = now;
    this.frame = this.model.compute(
      this.now(),
      this.observer,
      this.settings.magnitudeLimit,
      this.settings.refraction,
    );
    this.shell.showTime(this.frame.when, this.timeOffsetMs, this.atClockLimit);
    this.updateMagneticInterference();
    this.updateSkyConfidence();
  }

  /* --- Is there actually sky in front of the lens? ---------------- */

  /**
   * Weigh the camera, the location fix and the magnetometer, then say so.
   *
   * Runs from updateSky rather than the frame loop: once a second is plenty
   * for noticing a phone being lowered, and it keeps a canvas readback off
   * the render path entirely.
   *
   * What comes of it is a dimmed overlay and one line of text. Never a hidden
   * sky -- being wrong about a roof has to cost the user a sentence, not the
   * app. Which is also why the override below is on the warning itself,
   * rather than buried in settings where nobody would find it.
   */
  private updateSkyConfidence(): void {
    if (this.permissions.camera === 'granted' && this.shell.video.srcObject) {
      this.skySampler.update(this.shell.video, performance.now());
    } else {
      this.skySampler.clear();
    }

    this.sky = skyConfidence({
      frame: this.skySampler.statistics,
      sunAltitude: this.frame?.sunAltitude ?? -90,
      gpsAccuracyMetres: this.observer.accuracy,
      magneticConfidence: this.magneticConfidence,
    });

    if (!this.sky.warn) this.skyOverride = false;
    const doubt = this.sky.warn && !this.skyOverride;

    // Dimmed in proportion to the doubt, and never past the point of being
    // readable: the objects are still there, still tappable, still named.
    this.shell.canvas.style.opacity = doubt
      ? (0.45 + 0.55 * this.sky.confidence).toFixed(2)
      : '1';

    const lines: string[] = [];
    if (this.magneticInterference) {
      // Loud, because the alternative is telling someone an apartment block
      // is north and letting them believe it.
      lines.push(
        'Compass unreliable: something nearby is pulling the field off true north, ' +
          'so every bearing and the whole sky alignment are wrong until you move away from it.',
      );
    }
    if (doubt) {
      lines.push(
        `This may not be open sky -- ${this.sky.reason}. Nothing is hidden; the overlay is ` +
          'just dimmed while there is doubt.',
      );
    }

    this.skyBanner.show(
      lines.length > 0 ? lines.join(' ') : null,
      doubt
        ? [
            {
              label: 'This is the sky',
              onPress: () => {
                this.skyOverride = true;
                this.shell.canvas.style.opacity = '1';
                this.shell.toast('Taking your word for it.', 2600);
              },
            },
          ]
        : [],
    );
  }

  /**
   * Compare the live magnetometer reading (where available) against the IGRF
   * model's prediction for this location. Real field strength varies with
   * geography by a factor of three across the globe, so the model -- not a
   * fixed constant -- is the only honest baseline to check against.
   */
  private updateMagneticInterference(): void {
    if (this.liveFieldMicrotesla === null) {
      this.magneticInterference = false;
      this.magneticConfidence = 1;
      return;
    }

    const model = magneticFieldIntensity(
      this.data.declination,
      this.observer.latitude,
      this.observer.longitude,
    );
    // An unreliable model reads as no baseline at all, which the monitor
    // answers with full confidence rather than a warning it cannot justify.
    const quality = this.fieldMonitor.push(
      this.liveFieldMicrotesla,
      model.reliable ? model.nanotesla / 1000 : 0,
    );

    this.magneticInterference = quality.interference;
    this.magneticConfidence = quality.confidence;
    // Doubt is worth more than a warning: the heading filter leans on the
    // gyroscope instead of a magnetometer it has reason to distrust.
    this.orientation.magneticTrust = quality.confidence;
  }

  private currentBasis(): CameraBasis {
    const declination =
      (this.frame?.declinationReliable ? this.frame.declination : 0) + this.settings.northOffset;

    if (this.mode === 'sensors' && this.usingNativeRotationVector && this.latestNative) {
      // The platform already produced the orientation angles; all that is
      // left is the convention shift. Android's azimuth runs clockwise from
      // north, alpha runs counter-clockwise, which is the same relationship
      // Safari's webkitCompassHeading has -- see onEvent in sensors.ts.
      // Hardware-fused, so no JS-side smoothing on top of it.
      return basisFromDeviceOrientation({
        alpha: normalize360(360 - this.latestNative.azimuth),
        beta: -this.latestNative.pitch,
        gamma: this.latestNative.roll,
        screenAngle: screenAngle(),
        declination,
      });
    }

    if (this.mode === 'sensors' && this.latest) {
      // An absolute heading has already been through the fusion filter in
      // sensors.ts; smoothing it again here only adds lag. A relative one
      // comes through raw and still needs it.
      const alpha = this.latest.absolute
        ? this.latest.alpha
        : this.heading.push(this.latest.alpha);
      return basisFromDeviceOrientation({
        alpha,
        beta: this.latest.beta,
        gamma: this.latest.gamma,
        screenAngle: this.latest.screenAngle,
        // Safari hands us true north already -- see OrientationSample.trueNorth.
        declination: this.latest.trueNorth
          ? this.settings.northOffset
          : declination,
      });
    }

    // Manual mode: synthesise the same basis from the look direction. beta of
    // 90 is a phone held upright; adding the altitude tips it toward the sky.
    return basisFromDeviceOrientation({
      alpha: -this.lookAzimuth,
      beta: 90 + this.lookAltitude,
      gamma: 0,
      screenAngle: 0,
      declination: 0,
    });
  }

  private tick(): void {
    this.updateSky();

    if (this.frame) {
      const basis = this.currentBasis();
      const options: RenderOptions = {
        showConstellations: this.settings.showConstellations,
        showLabels: this.settings.showLabels,
        showHorizon: this.settings.showHorizon,
        magnitudeLimit: this.settings.magnitudeLimit,
        selected: this.selected,
      };

      this.renderer.draw(this.frame, this.data, basis, this.viewport, options);
      this.shell.updateHud(basis, this.frame, this.mode, this.magneticInterference);
    }

    requestAnimationFrame(() => this.tick());
  }
}

/* ------------------------------------------------------------------ */

const root = document.getElementById('app');
if (root) void new StarGaze().start(root);

// Register the service worker only in a build: in dev it caches the very files
// being edited, which turns every change into a mystery.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
