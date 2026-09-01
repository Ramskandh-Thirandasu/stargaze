# StarGaze

<p align="center">
  <img src="store/cover.png" alt="StarGaze" width="100%">
</p>

**Point your phone at the night sky and it tells you what you're looking at.**

[**Try it now →**](https://ramskandh-thirandasu.github.io/stargaze/) · works in any
browser, installs like an app, and keeps working with no signal

<p align="center">
  <img src="store/screenshots/phone/1-sky.png" alt="The sky view: constellation figures, a compass strip, and readouts showing where the phone is pointed" width="300">
  <img src="store/screenshots/phone/2-tonight.png" alt="The Tonight list, ordered by what is actually visible right now" width="300">
</p>
<p align="center">
  <img src="store/screenshots/tablet-10in/1-sky.png" alt="The same app on a tablet, where the panels sit beside the sky rather than over it" width="620">
</p>

You've probably looked up, seen something bright, and wondered what it was.
Point your phone at it and StarGaze names it — the star, the planet, or the
constellation it belongs to.

No account, no sign-up, nothing to install if you don't want to. Open the link
and it works.

## How does it know?

Here's the surprising part: **it never looks at the sky.**

You might expect an app like this to photograph the sky and recognise it. That
approach barely works. A phone photo of the night sky is a nearly black square
with a few faint specks — there's almost nothing in the image to recognise.

So StarGaze does what astronomers have done for centuries: it *calculates*.
Three things are enough to know exactly what's above you:

| | |
|---|---|
| **Where you are** | The stars above India aren't the stars above Iceland. |
| **What time it is** | The sky rotates about 15° every hour, so it looks different at 9pm than at midnight. |
| **Which way you're pointing** | Your phone's compass and motion sensors already know this. |

Feed those three into some geometry and you know precisely which star sits at
any point in the sky. It's fast, it's exact, and it needs no internet.

**Everything is worked out on your phone.** Your location never leaves the
device — there's no server, no account, and no tracking of any kind.

## What you'll see

Only things you could genuinely spot yourself, standing outside.

- **1,009 stars.** The brightest ones — roughly what a phone camera can pick up
  under a properly dark sky. All 88 constellations are drawn complete.
- **Five planets** — Mercury, Venus, Mars, Jupiter and Saturn. The ones visible
  to the naked eye, as they have been for all of recorded history.
- **The Moon**, showing its current phase.

Uranus and Neptune are deliberately left out. The app knows exactly where they
are, but they're too faint to see, and a marker floating over blank sky would
just teach you not to trust the app.

For the same reason, anything technically above the horizon but drowned out by
daylight or a bright Moon is shown dimmed and labelled, rather than quietly
hidden. Knowing something is *there but invisible* is more useful than it
silently vanishing.

## What it can do

- **Works fully offline.** The whole star catalogue ships inside the app —
  about 57 KB, smaller than a single photo. Handy, given stargazing tends to
  happen away from towns and signal.
- **Camera view.** See the real sky through your camera with the star names
  drawn on top. Optional — it works fine without.
- **Compass calibration.** Phone compasses are genuinely inaccurate, typically
  off by 5–15°. Point at a bright star you can already identify, tap confirm,
  and the app corrects itself.
- **Interference warning.** Metal, speakers and cars throw compasses off badly.
  When the app detects this, it tells you instead of quietly being wrong.
- **Search** for anything by name, and a **Tonight** list of what's actually
  worth looking at right now.
- **Drag mode.** No sensors, no permissions, no phone required — just drag to
  look around. Works on a laptop.

## Try it yourself

The easiest way is [the live version](https://ramskandh-thirandasu.github.io/stargaze/) —
nothing to install.

To run the code:

```bash
npm install
npm test          # 118 tests
npm run dev       # then open http://localhost:5173
```

<details>
<summary><b>Running it on your phone during development</b></summary>

Phone browsers only allow camera, location and motion on a **secure (https)
connection**, and they fail silently otherwise — you just get a page that never
asks permission, with no error explaining why.

```bash
npm run serve     # serves over https and prints your network address
```

Your phone will warn about the certificate once. That's expected — accept it.

</details>

<details>
<summary><b>Building the Android app</b></summary>

```bash
npm run android:sync
npm run android:open
```

You'll need **JDK 21 specifically**. Newer versions fail with
`Unsupported class file major version`, including the one Android Studio ships
with. The debug app is built to
`android/app/build/outputs/apk/debug/app-debug.apk`.

</details>

## How accurate is it?

Short answer: **the astronomy is far more accurate than your phone's compass**,
so the compass is what limits it.

Positions are checked automatically against [JPL Horizons](https://ssd.jpl.nasa.gov/horizons/),
NASA's own reference system, at six dates spanning 2021–2045.

Errors are measured in **arcseconds** — an arcsecond is 1/3600th of a degree.
For scale, the full Moon is about **1,800 arcseconds** wide.

| Object | Error | Object | Error |
|---|---|---|---|
| Sun | 13.5″ | Jupiter | 368.3″ |
| Mercury | 21.7″ | Saturn | 435.0″ |
| Venus | 18.0″ | Uranus\* | 110.2″ |
| Mars | 31.7″ | Neptune\* | 34.4″ |
| Moon | 16.5″ | | |

\* Calculated and tested, but never drawn — see above.

Even the worst of these is a quarter of a Moon-width. Meanwhile a phone compass
is off by 5–15° — that's **18,000 to 54,000 arcseconds**, hundreds of times
larger.

## Project layout

```
tools/       Python scripts that prepare the star data. Never run in the app.
packages/
  core/      The astronomy maths. Pure calculation, 118 tests.
  web/       The app itself.
server/      A small https server for testing on a real phone.
android/     Wraps the same app for Android.
```

## Credits

# Credits

StarGaze computes everything on device. The catalogues below are built into the
app by `tools/`; all four are free to use, and none of them are contacted at
runtime. Show this list somewhere in the app's about screen.

| Data | Source |
|---|---|
| Star positions, magnitudes, colours, names | [HYG Database v4.0](https://github.com/astronexus/HYG-Database) — David Nash / astronexus (CC BY-SA 4.0) |
| Constellation figures | [Stellarium](https://github.com/Stellarium/stellarium) sky culture `modern_iau` (CC BY-SA 4.0) |
| Planetary elements | [NASA JPL SSD, *Approximate Positions of the Planets*](https://ssd.jpl.nasa.gov/planets/approx_pos.html) (public domain) |
| Magnetic declination | [IGRF-14](https://www.ngdc.noaa.gov/IAGA/vmod/igrf.html) — IAGA Working Group V-MOD, via NOAA NCEI (free use) |

Reference positions used to test the astronomy come from
[JPL Horizons](https://ssd.jpl.nasa.gov/horizons/).

## License

MIT — see [LICENSE](LICENSE). The bundled datasets keep their own licenses.
