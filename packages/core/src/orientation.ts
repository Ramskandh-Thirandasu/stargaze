/**
 * Where the phone is pointed.
 *
 * Turns raw sensor output into a camera basis in the observer's world frame,
 * which is what the projection needs. Everything here is in East-North-Up
 * coordinates: +x east, +y north, +z straight up.
 *
 * Two inputs are supported, behind one interface:
 *
 *  - Browser `DeviceOrientationEvent` alpha/beta/gamma
 *  - A rotation quaternion, which is what Android's `TYPE_ROTATION_VECTOR`
 *    gives and what a native plugin would pass through
 *
 * The quaternion path exists because the Euler angles are the weaker signal:
 * they degrade near vertical (gimbal lock, exactly where you point a phone at
 * the sky) and browsers disagree about their reference frame. If the web path
 * proves too coarse, a small native plugin drops in behind the same interface.
 *
 * Whichever path supplies the angles, the heading is the weak number in them:
 * the astronomy is good to a fraction of an arcminute and a phone compass is
 * out by degrees. `HeadingFusion` and `MagneticFieldMonitor` at the bottom of
 * this file are about that, and nothing else.
 */

import { angularDelta, normalize360, toDegrees, toRadians } from './angles.js';

/** A direction in the world frame: +x east, +y north, +z up. Unit length. */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The camera's orientation in the world.
 *
 * `forward` is where the rear camera points; `right` and `up` are the screen's
 * axes mapped into the world, so the projection knows which way is up on the
 * display even when the phone is held sideways.
 */
export interface CameraBasis {
  forward: Vector3;
  right: Vector3;
  up: Vector3;
  /** Degrees above the horizon the camera is aimed at. */
  altitude: number;
  /** Degrees clockwise from TRUE north the camera is aimed at. */
  azimuth: number;
  /** Rotation of the screen about the view axis, degrees. */
  roll: number;
}

export interface DeviceOrientation {
  /** Rotation about the vertical axis, degrees. `DeviceOrientationEvent.alpha`. */
  alpha: number;
  /** Front-to-back tilt, degrees. `DeviceOrientationEvent.beta`. */
  beta: number;
  /** Left-to-right tilt, degrees. `DeviceOrientationEvent.gamma`. */
  gamma: number;
  /** `screen.orientation.angle`: how far the UI is rotated from portrait. */
  screenAngle?: number;
  /**
   * Magnetic declination in degrees east, from {@link magneticDeclination}.
   *
   * Sensor headings are magnetic. Leaving this at zero points the sky at the
   * magnetic pole, which is the wrong pole.
   */
  declination?: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function normalize(v: Vector3): Vector3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/** Rotate a world vector about the vertical axis, for the declination fix. */
function rotateAboutUp(v: Vector3, degrees: number): Vector3 {
  if (degrees === 0) return v;
  // Azimuth runs clockwise from north while the world frame is right-handed,
  // so a positive (eastward) declination rotates vectors this way round.
  const angle = toRadians(degrees);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: c * v.x + s * v.y, y: -s * v.x + c * v.y, z: v.z };
}

/**
 * Camera basis from browser device-orientation angles.
 *
 * The W3C event describes an intrinsic Z-X'-Y'' rotation carrying the world
 * frame onto the device frame. The rear camera looks along the device's -Z
 * axis, which is why `forward` comes out as the negated third column of that
 * rotation.
 *
 * The camera direction does not depend on `screenAngle` -- the lens points out
 * of the back however you hold it -- but the screen axes do, which is what
 * keeps labels upright in landscape.
 */
export function basisFromDeviceOrientation(orientation: DeviceOrientation): CameraBasis {
  const alpha = toRadians(orientation.alpha);
  const beta = toRadians(orientation.beta);
  const gamma = toRadians(orientation.gamma);
  const screen = toRadians(orientation.screenAngle ?? 0);

  const cA = Math.cos(alpha);
  const sA = Math.sin(alpha);
  const cB = Math.cos(beta);
  const sB = Math.sin(beta);
  const cG = Math.cos(gamma);
  const sG = Math.sin(gamma);

  // R = Rz(alpha) . Rx(beta) . Ry(gamma), device axes expressed in the world.
  const deviceX: Vector3 = {
    x: cA * cG - sA * sB * sG,
    y: sA * cG + cA * sB * sG,
    z: -cB * sG,
  };
  const deviceY: Vector3 = {
    x: -sA * cB,
    y: cA * cB,
    z: sB,
  };
  const deviceZ: Vector3 = {
    x: cA * sG + sA * sB * cG,
    y: sA * sG - cA * sB * cG,
    z: cB * cG,
  };

  // Screen axes in device coordinates, rotated by the UI orientation.
  const cS = Math.cos(screen);
  const sS = Math.sin(screen);

  const combine = (a: Vector3, b: Vector3, wa: number, wb: number): Vector3 => ({
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
  });

  return finishBasis(
    { x: -deviceZ.x, y: -deviceZ.y, z: -deviceZ.z },
    combine(deviceX, deviceY, cS, sS),
    combine(deviceX, deviceY, -sS, cS),
    orientation.declination ?? 0,
  );
}

