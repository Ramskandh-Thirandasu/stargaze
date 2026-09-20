/**
 * Sensors, and what to do when they are not there.
 *
 * Three things can be missing independently -- camera, location, orientation --
 * and the app has to stay useful when any of them is. So each is requested on
 * its own and each has a fallback:
 *
 *   no camera      -> plain dark sky behind the overlay
 *   no location    -> the user enters one, or it defaults to Greenwich
 *   no orientation -> drag to look around, which is how a desktop uses it anyway
 *
 * The drag fallback is not a consolation prize. It is the mode this was
 * developed in, and the only way to check the sky against a planetarium on a
 * machine with no magnetometer.
 */

import { HeadingFusion, headingRateFromDeviceRotation } from '@stargaze/core';

import { isNative, nativePosition, requestNativeCamera, requestNativeLocation } from './native.js';

export type PermissionState = 'unknown' | 'granted' | 'denied' | 'unsupported';

export interface OrientationSample {
  alpha: number;
  beta: number;
  gamma: number;
  screenAngle: number;
  /** True when the reading is referenced to compass north rather than an
   *  arbitrary starting direction. Without it the heading is meaningless. */
  absolute: boolean;
  /** True when `alpha` is a gyroscope-fused heading rather than the raw
   *  magnetometer one. Only ever true where the device has a gyroscope and
   *  the heading was absolute to begin with. */
  fused: boolean;
}

/* ------------------------------------------------------------------ *
 * Location
 * ------------------------------------------------------------------ */

export interface Position {
  latitude: number;
  longitude: number;
  elevation: number;
  /** Metres of horizontal uncertainty, or null if unknown. */
  accuracy: number | null;
}

/** Greenwich: an honest default, and the one every almanac is written for. */
export const DEFAULT_POSITION: Position = {
  latitude: 51.4779,
  longitude: 0,
  elevation: 0,
  accuracy: null,
};

