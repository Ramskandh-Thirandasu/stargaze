# Data pipeline

Build-time only. These scripts fetch published astronomical data, reduce it to
what a phone needs, and write JSON into `packages/web/public/data/`. **The app
never runs Python** — it loads the generated JSON and does all the maths on
device, which is why it keeps working in a field with no signal.

```bash
python tools/build_all.py
```

Requires **Python 3.9+ and nothing else** — no pip install, no virtualenv. Every
script is stdlib-only on purpose: the output is committed, so the pipeline
should still run years from now without a dependency resolver having an opinion
about it.

Downloads are cached in `tools/.cache/` (gitignored, ~14 MB). Delete that
directory to force a refresh. Each script also runs standalone:

```bash
python tools/build_stars.py
```

## Output

| File | Size (gzip) | Contents |
|---|---|---|
| `stars.json` | 117 KB | 8,871 stars to magnitude 6.5 — parallel arrays incl. proper motion, brightest first |
| `names.json` | 35 KB | 3,073 designations, 345 proper names, distances |
| `constellations.json` | 5 KB | 88 IAU figures, 843 segments, as HIP polylines |
| `deepsky.json` | 1 KB | 29 Messier objects to magnitude 6 — position, type, magnitude, both axes |
| `planets.json` | 1 KB | Keplerian elements + per-century rates for 8 planets |
| `asteroids.json` | <1 KB | Osculating elements + H/G for Ceres, Pallas, Juno, Vesta |
| `declination.json` | 18 KB | 35×72 grid: declination + yearly rate + total field intensity |

**~177 KB gzipped for the whole naked-eye sky**, up from ~58 KB when the star
catalogue stopped at magnitude 4.5. Nine times the stars for three times the
bytes: the extra ones are faint, so their proper motions round to zero and
compress almost to nothing. Still one fetch, once, and then never again —
the service worker precaches all of it.

Meteor showers are the exception to all of this: seven radiants on fixed
dates is a table, not a catalogue, so it lives in
`packages/core/src/showers.ts` and ships as code. Nothing to download, nothing
to precache, nothing to go stale.

## Sources