/**
 * Camera basis from a rotation quaternion mapping device axes into the world.
 *
 * This is the path Android's rotation-vector sensor feeds. That sensor fuses
 * gyroscope, accelerometer and magnetometer in hardware, which is steadier than
 * anything reconstructed from Euler angles in JavaScript.
 *
 * Android reports its rotation vector in an East-North-Up frame already, so no
 * axis remapping is needed here.
 */
export function basisFromQuaternion(
  q: Quaternion,
  screenAngle = 0,
  declination = 0,
): CameraBasis {
  const length = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  const x = q.x / length;
  const y = q.y / length;
  const z = q.z / length;
  const w = q.w / length;

  // Columns of the rotation matrix: the device axes in world coordinates.
  const deviceX: Vector3 = {
    x: 1 - 2 * (y * y + z * z),
    y: 2 * (x * y + z * w),
    z: 2 * (x * z - y * w),
  };
  const deviceY: Vector3 = {
    x: 2 * (x * y - z * w),
    y: 1 - 2 * (x * x + z * z),
    z: 2 * (y * z + x * w),
  };
  const deviceZ: Vector3 = {
    x: 2 * (x * z + y * w),
    y: 2 * (y * z - x * w),
    z: 1 - 2 * (x * x + y * y),
  };

  const screen = toRadians(screenAngle);
  const cS = Math.cos(screen);
  const sS = Math.sin(screen);

  const combine = (a: Vector3, b: Vector3, wa: number, wb: number): Vector3 => ({
    x: a.x * wa + b.x * wb,
    y: a.y * wa + b.y * wb,
    z: a.z * wa + b.z * wb,
  });

  return finishBasis(
    { x: -deviceZ.x, y: -deviceZ.y, z: -deviceZ.z },
    combine(deviceX, deviceY, cS, sS),
    combine(deviceX, deviceY, -sS, cS),
    declination,
  );
}

/** Apply declination, orthonormalise, and read off the pointing angles. */
function finishBasis(
  forwardRaw: Vector3,
  rightRaw: Vector3,
  upRaw: Vector3,
  declination: number,
): CameraBasis {
  const forward = normalize(rotateAboutUp(forwardRaw, declination));
  let right = rotateAboutUp(rightRaw, declination);
  let up = rotateAboutUp(upRaw, declination);

  // Gram-Schmidt: sensor noise makes the raw axes drift out of square, and a
  // non-orthogonal basis shears the whole sky.
  const rightDotForward = dot(right, forward);
  right = normalize({
    x: right.x - forward.x * rightDotForward,
    y: right.y - forward.y * rightDotForward,
    z: right.z - forward.z * rightDotForward,
  });

  // right x forward, in that order. Reversing the operands flips the up axis
  // and renders the whole sky upside down -- and still passes an orthonormality
  // check, so only a directional test catches it.
  up = normalize({
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  });

  const altitude = toDegrees(Math.asin(Math.max(-1, Math.min(1, forward.z))));
  const azimuth = normalize360(toDegrees(Math.atan2(forward.x, forward.y)));

  // Roll: how far the screen's up-axis has turned away from world up, measured
  // in the plane the camera is looking through.
  const worldUpInPlane: Vector3 = {
    x: -forward.z * forward.x,
    y: -forward.z * forward.y,
    z: 1 - forward.z * forward.z,
  };
  const roll = normalize360(
    toDegrees(Math.atan2(dot(worldUpInPlane, right), dot(worldUpInPlane, up))),
  );

  return { forward, right, up, altitude, azimuth, roll };
}

/** Unit vector in the world frame for an altitude and azimuth, in degrees. */
export function directionFromHorizontal(altitude: number, azimuth: number): Vector3 {
  const alt = toRadians(altitude);
  const az = toRadians(azimuth);
  const cosAlt = Math.cos(alt);
  return {
    x: cosAlt * Math.sin(az), // east
    y: cosAlt * Math.cos(az), // north
    z: Math.sin(alt), // up
  };
}

