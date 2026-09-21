# StarGaze

<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/cover.png" alt="StarGaze" width="100%">
</p>

Point your phone at the sky and StarGaze tells you what you're looking at. It runs in the browser, installs like an app, and keeps working with no signal.

Try it: https://ramskandh-thirandasu.github.io/stargaze/

<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-sky.png" alt="StarGaze sky view" width="300">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/phone-tonight.png" alt="StarGaze Tonight view" width="300">
</p>
<p align="center">
  <img src="https://raw.githubusercontent.com/Ramskandh-Thirandasu/stargaze/refs/heads/main/docs/tablet-sky.png" alt="StarGaze on tablet" width="640">
</p>

## What it does

- 8,871 stars down to magnitude 6.5, all 88 constellations, the planets, and the Moon with its phase
- 29 Messier objects, the galaxies and nebulae you can actually pick out by eye
- Four bright asteroids, and meteor shower radiants while a shower is running
- Tracking: pick something and it points you at it, including when it's behind you
- It checks whether it's actually looking at sky, and says so when it isn't
- A camera mode that draws the labels over the live camera feed
- Compass calibration, and the gyroscope smooths out the heading so the sky doesn't jitter
- Scrub the time forwards and back to see the sky on any date
- Search by name, and a Tonight list of what's above the horizon right now
- Drag mode, so you can look around on a laptop with no sensors
- Works offline

## How it works

There's no image recognition here. I tried that first and gave up on it. A phone photo of the night sky is basically a black rectangle with a few dots in it, so there's almost nothing to match against, and it gets worse under light pollution, which is exactly when you want the help.

So it calculates instead. Three inputs:

1. Where you are, from GPS. The sky over India isn't the sky over Iceland.
2. The time. The sky turns about 15 degrees an hour.
3. Which way the phone is pointing, from the compass and accelerometer.

Feed those into the star catalogue and some spherical trigonometry and you get the altitude and azimuth of every object. That's the whole idea. It's fast, it's exact, and it needs no network.

All of it runs on the device, so your location and camera never leave your phone. There's no server and no account.

## What it doesn't do

- The compass is the weak point. Phone magnetometers are usually 5 to 15 degrees off, which is 10 to 30 Moon widths. That's what the calibration screen is for, but you have to use it.
- Metal and electronics make it worse. Indoors or in a car the heading can be badly wrong. The app warns you when the readings look unstable, but it can't fix them.
- The catalogue stops at magnitude 6.5, which is roughly what your eyes manage under a genuinely dark sky. The default view is set to 4.5 so it isn't a mess in town; turn the slider up when you're somewhere dark. If you want a catalogue deeper than your eyes go, use Stellarium.
- It can't see a roof. Pointing at a ceiling, the stars really are up there and the app will draw them. It now watches the camera, GPS accuracy and the magnetic field to work out whether it's looking at open sky, and dims the overlay with a note when it doubts it. Those thresholds are guesses until someone tunes them outdoors.
- On iOS you have to tap the page once before motion works. Safari won't grant the orientation permission without a gesture.
- Uranus and Neptune obey the same magnitude rule as everything else. Uranus (~5.7) shows up once you turn the limit past it, which is honest since it genuinely is a naked-eye object under a dark sky. Neptune (~7.9) never clears 6.5, so it's calculated and searchable but in practice never drawn.

That last one is a rule I stuck to: nothing disappears silently. Things that are up but washed out by daylight or a bright Moon get dimmed and labelled instead of removed.

## Running it

```bash
npm install
npm test
npm run dev
```

`npm test` runs 250 tests in `packages/core`. Thirteen more in `live-verify.test.ts` are skipped by default because they hit JPL Horizons over the network. `npm run dev` serves on http://localhost:5173.

### On a real phone

Mobile browsers only give you camera, GPS and motion over https, and on plain http they fail silently. No permission prompt, nothing logged, the page just sits there. This took me way too long to figure out.

```bash
npm run serve
```

That builds the app and starts a local https server, which prints the address to open on your phone. Your phone will complain about the certificate once. Accept it.

### Android

```bash
npm run android:sync
npm run android:open
```

