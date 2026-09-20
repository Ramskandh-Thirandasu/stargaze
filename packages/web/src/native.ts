/**
 * The native side of the same app -- Android and iOS both.
 *
 * Inside Capacitor the page still uses the ordinary web APIs -- `getUserMedia`,
 * `navigator.geolocation`, `DeviceOrientationEvent` -- because the WebView
 * serves from `https://localhost`, which is a secure context. What the browser
 * does not do is ask the OS for the *runtime* permissions behind those APIs.
 * Without that the calls fail with no prompt and no useful error.
 *
 * So this module exists to do one thing: ask the operating system first. On the
 * web every function here is a no-op, and the caller cannot tell the difference.
 *
 * The plugins are loaded dynamically so the browser build does not carry native
 * code it will never run.
 */

export type NativePermission = 'granted' | 'denied' | 'unavailable';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

function capacitor(): CapacitorGlobal | undefined {
  return (globalThis as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/** True when running inside the Android (or iOS) shell rather than a browser. */
export function isNative(): boolean {
  return capacitor()?.isNativePlatform?.() === true;
}

/**
 * Ask the OS for camera access.
 *
 * Returns 'unavailable' on the web, where the browser handles this itself as
 * part of `getUserMedia`.
 */
export async function requestNativeCamera(): Promise<NativePermission> {
  if (!isNative()) return 'unavailable';

  try {
    const { Camera } = await import('@capacitor/camera');
    // Check before asking: a permission Android already granted last session
    // should never trigger a second system dialog.
    const current = await Camera.checkPermissions();
    if (current.camera === 'granted') return 'granted';

    const result = await Camera.requestPermissions({ permissions: ['camera'] });
    return result.camera === 'granted' ? 'granted' : 'denied';
  } catch {
    // The plugin is missing or the platform refused. Let the web path try
    // anyway rather than blocking on a failure we cannot diagnose here.
    return 'unavailable';
  }
}

/** Ask the OS for location access. */
export async function requestNativeLocation(): Promise<NativePermission> {
  if (!isNative()) return 'unavailable';

  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const current = await Geolocation.checkPermissions();
    if (current.location === 'granted' || current.coarseLocation === 'granted') return 'granted';

    const result = await Geolocation.requestPermissions({ permissions: ['location'] });
    return result.location === 'granted' || result.coarseLocation === 'granted'
      ? 'granted'
      : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Start Android's hardware-fused rotation-vector sensor, where it exists.
 *
 * Returns false for every reason it might not work -- not native, no such
 * sensor on this device, the plugin missing -- so the caller falls back to
 * DeviceOrientationEvent the same way it already does for every other
 * sensor gap. See RotationVectorPlugin.java for what this is fusing.
 *
 * There is no iOS counterpart and it is not obviously worth writing one:
 * WebKit already exposes a fused heading through `webkitCompassHeading`,
 * which is Core Motion's own answer by another name. iOS takes the false
 * branch here and that is the intended path, not a gap.
 */
export async function startRotationVector(
  onReading: (reading: { azimuth: number; pitch: number; roll: number }) => void,
): Promise<boolean> {
  if (!isNative()) return false;

  try {
    const { RotationVector } = await import('./rotationVector.js');
    const { available } = await RotationVector.isAvailable();
    if (!available) return false;

    await RotationVector.addListener('reading', onReading);
    await RotationVector.start();
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the position through the native plugin.
 *
 * The WebView's own `navigator.geolocation` works, but routes through a
 * Google Play Services path that can hang indefinitely on a device with no
 * network. The plugin fails fast instead, which matters for an app whose whole
 * point is working in a field.
 */
export async function nativePosition(): Promise<{
  latitude: number;
  longitude: number;
  elevation: number;
  accuracy: number | null;
} | null> {
  if (!isNative()) return null;

  try {
    const { Geolocation } = await import('@capacitor/geolocation');
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 600000,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      elevation: position.coords.altitude ?? 0,
      accuracy: position.coords.accuracy ?? null,
    };
  } catch {
    return null;
  }
}