/** Inverse of {@link directionFromHorizontal}. */
export function horizontalFromDirection(v: Vector3): { altitude: number; azimuth: number } {
  const unit = normalize(v);
  return {
    altitude: toDegrees(Math.asin(Math.max(-1, Math.min(1, unit.z)))),
    azimuth: normalize360(toDegrees(Math.atan2(unit.x, unit.y))),
  };
}

/**
 * Smoothing for a live heading.
 *
 * A magnetometer's raw output jitters by degrees from one reading to the next.
 * Drawn straight, the sky visibly shivers. This is a low-pass filter that
 * respects the wrap at north, so a heading crossing 360 does not spin the sky
 * the long way round.
 *
 * `factor` is how much of the new reading to admit: small is smooth and
 * laggy, large is responsive and jittery. Around 0.1 to 0.2 per frame is
 * usually the sweet spot.
 *
 * Smoothing is all this does. It cannot tell a turn from noise, so it trades
 * one against the other and that is as good as it gets from a single sensor.
 * {@link HeadingFusion} does better where a gyroscope exists, and falls back
 * to roughly this behaviour where one does not.
 */
export class HeadingFilter {
  private value: number | null = null;

  constructor(private readonly factor: number = 0.15) {}

  push(reading: number): number {
    if (this.value === null) {
      this.value = normalize360(reading);
      return this.value;
    }
    // Step along the short arc, so 359 -> 1 moves forward two degrees.
    const delta = ((reading - this.value + 540) % 360) - 180;
    this.value = normalize360(this.value + delta * this.factor);
    return this.value;
  }
}

/* ------------------------------------------------------------------ *
 * Fusing the gyroscope with the magnetometer
 * ------------------------------------------------------------------ */

/**
 * Angular velocity in the device frame, degrees per second -- the three
 * components of `DeviceMotionEvent.rotationRate`, right-handed about the
 * device's own axes.
 */
export interface DeviceRotationRate {
  /** About the device x axis, the short edge. `rotationRate.beta`. */
  beta: number;
  /** About the device y axis, the long edge. `rotationRate.gamma`. */
  gamma: number;
  /** About the device z axis, out of the screen. `rotationRate.alpha`. */
  alpha: number;
}

/**
 * How fast the heading is turning, degrees per second, from a gyroscope
 * reading and the phone's current tilt.
 *
 * A gyroscope measures rotation about the device's own axes, but a heading
 * turns about the world's vertical. Which device axis that corresponds to
 * depends entirely on how the phone is held: flat on a table it is the z
 * axis, held up at the sky it is the y axis, and in between it is a mixture.
 * Feeding `rotationRate.alpha` straight in -- the obvious shortcut -- is
 * therefore correct only when the phone is lying flat, which is the one pose
 * this app is never used in.
 *
 * Only the tilt is needed, not the heading: turning the world frame about its
 * own vertical axis does not move that axis.
 */
export function headingRateFromDeviceRotation(
  rate: DeviceRotationRate,
  beta: number,
  gamma: number,
): number {
  const b = toRadians(beta);
  const g = toRadians(gamma);
  // World up in device coordinates: the vertical components of the device axes
  // from basisFromDeviceOrientation, which alpha drops out of.
  return (
    rate.beta * -(Math.cos(b) * Math.sin(g)) +
    rate.gamma * Math.sin(b) +
    rate.alpha * (Math.cos(b) * Math.cos(g))
  );
}

/**
 * Tuning for {@link HeadingFusion}. Sensors differ between handsets, so these
 * are knobs rather than constants of nature -- {@link DEFAULT_HEADING_FUSION}
 * is a starting point, not a law.
 */
export interface HeadingFusionOptions {
  /**
   * Seconds for the magnetometer to pull the estimate onto an absolute bearing
   * while a gyroscope is carrying the short-term motion. Long, because all the
   * magnetometer has left to do is cancel slow gyro drift, and the longer it is
   * the less magnetic noise reaches the screen.
   */
  fusedTimeConstantSeconds: number;
  /**
   * The same, with no usable gyroscope. Short, because now the magnetometer is
   * the only thing that knows the phone has turned at all. This is the fallback
   * path and it has to stay about as responsive as the plain low-pass it
   * replaces, or the app gets worse on hardware that lacks the sensor.
   */
  magnetometerOnlyTimeConstantSeconds: number;
  /**
   * How long a gyro sample stays fresh. Past this the filter assumes the
   * gyroscope has stopped -- permission withdrawn, page backgrounded, sensor
   * gone -- and reverts to magnetometer-only behaviour on its own.
   */
  gyroTimeoutSeconds: number;
  /**
   * Turn rate at which the magnetometer stops being believed at all. A
   * magnetometer reads slowly and smears while the phone is being swung about;
   * the gyroscope is at its best exactly then, so hand it the wheel.
   */
  gyroDistrustRateDegreesPerSecond: number;
  /**
   * Disagreement past which the estimate is abandoned and the magnetometer
   * taken whole. Drift is gradual, so a gap this size means the integration
   * lost the plot -- a dropped burst of samples, a wrong-signed rate -- and
   * easing back from it would take minutes.
   */
  snapDegrees: number;
}