Needs JDK 21. Newer ones fail with `Unsupported class file major version`, including the JDK inside Android Studio, which is a confusing way to lose an evening. The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`.

### iOS

```bash
npm run ios:sync
npm run ios:open
```

Needs a Mac and Xcode. You have to set a signing team on the App target yourself, and you want a real device rather than the Simulator, which has no camera or magnetometer and so only ever shows the drag fallback. Full notes, including the app icon that still needs replacing, are in [docs/ios-build.md](docs/ios-build.md).

### Rebuilding the star data

`npm run data` runs the Python scripts in `tools/` to regenerate the JSON in `packages/web/public/data/`. You only need it to change the magnitude limit or pull newer source data. The generated files are committed, so a normal build never touches Python.

## Accuracy

The maths is much more accurate than the hardware, so the compass is what limits you, not the astronomy.

Positions are checked against [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/) at six dates between 2021 and 2045. Errors are in arcseconds, where an arcsecond is 1/3600 of a degree. The full Moon is about 1,800 arcseconds across.

| Object | Max error | Object | Max error |
|---|---|---|---|
| Sun | 13.5" | Jupiter | 368.3" |
| Mercury | 21.7" | Saturn | 435.0" |
| Venus | 18.0" | Uranus | 110.2" |
| Mars | 31.7" | Neptune | 34.4" |
| Moon | 16.5" | | |

The worst is Saturn, at about a quarter of a Moon width. A compass that's 5 to 15 degrees off is 18,000 to 54,000 arcseconds, so the hardware error is hundreds of times bigger than anything the maths adds. That's why I built calibration before adding more catalogue data.

## Project layout

```
tools/          Python scripts that build the catalogue JSON. Not shipped in the app.
packages/core/  The astronomy: coordinates, ephemeris, visibility, pointing. 250 tests.
packages/web/   The app, plus the generated data in public/data.
server/         Local https server, only used for testing on a phone.
android/        Capacitor wrapper around the same web build.
ios/            The same, for iOS.
```

`packages/core` has no DOM dependencies, which is what makes the maths testable on its own. That split was the first decision I made and the one I'd keep.

## Data sources

These are compiled into the app at build time by the scripts in `tools/`. None of them are contacted at runtime. All are free to use, and the same list is in the app's about screen.

| Data | Source |
|---|---|
| Star positions, magnitudes, colours, names | [HYG Database v4.0](https://github.com/astronexus/HYG-Database), David Nash / astronexus, CC BY-SA 4.0 |
| Deep-sky objects | [OpenNGC](https://github.com/mattiaverga/OpenNGC), Mattia Verga, CC BY-SA 4.0 |
| Asteroid elements | [NASA JPL Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html), public domain |
| Meteor shower radiants and rates | [IMO Working List of Visual Meteor Showers](https://www.imo.net/resources/calendar/) |
| Constellation figures | [Stellarium](https://github.com/Stellarium/stellarium), `modern_iau` sky culture, CC BY-SA 4.0 |
| Planetary orbital elements | [NASA JPL, Approximate Positions of the Planets](https://ssd.jpl.nasa.gov/planets/approx_pos.html), public domain |
| Magnetic declination | [IGRF-14](https://www.ngdc.noaa.gov/IAGA/vmod/igrf.html), IAGA Working Group V-MOD via NOAA NCEI |

Gzipped the whole data set is about 180 KB, most of it the star catalogue. That's up from 56 KB at magnitude 4.5: nine times the stars for a bit over three times the bytes, because positions are stored to three decimals rather than four. Still small enough to ship offline, which is the point. The reference positions used in the tests come from [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/).

## AI usage

I designed and built this myself. The architecture, the positioning maths, the sensor handling, the rendering and the tests are my work. I read the JPL documentation and the catalogue formats, made the decisions, and did the debugging.

I used an AI coding assistant along the way, mostly for moving around the codebase and routine edits. It made me faster. It didn't design the app, and I can explain any part of it.

## License

MIT, see [LICENSE](LICENSE). The bundled datasets keep their own licenses, listed above and in [NOTICE.md](NOTICE.md).
