# StarGaze

<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/cover.png" alt="StarGaze" width="100%">
</p>

Point your phone at the sky and StarGaze tells you which star, planet or constellation you are looking at. It runs in the browser, installs as a PWA, and keeps working with no signal.

Live version: https://ramskandh-thirandasu.github.io/stargaze/

<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-sky.png" alt="StarGaze sky view" width="300">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-tonight.png" alt="StarGaze Tonight view" width="300">
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/tablet-sky.png" alt="StarGaze on tablet" width="640">
</p>

## What it does

- Live sky view with all 88 constellation figures drawn
- 1,009 stars down to magnitude 4.5, the five naked-eye planets, and the Moon with its current phase
- Camera mode, which draws the labels over the live camera feed
- Works offline once the service worker has cached it
- Compass calibration, because phone compasses are usually wrong by several degrees
- Search by name, and a Tonight list of what is above the horizon right now
- Drag mode, for looking around on a laptop with no sensors involved

## How it works

There is no image recognition in this project. I tried that first and gave up on it. A phone photo of the night sky is close to a black rectangle with a few dots in it, so there is very little in the frame to match against, and it gets worse under light pollution, which is exactly when you want the help.

The app computes positions instead. It needs three things:

1. Where you are, from GPS. The sky over India is not the sky over Iceland.
2. What time it is. The sky rotates about 15 degrees per hour.
3. Which way the phone is pointing, from the magnetometer and the accelerometer.

Given those, the star catalogue and some spherical trigonometry give you the altitude and azimuth of every object. That is the whole idea. It is exact, it is fast, and it needs no network.

Everything runs on the device. There is no server and no account, so your location and camera never leave your phone.

## Why you might not want it

The limits are real, so they are worth stating.

- The compass is the weak link. Phone magnetometers are typically off by 5 to 15 degrees, which is 10 to 30 Moon widths. The calibration screen exists to correct that, but you have to actually use it.
- Metal and electronics throw the heading off badly. Indoors, in a car, or next to a laptop it can be wildly wrong. The app warns you when the readings look unstable, but it cannot fix them.
- Magnitude 4.5 is not a lot of stars. 1,009 is enough to recognise the constellations and find the planets. If you want galaxies and nebulae, use Stellarium.
- iOS needs a tap before motion works. Safari requires a user gesture to grant the orientation permission, so the sky does not track until you interact with the page.
- Uranus and Neptune are computed and tested, but never drawn. They are too faint to pick out by eye, and a label floating over blank sky teaches you to distrust everything else on screen.

That last one is a rule throughout: nothing is silently hidden. Objects above the horizon but washed out by daylight or a bright Moon are drawn dimmed and labelled rather than removed. Knowing something is up there but invisible is more useful than the marker quietly disappearing.

## Running it

```bash
npm install
npm test
npm run dev
```

`npm test` runs 118 tests in `packages/core`. Nine further tests in `live-verify.test.ts` are skipped by default because they fetch from JPL Horizons over the network.

`npm run dev` serves on http://localhost:5173.

### Testing on a real phone

Mobile browsers only expose the camera, geolocation and motion sensors over https. On plain http they fail silently: no permission prompt appears, nothing is logged, and the page just sits there. This took me an embarrassing amount of time to work out, so it is worth stating plainly.

```bash
npm run serve
```

That builds the app and starts the local https server, which prints the LAN address to open on your phone. Your phone will warn about the self-signed certificate the first time. Accept it.

### Android

```bash
npm run android:sync
npm run android:open
```

Requires JDK 21. Newer JDKs fail with `Unsupported class file major version`, including the JDK bundled inside Android Studio, which is a confusing way to lose an evening. The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

### Rebuilding the star data

```bash
npm run data
```

This runs the Python scripts in `tools/`, which fetch the source catalogues and regenerate the JSON in `packages/web/public/data/`. You only need it to change the magnitude limit or pull newer source data. The generated files are committed, so a normal build never touches Python.

## Accuracy

The positional maths is far more accurate than the hardware it runs on, so in practice the compass limits you, not the astronomy.

Positions are checked automatically against [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) at six dates spanning 2021 to 2045. Errors are in arcseconds, where one arcsecond is 1/3600 of a degree. The full Moon is roughly 1,800 arcseconds across.

| Object | Max error | Object | Max error |
|---|---|---|---|
| Sun | 13.5" | Jupiter | 368.3" |
| Mercury | 21.7" | Saturn | 435.0" |
| Venus | 18.0" | Uranus | 110.2" |
| Mars | 31.7" | Neptune | 34.4" |
| Moon | 16.5" | | |

Uranus and Neptune are tested but never drawn, as above.

The worst of those is Saturn, at about a quarter of a Moon width. A compass error of 5 to 15 degrees is 18,000 to 54,000 arcseconds, so the hardware error is two orders of magnitude larger than anything the ephemeris contributes. That ratio is why calibration got built before any extra catalogue data did.

## Project layout

```
tools/          Python scripts that build the catalogue JSON. Not shipped in the app.
packages/core/  Astronomy maths: coordinates, ephemeris, visibility, pointing. 118 tests.
packages/web/   The app itself, plus the generated data in public/data.
server/         Local https server, used only for testing on a phone.
android/        Capacitor wrapper around the same web build.
```

`packages/core` has no DOM dependencies, which is what makes the maths testable on its own. That split was the first decision I made and the one I would keep.

## Data sources

The catalogues below are compiled into the app at build time by the scripts in `tools/`. None of them are contacted at runtime. All are free to use, and the same list appears in the app's about screen.

| Data | Source |
|---|---|
| Star positions, magnitudes, colours, names | [HYG Database v4.0](https://github.com/astronexus/HYG-Database), David Nash / astronexus, CC BY-SA 4.0 |
| Constellation figures | [Stellarium](https://github.com/Stellarium/stellarium), `modern_iau` sky culture, CC BY-SA 4.0 |
| Planetary orbital elements | [NASA JPL, Approximate Positions of the Planets](https://ssd.jpl.nasa.gov/planets/approx_pos.html), public domain |
| Magnetic declination | [IGRF-14](https://www.ngdc.noaa.gov/IAGA/vmod/igrf.html), IAGA Working Group V-MOD via NOAA NCEI |

Gzipped, the whole data set is about 57 KB, which is what makes shipping it offline practical. Reference positions used to test the astronomy come from [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/).

## AI usage

I designed and built this project myself. The architecture, the positioning maths, the sensor handling, the rendering and the test setup are my work. I read the JPL documentation and the source catalogue formats, made the technical decisions, and did the debugging.

I used an AI coding assistant during development, mainly for navigating the codebase and for routine edits. It sped me up. It did not design the app, and I can explain any part of it.

## License

MIT, see [LICENSE](LICENSE). The bundled datasets keep their own licenses, listed above and in [NOTICE.md](NOTICE.md).