export const DEFAULT_HEADING_FUSION: HeadingFusionOptions = {
  fusedTimeConstantSeconds: 2,
  // 0.08s is the time constant of HeadingFilter(0.18) at 60Hz. Deliberately
  // the same, so a device with no gyroscope behaves as it always has.
  magnetometerOnlyTimeConstantSeconds: 0.08,
  gyroTimeoutSeconds: 0.5,
  gyroDistrustRateDegreesPerSecond: 45,
  snapDegrees: 75,
};

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * A complementary filter over the heading.
 *
 * The two sensors fail in opposite directions. A gyroscope is smooth and
 * immediate but only measures change, so an integrated heading walks away from
 * the truth over tens of seconds. A magnetometer knows where north actually is
 * but is noisy, slow, and lies outright near anything ferrous. Run the
 * gyroscope forward and let the magnetometer haul it back slowly, and each
 * covers the other's failure: short-term motion comes out smooth, long-term
 * heading comes out absolute.
 *
 * Time constants rather than per-frame factors, because event rates vary
 * between devices by a factor of six and a per-frame factor quietly means
 * something different on each one.
 *
 * None of this replaces the user-facing calibration. That corrects a constant
 * offset in where north is; this decides how fast to believe the sensor
 * reporting it.
 */
export class HeadingFusion {
  private estimate: number | null = null;
  private rate = 0;
  /** Seconds of magnetometer samples since the last gyro sample. */
  private sinceGyro = Infinity;

  constructor(private readonly options: HeadingFusionOptions = DEFAULT_HEADING_FUSION) {}

  /** The fused heading, or null before the first absolute reading. */
  get heading(): number | null {
    return this.estimate;
  }

  /** True while the gyroscope is fresh enough to be carrying the motion. */
  get usingGyro(): boolean {
    return this.sinceGyro < this.options.gyroTimeoutSeconds;
  }

  /**
   * Carry the heading forward by a gyroscope reading.
   *
   * Stays null until the magnetometer has supplied a starting bearing: a rate
   * of turn is not a heading, and integrating up from an arbitrary zero would
   * point the sky somewhere invented.
   */
  predict(rateDegreesPerSecond: number, dtSeconds: number): number | null {
    if (!Number.isFinite(rateDegreesPerSecond) || !(dtSeconds > 0)) return this.estimate;

    this.rate = rateDegreesPerSecond;
    this.sinceGyro = 0;
    if (this.estimate === null) return null;

    this.estimate = normalize360(this.estimate + rateDegreesPerSecond * dtSeconds);
    return this.estimate;
  }

  /**
   * Pull the estimate toward an absolute magnetic heading. `trust` scales the
   * correction down for a reading the caller has other reasons to doubt --
   * {@link MagneticFieldMonitor} produces one.
   *
   * `trust` is ignored with no gyroscope running. There is nothing else to
   * carry the heading then, and a frozen sky is worse than a doubtful one.
   */
  correct(magneticHeading: number, dtSeconds: number, trust = 1): number {
    const reading = normalize360(magneticHeading);
    if (this.estimate === null || !(dtSeconds > 0)) {
      this.estimate = reading;
      return reading;
    }

    const error = angularDelta(this.estimate, reading);
    if (Math.abs(error) > this.options.snapDegrees) {
      this.estimate = reading;
      this.sinceGyro = Infinity;
      return reading;
    }

    const gyro = this.usingGyro;
    this.sinceGyro += dtSeconds;

    const timeConstant = gyro
      ? this.options.fusedTimeConstantSeconds
      : this.options.magnetometerOnlyTimeConstantSeconds;
    const motionTrust = gyro
      ? clamp01(1 - Math.abs(this.rate) / this.options.gyroDistrustRateDegreesPerSecond)
      : 1;

    const sourceTrust = gyro ? clamp01(trust) : 1;

    const gain = (1 - Math.exp(-dtSeconds / timeConstant)) * sourceTrust * motionTrust;
    this.estimate = normalize360(this.estimate + error * gain);
    return this.estimate;
  }