| Data | Source | Licence |
|---|---|---|
| Star positions, magnitudes, B−V, names | [HYG v4.0](https://github.com/astronexus/HYG-Database) (Hipparcos/Yale/Gliese) | CC BY-SA 4.0 |
| Constellation figures | [Stellarium](https://github.com/Stellarium/stellarium) sky culture `modern_iau` | CC BY-SA 4.0 |
| Deep-sky objects (Messier) | [OpenNGC](https://github.com/mattiaverga/OpenNGC) — Mattia Verga | CC BY-SA 4.0 |
| Planetary elements | [JPL SSD, *Approximate Positions of the Planets*](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Public domain (US Gov) |
| Asteroid elements | [JPL SSD, Small-Body Database](https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html) | Public domain (US Gov) |
| Meteor shower radiants, dates, rates | [IMO Working List of Visual Meteor Showers](https://www.imo.net/resources/calendar/) | Published observational data, freely usable |
| Magnetic declination | [IGRF-14](https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt) coefficients | Free use (IAGA) |

All seven are free to use. Credits live in `NOTICE.md` at the repo root; show
that list in the app's about screen.

## Notes on each build

### `build_stars.py`
Parallel arrays (`hip`, `ra`, `dec`, `mag`, `ci`) rather than an array of
objects, so the client can load them straight into typed arrays and transform
all of them in one pass per frame. Right ascension is converted from HYG's
**hours** to degrees. Sorted brightest-first, so applying a magnitude cutoff is
a slice rather than a filter.

The cutoff is **magnitude 6.5** — the naked-eye limit under a genuinely dark,
moonless sky, and near enough what a phone in night mode records from the same
place. That is the ceiling, not the view: the app's magnitude slider defaults
to 4.5 and reaches 6.5, so a user in a town still gets the sky they can
actually see and a user in a field gets the rest of it. At this depth every
constellation vertex clears the cutoff on its own, so nothing has to be forced
in to keep the figures whole; all 88 still come out complete, which the test
suite asserts.

Positions ship to **three decimal places**, not four. That is 3.6 arcseconds,
and the renderer's narrowest field is around 60 pixels per degree — the last
digit is already a sixtieth of a pixel, and a fourth would cost 10 KB (4 KB
gzipped) to encode a difference nothing downstream can render. Proper motions
round to whole mas/yr on the same argument.

Duplicate HIP rows (components of the same multiple system) collapse to the
brightest, so a double doesn't draw as two overlapping dots. One star needs an
explicit patch: HYG carries ξ Ursae Majoris without a Hipparcos number (it files
it under Gliese 423), so `HD_TO_HIP` in `sources.py` rejoins the two — otherwise
Ursa Major, of all things, draws with a gap.

### `build_deepsky.py`
The Messier catalogue, cut at **magnitude 6.0** — half a magnitude shy of where
the star catalogue stops, and deliberately so: these are extended objects, and
an integrated magnitude flatters them because the same light is spread across a
patch of sky rather than concentrated in a point. The full list of 110 is a
telescope target list, and a marker drawn over a magnitude 11 galaxy is a label
over blank sky. 29 objects survive the cut. The app gates them further against the user's own magnitude
setting, the same way it gates stars.

Positions come as sexagesimal strings and are converted here; the sign has to
come off the declination before the field split, or `-00:49:23` parses as
*north* of the equator. Sizes ship as **both** axes — M31 is 178′ × 70′, and
rendering it as a circle would be wrong by a factor of three.

OpenNGC files M102 as a duplicate row pointing at M101, which is the modern
reading of a 250-year-old bookkeeping error, so the catalogue holds 109
distinct objects rather than 110. It also lists common names alphabetically,
which puts the French name for M11 ahead of "Wild Duck Cluster";
`MESSIER_NAMES` in `sources.py` overrides that one entry.

### `build_planets.py`
Scraped from JPL rather than transcribed by hand: one mistyped digit in a
per-century rate is a bug you would chase for a very long time. The page carries
two tables and this takes the **1800–2050** fit (identified by Neptune's
negative mean longitude), accurate to roughly an arcminute. That is far better
than a phone compass, so it is nowhere near the limiting factor.

### `build_asteroids.py`
Four bodies, from JPL's Small-Body Database rather than the planets' page:
Vesta (magnitude 5.1 at a good opposition, genuinely naked-eye), Ceres (~6.6),
Pallas and Juno. Emitted in exactly the same element-plus-rates shape the
planets use, so the client solves them with the same Kepler code instead of
growing a second copy of it. The one translation the script does is the one
that shape needs: SBDB quotes a mean anomaly at its own solution epoch, and
the client counts from J2000, so the mean longitude is carried back.

This is the only generated file with a **validity window**, and the reason is
real. The planets get a polynomial fitted across 1800–2050; an asteroid gets a
single osculating ellipse with no Jupiter term in it, so its error grows
quadratically away from the solution epoch instead of staying flat. Measured
against Horizons: about 5″ at the epoch, ~60″ a year and a half out, 806″
(13′) four years out. That is still well inside the several degrees a phone
compass contributes, but it is not nothing, so `asteroids.json` carries
`validFrom`/`validTo` and the app says so on the info card once the clock is
past them. Re-run this script to move the window.

`live-verify.test.ts` re-checks all four against a fresh Horizons epoch on the
monthly CI schedule; that is the thing that will actually notice the elements
ageing out.

### `build_declination.py`
The one that earns its keep. A magnetometer points at **magnetic** north; the
sky is indexed from **true** north. The difference reaches 20°+ in populated
places, so skipping it doesn't nudge the overlay — it puts the wrong
constellation under the crosshair.

Uses **IGRF-14**, not the WMM, because NOAA puts the WMM coefficient file behind
a survey form while IGRF's are served openly. The two agree on declination to a
small fraction of a degree, far inside the magnetometer's own error.

The script evaluates the degree-13 spherical harmonic expansion (Schmidt
quasi-normalised, with the geodetic→geocentric correction) and checks itself
against NOAA's published WMM2025 test values on every run — currently **0.037°
worst deviation**, which is the model-to-model difference rather than
implementation error. If that number ever jumps, the harmonic sum broke.

The grid stops at ±85° latitude: declination changes far too fast near the
magnetic poles for bilinear interpolation to mean anything, and a compass is
useless there regardless. The client should fall back to an uncorrected heading
with a warning outside that band.

Also emits `validUntil` (the model epoch plus 5 years, IGRF's own
secular-variation forecast window). The client checks the device clock
against it and flags the correction as stale rather than quietly
extrapolating past the window the model actually claims.

## Keeping the data honest over time

Fixtures and coefficient files verify a moment in time; sources move and
models expire. Two things run in CI on a schedule (`.github/workflows/
verify-sources.yml`, monthly) rather than only once at commit time:

- `packages/core/test/live-verify.test.ts` re-checks the ephemeris against a
  **fresh** JPL Horizons epoch (today, not a committed fixture date) — set
  `LIVE_VERIFY=1` to run it locally. Skipped by default so `npm test` stays
  offline.
- `check_catalogue_hashes.py` fetches the HYG and Stellarium sources fresh
  (bypassing `tools/.cache/`) and compares their hashes against
  `tools/source-hashes.json`. A changed hash doesn't fail the app — it means
  the committed catalogue was built from an older copy of the source and is
  worth reviewing and rebuilding (`npm run data`). The SBDB is deliberately
  not hashed: it is an API whose reply carries a solution id that changes on
  every new orbit fit, so it would report a change every month and mean
  nothing. The live asteroid checks above are the signal that matters there —
  they fail on a position being wrong, not on a byte moving.

Both open a GitHub issue on failure instead of failing silently.
