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
| `stars.json` | 19 KB | 1,009 stars to magnitude 4.5 — parallel arrays incl. proper motion, brightest first |
| `names.json` | 13 KB | 929 designations, 291 proper names, distances |
| `constellations.json` | 5 KB | 88 IAU figures, 843 segments, as HIP polylines |
| `deepsky.json` | 1 KB | 29 Messier objects to magnitude 6 — position, type, magnitude, both axes |
| `planets.json` | 1 KB | Keplerian elements + per-century rates for 8 planets |
| `declination.json` | 19 KB | 35×72 grid: declination + yearly rate + total field intensity |

**~58 KB gzipped for the entire photographable sky.** Small enough that the
service worker precaches all of it without thinking about it.

## Sources

| Data | Source | Licence |
|---|---|---|
| Star positions, magnitudes, B−V, names | [HYG v4.0](https://github.com/astronexus/HYG-Database) (Hipparcos/Yale/Gliese) | CC BY-SA 4.0 |
| Constellation figures | [Stellarium](https://github.com/Stellarium/stellarium) sky culture `modern_iau` | CC BY-SA 4.0 |
| Deep-sky objects (Messier) | [OpenNGC](https://github.com/mattiaverga/OpenNGC) — Mattia Verga | CC BY-SA 4.0 |
| Planetary elements | [JPL SSD, *Approximate Positions of the Planets*](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Public domain (US Gov) |
| Magnetic declination | [IGRF-14](https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt) coefficients | Free use (IAGA) |

All five are free to use. Credits live in `NOTICE.md` at the repo root; show
that list in the app's about screen.

## Notes on each build

### `build_stars.py`
Parallel arrays (`hip`, `ra`, `dec`, `mag`, `ci`) rather than an array of
objects, so the client can load them straight into typed arrays and transform
all of them in one pass per frame. Right ascension is converted from HYG's
**hours** to degrees. Sorted brightest-first, so applying a magnitude cutoff is
a slice rather than a filter.

The cutoff is **magnitude 4.5** — what a phone can plausibly record handheld
from the ground, not the 5.5 a dark-adapted eye reaches. 89 stars fainter than
that ship anyway because constellation lines pass through them; without that,
figures render with gaps. All 88 constellations come out complete, which the
test suite asserts.

Duplicate HIP rows (components of the same multiple system) collapse to the
brightest, so a double doesn't draw as two overlapping dots. One star needs an
explicit patch: HYG carries ξ Ursae Majoris without a Hipparcos number (it files
it under Gliese 423), so `HD_TO_HIP` in `sources.py` rejoins the two — otherwise
Ursa Major, of all things, draws with a gap.

### `build_deepsky.py`
The Messier catalogue, cut at **magnitude 6.0** — the classic naked-eye limit
under a dark sky. That is a magnitude and a half past where the star catalogue
stops, and deliberately so: the full list of 110 is a telescope target list, and
a marker drawn over a magnitude 11 galaxy is a label over blank sky. 29 objects
survive the cut. The app gates them further against the user's own magnitude
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
  worth reviewing and rebuilding (`npm run data`).

Both open a GitHub issue on failure instead of failing silently.
