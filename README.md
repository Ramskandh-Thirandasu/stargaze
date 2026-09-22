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
- 29 Messier objects, four bright asteroids, and meteor shower radiants while a shower is running
- Pick something and it points you at it, including when it's behind you
- A camera mode that draws the labels over the live camera feed
- Compass calibration, with the gyroscope smoothing the heading so the sky doesn't jitter
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

The compass is the weak point, and it's the one thing that will actually make the app wrong. See [Accuracy](#accuracy) for the numbers. Metal and electronics make it worse, so indoors or in a car the heading can be badly wrong. The app warns you when the readings look unstable, but it can't fix them.

A few other things worth knowing:

- The catalogue stops at magnitude 6.5, roughly what your eyes manage under a genuinely dark sky. The view defaults to 4.5 so it isn't a mess in town. Turn the slider up when you're somewhere dark. If you want to go deeper than your eyes do, use Stellarium.
- It can't see a roof. Point at a ceiling and the stars really are up there, so it draws them. It watches the camera, GPS accuracy and the magnetic field to guess whether it's looking at open sky, and dims the overlay when it doubts it. Those thresholds are guesses I haven't checked against a real camera yet, so Settings has a Sky check panel with the live numbers. Point it at the sky, then at a ceiling, and the gap is where the threshold belongs.
- On iOS you have to tap the page once before motion works. Safari won't grant the orientation permission without a gesture.
- Neptune sits around magnitude 7.9, past the catalogue limit, so it's calculated and searchable but never drawn. Uranus is about 5.7 and turns up once you raise the limit past it, which is fair, since it genuinely is naked-eye under a dark sky.

Nothing disappears silently, though. Things that are up but washed out by daylight or a bright Moon get dimmed and labelled rather than removed.

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

Needs a Mac and Xcode, and you have to set a signing team on the App target yourself. Use a real device rather than the Simulator, which has no camera or magnetometer and so only ever shows the drag fallback. Fuller notes are in [docs/ios-build.md](docs/ios-build.md).

### Rebuilding the star data

`npm run data` runs the Python scripts in `tools/` to regenerate the JSON in `packages/web/public/data/`. You only need it to change the magnitude limit or pull newer source data. The generated files are committed, so a normal build never touches Python.

### Deploying

Every push to `main` builds and publishes to GitHub Pages, then force-pushes every branch and tag to the GitLab mirror at [gitlab.com/Ramskandh-Thirandasu/star-gaze](https://gitlab.com/Ramskandh-Thirandasu/star-gaze), which publishes GitLab Pages from the same commit.

The sync only goes one way, so anything committed directly in GitLab gets overwritten by the next push from GitHub, `.gitlab-ci.yml` included. Edit that file here rather than in GitLab's web IDE.

Both hosts serve the same bundle unmodified. The Vite `base` is `./` and the manifest and service worker use relative paths, so the app doesn't care whether it's served from `/stargaze/` or `/star-gaze/`.

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

The worst is Saturn, at about a quarter of a Moon width. A phone compass is usually 5 to 15 degrees off, which is 18,000 to 54,000 arcseconds, or 10 to 30 Moon widths. The hardware error is hundreds of times bigger than anything the maths adds, which is why I built calibration before adding more catalogue data.

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

Gzipped, the whole data set is about 180 KB, most of it the star catalogue. Small enough to ship offline, which is the point. The reference positions used in the tests come from [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/).

## AI usage

I designed and built this myself. The architecture, the positioning maths, the sensor handling, the rendering and the tests are my work. I read the JPL documentation and the catalogue formats, made the decisions, and did the debugging.

I used an AI coding assistant along the way, mostly for moving around the codebase and routine edits. It made me faster. It didn't design the app, and I can explain any part of it.

## License

MIT, see [LICENSE](LICENSE). The bundled datasets keep their own licenses, listed above and in [NOTICE.md](NOTICE.md).