export async function requestPosition(): Promise<Position | null> {
  // On Android the runtime permission has to be granted before the API will
  // answer, and the plugin path fails fast where the WebView's own can hang.
  if (isNative()) {
    if ((await requestNativeLocation()) === 'denied') return null;
    const fromPlugin = await nativePosition();
    if (fromPlugin) return fromPlugin;
  }

  if (!('geolocation' in navigator)) return null;

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (result) =>
        resolve({
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
          elevation: result.coords.altitude ?? 0,
          accuracy: result.coords.accuracy ?? null,
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Orientation
 * ------------------------------------------------------------------ */

type OrientationListener = (sample: OrientationSample) => void;

interface GestureGatedDeviceOrientationEvent {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/**
 * Whether motion needs an explicit, gesture-gated prompt on this browser --
 * true wherever `DeviceOrientationEvent.requestPermission` exists. That used
 * to mean iOS Safari specifically; it no longer does -- confirmed present on
 * a current desktop Chrome build too, so treat this as "whichever browser
 * gates it today", not as a stand-in for a particular platform. There is no
 * Permissions API entry for motion anywhere, so feature-detecting this
 * function is the only signal available for "does asking have to happen
 * inside a tap", on any browser that has adopted the gate.
 *
 * The permission it gates also does not reliably persist across sessions --
 * a granted answer today is not a promise of one tomorrow -- so callers
 * should treat true here as "always ask fresh", never as something to
 * remember past this page load.
 */
export function motionNeedsGesture(): boolean {
  const constructor = (
    typeof window === 'undefined' ? undefined : (window.DeviceOrientationEvent as unknown)
  ) as GestureGatedDeviceOrientationEvent | undefined;
  return typeof constructor?.requestPermission === 'function';
}

/**
 * A gap longer than this between two samples is the page having been
 * backgrounded, a dropped burst, or the browser throttling -- not a slow
 * sensor. Integrating a rate of turn across one would spin the sky.
 */
const MAX_SENSOR_GAP_SECONDS = 0.25;

/**
 * A gyroscope that has never reported any rotation at all is not a gyroscope.
 * Some browsers fire `devicemotion` with a permanently zero `rotationRate` on
 * hardware that has none, and a filter told it has a steady gyro stops
 * believing the magnetometer -- which would leave the heading frozen. So wait
 * for one real turn before treating the sensor as present.
 */
const GYRO_WAKE_DEGREES_PER_SECOND = 0.5;

export class OrientationSource {
  private listener: OrientationListener | null = null;
  private handler: ((event: DeviceOrientationEvent) => void) | null = null;
  private motionHandler: ((event: DeviceMotionEvent) => void) | null = null;
  private eventName: 'deviceorientationabsolute' | 'deviceorientation' = 'deviceorientation';

  private readonly fusion = new HeadingFusion();
  /** Latest tilt, which is what turns a device-frame rate of turn into a rate
   *  of change of heading. */
  private tilt: { beta: number; gamma: number } | null = null;
  private lastMotion = 0;
  private lastOrientation = 0;

  /** Set once a reading has actually arrived, not merely been permitted. */
  receiving = false;

  /** False when readings are relative to wherever the phone happened to start. */
  absolute = false;

  /** Set once the gyroscope has reported a genuine turn. */
  gyro = false;

  /**
   * How much to believe the magnetometer, 0 to 1 -- set this from
   * {@link MagneticFieldMonitor} where a raw field reading exists. 1 means no
   * reason to doubt it, which is also the honest answer where nothing is
   * measuring the field at all. Has no effect without a gyroscope, since then
   * the magnetometer is the only source of a heading there is.
   */
  magneticTrust = 1;

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /**
   * Ask for permission and start listening.
   *
   * Wherever motionNeedsGesture() is true, this has to be called from inside a
   * user gesture -- which is why the permission gate is one deliberate button
   * rather than something that runs on load.
   */
  async start(listener: OrientationListener): Promise<PermissionState> {
    if (!OrientationSource.supported) return 'unsupported';

    if (motionNeedsGesture()) {
      const constructor = window.DeviceOrientationEvent as unknown as GestureGatedDeviceOrientationEvent;
      try {
        const outcome = await constructor.requestPermission?.();
        if (outcome !== 'granted') return 'denied';
      } catch {
        // Thrown when not called from a gesture. Treat as a refusal rather than
        // silently carrying on with a heading that will never arrive.
        return 'denied';
      }
    }

    this.listener = listener;
    // `deviceorientationabsolute` is the one referenced to true compass north.
    // Chrome on Android fires it; Safari does not, and reports the same thing
    // through `webkitCompassHeading` on the plain event instead.
    this.eventName =
      'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';

    this.handler = (event) => this.onEvent(event);
    window.addEventListener(this.eventName, this.handler as EventListener, true);

    // Best-effort: every way this can fail leaves the heading exactly as
    // unfused as it was before, which is what shipped for a year.
    await this.startGyroscope();

    // A permission grant is not a reading. If nothing arrives, the caller needs
    // to know so it can fall back to drag rather than showing a frozen sky.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return this.receiving ? 'granted' : 'denied';
  }

  private onEvent(event: DeviceOrientationEvent): void {
    const webkitHeading = (event as unknown as { webkitCompassHeading?: number })
      .webkitCompassHeading;

    let alpha: number | null;
    if (typeof webkitHeading === 'number' && Number.isFinite(webkitHeading)) {
      // Safari reports a compass BEARING (clockwise from north) where alpha is
      // a counter-clockwise rotation. They run in opposite directions.
      alpha = 360 - webkitHeading;
      this.absolute = true;
    } else {
      alpha = event.alpha;
      this.absolute = event.absolute === true || this.eventName === 'deviceorientationabsolute';
    }

    if (alpha === null || event.beta === null || event.gamma === null) return;

    this.tilt = { beta: event.beta, gamma: event.gamma };
    this.receiving = true;

    // A relative heading has no north in it, so there is nothing for the
    // gyroscope to be drifting away from -- pass it straight through.
    const heading = this.absolute
      ? this.fusion.correct(alpha, this.elapsed('orientation'), this.magneticTrust)
      : alpha;

    this.listener?.({
      alpha: heading,
      beta: event.beta,
      gamma: event.gamma,
      screenAngle: screenAngle(),
      absolute: this.absolute,
      fused: this.absolute && this.fusion.usingGyro,
    });
  }

  /**
   * Start feeding the gyroscope in, where there is one.
   *
   * `devicemotion` rather than the Generic Sensor API's `Gyroscope`: it exists
   * on iOS as well as Chrome, needs no permissions-policy grant, and is
   * covered by the motion permission already asked for above -- the second
   * `requestPermission` below resolves without a prompt once the first has
   * been granted, since browsers gate both behind one site setting.
   */
  private async startGyroscope(): Promise<void> {
    if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return;

    const constructor = window.DeviceMotionEvent as unknown as GestureGatedDeviceOrientationEvent;
    if (typeof constructor.requestPermission === 'function') {
      try {
        if ((await constructor.requestPermission()) !== 'granted') return;
      } catch {
        return;
      }
    }

    this.motionHandler = (event) => this.onMotion(event);
    window.addEventListener('devicemotion', this.motionHandler as EventListener);
  }

  private onMotion(event: DeviceMotionEvent): void {
    const rate = event.rotationRate;
    const tilt = this.tilt;
    // No tilt yet means no orientation reading yet, and without one there is no
    // way to know which device axis the heading is turning about.
    if (!rate || !tilt) return;

    const { alpha, beta, gamma } = rate;
    if (alpha === null || beta === null || gamma === null) return;

    if (!this.gyro) {
      if (Math.max(Math.abs(alpha), Math.abs(beta), Math.abs(gamma)) < GYRO_WAKE_DEGREES_PER_SECOND) {
        return;
      }
      this.gyro = true;
    }

    const dt = this.elapsed('motion');
    if (dt <= 0) return;

    this.fusion.predict(headingRateFromDeviceRotation({ alpha, beta, gamma }, tilt.beta, tilt.gamma), dt);
  }

  /** Seconds since the last sample of this kind, 0 for the first one. The
   *  event's own timestamp is not comparable across the two streams. */
  private elapsed(stream: 'motion' | 'orientation'): number {
    const now = performance.now();
    const previous = stream === 'motion' ? this.lastMotion : this.lastOrientation;
    if (stream === 'motion') this.lastMotion = now;
    else this.lastOrientation = now;

    if (previous === 0) return 0;
    return Math.min((now - previous) / 1000, MAX_SENSOR_GAP_SECONDS);
  }
}

/** How far the UI is rotated from the device's natural orientation. */
export function screenAngle(): number {
  const orientation = screen.orientation as ScreenOrientation | undefined;
  if (orientation && typeof orientation.angle === 'number') return orientation.angle;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

export interface CameraResult {
  stream: MediaStream | null;
  state: PermissionState;
  /**
   * Horizontal field of view in degrees, if the browser will say. Almost none
   * will, so this is usually null and the user calibrates it by hand.
   */
  fov: number | null;
}

export async function requestCamera(): Promise<CameraResult> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return { stream: null, state: 'unsupported', fov: null };
  }

  // Android grants camera access to the app, not to the page. Without this,
  // getUserMedia rejects with no prompt having ever appeared.
  if (isNative() && (await requestNativeCamera()) === 'denied') {
    return { stream: null, state: 'denied', fov: null };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });

    return { stream, state: 'granted', fov: fovFromTrack(stream) };
  } catch (error) {
    const denied = error instanceof DOMException && error.name === 'NotAllowedError';
    return { stream: null, state: denied ? 'denied' : 'unsupported', fov: null };
  }
}

/**
 * Recover the camera's field of view from the track, where the browser exposes
 * it. Chrome on Android sometimes reports focal length and sensor size; almost
 * nothing else does, so treat a null here as normal rather than a fault.
 */
function fovFromTrack(stream: MediaStream): number | null {
  const track = stream.getVideoTracks()[0];
  if (!track) return null;

  const settings = track.getSettings() as MediaTrackSettings & {
    focalLengthX?: number;
    width?: number;
  };

  if (
    typeof settings.focalLengthX === 'number' &&
    settings.focalLengthX > 0 &&
    typeof settings.width === 'number'
  ) {
    const halfWidth = settings.width / 2;
    return (2 * Math.atan(halfWidth / settings.focalLengthX) * 180) / Math.PI;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Raw magnetic field strength
 * ------------------------------------------------------------------ */

interface GenericSensorMagnetometer {
  x: number | null;
  y: number | null;
  z: number | null;
  start(): void;
  stop(): void;
  addEventListener(type: 'reading' | 'error', listener: () => void): void;
}

/**
 * Raw magnetometer field strength, where the browser exposes it -- the
 * Generic Sensor API's Magnetometer interface, Chrome on Android only.
 * Unsupported on iOS Safari and desktop entirely, and even where it exists it
 * needs a permissions-policy allowing it, which same-origin pages get by
 * default but an embedder could still block.
 *
 * Every failure mode -- unsupported, blocked, no hardware, permission denied
 * -- looks the same to the caller: `start` returns false and no readings
 * arrive, so whatever depends on this (magnetic-interference detection) just
 * does not activate rather than erroring. This is a real physical
 * measurement in microtesla, unlike the fused heading `DeviceOrientationEvent`
 * exposes -- the two are not interchangeable.
 */
export class MagnetometerSource {
  private sensor: GenericSensorMagnetometer | null = null;

  static get supported(): boolean {
    return typeof window !== 'undefined' && 'Magnetometer' in window;
  }

  start(onReading: (microtesla: number) => void): boolean {
    if (!MagnetometerSource.supported) return false;

    try {
      const Magnetometer = (
        window as unknown as {
          Magnetometer: new (options: { frequency: number }) => GenericSensorMagnetometer;
        }
      ).Magnetometer;
      const sensor = new Magnetometer({ frequency: 2 });

      sensor.addEventListener('reading', () => {
        onReading(Math.hypot(sensor.x ?? 0, sensor.y ?? 0, sensor.z ?? 0));
      });
      // A permission grant does not guarantee readings ever arrive -- if the
      // hardware genuinely refuses, this is the only signal of it.
      sensor.addEventListener('error', () => this.stop());

      sensor.start();
      this.sensor = sensor;
      return true;
    } catch {
      // SecurityError (permissions-policy), NotAllowedError (permission
      // denied), or a browser that defines the class but refuses to
      // construct it. All the same to the caller.
      return false;
    }
  }

  stop(): void {
    this.sensor?.stop();
    this.sensor = null;
  }
}

/**
 * Whether this device's PRIMARY pointing mechanism is touch, rather than a
 * mouse or trackpad -- the signal this app actually needs, which is
 * capability, not form factor. A laptop with a touchscreen still answers
 * false here (its primary input stays the trackpad), and that is correct:
 * showing it a phone's rear-camera view would put the user's own face on
 * screen, not the sky.
 *
 * Not a proxy for "is this a phone" in general -- just for "does pointing at
 * something with your finger, rather than a cursor, describe how this device
 * is normally used", which is what decides whether a camera view and touch-
 * sized chrome make sense by default.
 */
export function primaryPointerIsCoarse(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Whether the page is in a context where sensors are allowed at all. */
export function isSecureContextForSensors(): boolean {
  // Camera, geolocation and motion all require a secure context. On a LAN this
  // is the thing that quietly breaks: http://192.168.x.x fails with no error
  // that points at the cause.
  //
  // Inside Capacitor the WebView serves from https://localhost, so this is
  // always satisfied -- which is one of the better reasons to ship the wrapper.
  return window.isSecureContext;
}