  /** Forget everything, for when the sensor stream restarts. */
  reset(): void {
    this.estimate = null;
    this.rate = 0;
    this.sinceGyro = Infinity;
  }
}

/* ------------------------------------------------------------------ *
 * Is the magnetometer reading the Earth, or a fridge magnet?
 * ------------------------------------------------------------------ */

/** Tuning for {@link MagneticFieldMonitor}. */
export interface MagneticLimits {
  /**
   * How far the measured field may sit from the model before confidence starts
   * falling, as |ln(measured / expected)|. Phone magnetometers are not lab
   * instruments and a quarter off either way is ordinary calibration slop.
   * Stated as a log ratio so that half the field and twice the field count as
   * equally wrong, which a plain percentage does not.
   */
  toleranceLogRatio: number;
  /** Where confidence reaches zero: double or half what the Earth makes here is
   *  something in the room, not the planet. */
  rejectLogRatio: number;
  /**
   * Sample-to-sample change, microtesla, that is only sensor noise. The Earth's
   * field does not change while you stand still, so movement in the reading is
   * something nearby moving -- and a magnet can sit at a perfectly plausible
   * total strength while still ruining the bearing, which is the case a
   * magnitude check on its own misses.
   */
  toleranceStepMicrotesla: number;
  /** Sample-to-sample change that means something ferrous went past. */
  rejectStepMicrotesla: number;
  /** Weight of the newest step in the running average: high follows a single
   *  spike, low needs the disturbance to persist. */
  stepSmoothing: number;
  /** Confidence below which to tell the user their compass is unreliable. */
  interferenceConfidence: number;
}

export const DEFAULT_MAGNETIC_LIMITS: MagneticLimits = {
  toleranceLogRatio: Math.log(1.25),
  rejectLogRatio: Math.log(2),
  toleranceStepMicrotesla: 2,
  rejectStepMicrotesla: 12,
  stepSmoothing: 0.4,
  // Chosen to fire at roughly the same field ratios the app warned at before
  // this became a graded signal: about 1.8x or 0.55x the modelled strength.
  interferenceConfidence: 0.25,
};

export interface MagneticQuality {
  /** 0 when the field is certainly not the Earth's, 1 when it matches the model
   *  and is holding still. Everything between is a degree of doubt, which is
   *  what a filter wants and what a boolean throws away. */
  confidence: number;
  /** Whether to warn the user. */
  interference: boolean;
  /** Measured over expected field strength, for anyone wanting to say by how
   *  much rather than merely that. */
  ratio: number;
}

/**
 * Watches the raw magnetometer for signs it is measuring the wrong thing.
 *
 * Two independent tells, and confidence is the worse of them: the field is the
 * wrong strength for this part of the world, or the field is moving when the
 * Earth's does not. Either alone misses cases -- a magnet can land the total
 * strength near the expected value while still dragging the bearing off, and a
 * perfectly steady reading taken beside a steel door is steadily wrong.
 */
export class MagneticFieldMonitor {
  private previous: number | null = null;
  private step: number | null = null;

  constructor(private readonly limits: MagneticLimits = DEFAULT_MAGNETIC_LIMITS) {}

  /**
   * Both arguments in microtesla: what the sensor reported, and what
   * {@link magneticFieldIntensity} says the Earth makes here.
   *
   * With no usable reading or model there is nothing to compare, so this
   * reports full confidence rather than crying wolf. The caller cannot tell a
   * clean compass from an unmeasured one, and warning about the second is
   * worse than staying quiet.
   */
  push(microtesla: number, expectedMicrotesla: number): MagneticQuality {
    if (!(microtesla > 0) || !(expectedMicrotesla > 0)) {
      return { confidence: 1, interference: false, ratio: 1 };
    }

    const ratio = microtesla / expectedMicrotesla;
    const deviation = Math.abs(Math.log(ratio));
    const magnitude = clamp01(
      (this.limits.rejectLogRatio - deviation) /
        (this.limits.rejectLogRatio - this.limits.toleranceLogRatio),
    );

    const step = this.previous === null ? 0 : Math.abs(microtesla - this.previous);
    this.previous = microtesla;
    this.step =
      this.step === null ? step : this.step + (step - this.step) * this.limits.stepSmoothing;
    const steadiness = clamp01(
      (this.limits.rejectStepMicrotesla - this.step) /
        (this.limits.rejectStepMicrotesla - this.limits.toleranceStepMicrotesla),
    );

    const confidence = Math.min(magnitude, steadiness);
    return { confidence, interference: confidence < this.limits.interferenceConfidence, ratio };
  }

  reset(): void {
    this.previous = null;
    this.step = null;
  }
}
