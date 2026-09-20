# iOS build

Notes for the iOS wrapper, written to be folded into the README's build section
next to Android.

## Building it

```bash
npm run ios:sync
npm run ios:open
```

Needs macOS and Xcode. There is no CocoaPods step: Capacitor 8 resolves the
native dependencies through Swift Package Manager instead, so the first build
in Xcode fetches `capacitor-swift-pm` and the two plugin packages over the
network and then works offline like everything else here.

`ios:sync` rebuilds the web bundle and copies it into `ios/App/App/public`,
the same way `android:sync` fills the APK's assets. That directory is
generated and not committed.

One thing to know if the committed project was last synced from Windows:
`cap sync` writes the local plugin paths in `ios/App/CapApp-SPM/Package.swift`
using whatever separator the host uses, so they can land as backslashes and
Xcode will not resolve them. They are committed with forward slashes; a sync on
the Mac rewrites them correctly anyway.

Before the first run, open `ios/App/App.xcodeproj` and set a signing team on
the `App` target. The bundle identifier is `app.stargaze.sky`, matching
`appId` in `capacitor.config.ts`; change both together or `cap` and Xcode
disagree about which app they are building.

## The Simulator will not do

The Simulator has no camera, no magnetometer and no accelerometer, so it shows
the drag-to-look fallback over a black sky and nothing else. That is the app
working correctly, not a broken build -- but it means every claim about
heading, tilt or the camera view has to be checked on a real phone.

## Permission strings

`ios/App/App/Info.plist` carries `NSCameraUsageDescription`,
`NSLocationWhenInUseUsageDescription` and `NSMotionUsageDescription`. These are
not optional paperwork: iOS terminates the app the moment it asks for a
permission whose string is missing, with a crash log that names the key and
nothing else. They are also what App Store review reads, so each one says what
the sensor is for rather than naming it back at the user.

There is deliberately no photo-library string. The app opens a camera *stream*
and never touches the library, and claiming a permission it does not use is a
review rejection of its own.

## Why the config has an iOS block

Two settings in `capacitor.config.ts` exist only for this platform.

`server.iosScheme: 'https'` moves the page off Capacitor's default
`capacitor://localhost`. WebKit does not hand a custom scheme access to the
camera, and the camera is the background of this app. Android was already on
`https://localhost` for the same reason.

`ios.scrollEnabled: false` stops WKWebView rubber-banding the whole page.
Nothing in the app scrolls at the document level -- `#app` is fixed to the
viewport -- so the bounce only ever peels the sky off the top edge and looks
like a rendering fault. Panels scroll inside their own overflow containers and
are unaffected.

`UIUserInterfaceStyle` is pinned to `Dark` in Info.plist for a related reason:
the status bar sits on top of the page, and left on automatic iOS paints black
glyphs over a near-black sky.

## Still carrying Capacitor's app icon

`ios/App/App/Assets.xcassets/AppIcon.appiconset` is the stock Capacitor logo.
iOS wants a single 1024x1024 PNG and the largest artwork in the repo is
`packages/web/public/icon-512.png`, so replacing it properly means rendering
`icon.svg` at 1024 first and then `npx @capacitor/assets generate --ios`.
Upscaling the 512 would just ship a soft icon.

The launch screen is already dealt with: `LaunchScreen.storyboard` is a plain
`#05070D` field with no logo, matching the Android decision that the permission
gate is the first screen worth showing.

## Sensors

There is no iOS equivalent of `RotationVectorPlugin.java` and probably no need
for one. WebKit exposes a fused, Core Motion-backed heading through
`webkitCompassHeading` on the ordinary `deviceorientation` event, which
`sensors.ts` already reads. `startRotationVector` returns false on iOS and the
app takes the DeviceOrientationEvent path, which is the intended route rather
than a gap.

Motion permission is gated behind a user gesture on WebKit --
`DeviceOrientationEvent.requestPermission()` throws if called outside one. The
app already handles this: the permission gate is a single deliberate button,
which is why it is a button.

## Known gap: declination may be applied twice

`webkitCompassHeading` reports a heading relative to *true* north when location
services are available, falling back to magnetic north when they are not.
Android's rotation vector reports magnetic north, and `currentBasis` in
`main.ts` adds the IGRF declination on top unconditionally. On iOS that likely
double-counts it -- up to about 15 degrees of heading error in the worst
places, and none at all along the agonic line, which makes it easy to miss.

Not fixed here because the fix belongs in the sensor-to-basis path, not in the
platform wrapper. The `northOffset` calibration in settings absorbs it in the
meantime, which is what that knob is for.

Worth checking on a real device before this matters: point at Polaris somewhere
with a known declination and see whether the error tracks it.
