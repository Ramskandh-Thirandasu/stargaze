"""Emit asteroids.json: the four minor planets bright enough to look for.

Vesta reaches magnitude 5.1 at a good opposition, which is a naked-eye object
under a dark sky. Ceres, Pallas and Juno need binoculars but sit inside the
catalogue's 6.5 ceiling at their best, so the app can point at them and say
honestly how faint they are.

Elements come from JPL's Small-Body Database as a single osculating solution,
not a fitted polynomial like the planets get. That difference is the whole
reason this file carries a validity window: see VALID_YEARS.

The output is shaped exactly like planets.json's entries -- elements plus
per-century rates -- so the client reuses the same Kepler solver rather than
growing a second one. The only translation this script does is the one that
shape needs: SBDB quotes a mean anomaly at its own solution epoch, and the
client's propagator counts from J2000, so the mean longitude is carried back.
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

from common import DATA_DIR, log, rounded, write_json

SBDB = "https://ssd-api.jpl.nasa.gov/sbdb.api"
SBDB_LICENSE = "Public domain (US Gov) - JPL Small-Body Database"

# Julian date of J2000.0, the epoch everything downstream counts from.
J2000 = 2451545.0
DAYS_PER_CENTURY = 36525.0

# The four that were discovered first and are still the brightest: everything
# after Juno is fainter than magnitude 7 at every opposition, which is past
# where the app would be drawing a marker over sky nobody can see anything in.
BODIES = ["1 Ceres", "2 Pallas", "3 Juno", "4 Vesta"]

# How far either side of the solution epoch this is honest for.
#
# A single osculating ellipse ignores Jupiter, which is the dominant
# perturbation on a main-belt orbit; the error grows roughly linearly out from
# the epoch rather than staying flat the way JPL's fitted planetary elements
# do. Five years each way keeps the worst case inside a few arcminutes --
# measured against Horizons in packages/core/test/ephemeris.test.ts, which is
# what this number is actually answerable to. Widen it there first.
VALID_YEARS = 5


def sbdb(designation: str) -> dict:
    """One body's orbit and physical parameters from the SBDB API.

    Not routed through common.fetch: that caches by filename for the bulk
    catalogue downloads, and these are four small queries whose freshness is
    the entire point of re-running the script.
    """
    query = urllib.parse.urlencode(
        {"sstr": designation, "full-prec": "true", "phys-par": "true"}
    )
    request = urllib.request.Request(
        f"{SBDB}?{query}", headers={"User-Agent": "stargaze-data-pipeline/1.0"}
    )
    log(f"  fetch   {designation}")
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def main() -> int:
    log("build_asteroids")

    asteroids: dict[str, dict] = {}
    epochs: set[float] = set()

    for designation in BODIES:
        payload = sbdb(designation)
        orbit = payload["orbit"]

        # The elements are only interchangeable with the planets' if they are
        # referred to the same frame. They are, but an unchecked assumption
        # here would be a silent few-arcminute error rather than a failure.
        if orbit.get("equinox") != "J2000":
            log(f"  ERROR {designation}: elements are {orbit.get('equinox')}, not J2000")
            return 1

        elements = {e["name"]: float(e["value"]) for e in orbit["elements"]}
        physical = {p["name"]: p["value"] for p in payload.get("phys_par", [])}

        if "H" not in physical:
            log(f"  ERROR {designation}: no absolute magnitude in the SBDB reply")
            return 1

        epoch = float(orbit["epoch"])
        epochs.add(epoch)

        # SBDB gives argument of perihelion and mean anomaly; the client's
        # element set wants longitude of perihelion and mean longitude.
        longitude_of_perihelion = elements["om"] + elements["w"]
        mean_longitude_at_epoch = longitude_of_perihelion + elements["ma"]

        # Carry the mean longitude back to J2000 so the client can propagate it
        # with the same (jd - J2000) / century it uses for the planets. Only
        # the mean longitude moves: a two-body solution holds the rest fixed,
        # which is exactly what makes the validity window above necessary.
        mean_motion = elements["n"]  # deg/day
        mean_longitude_j2000 = (
            mean_longitude_at_epoch - mean_motion * (epoch - J2000)
        ) % 360.0

        # Six digits on angles is a thousandth of an arcsecond, far below what
        # the two-body model is worth -- but these are seven-digit numbers,
        # and truncating the mean longitude is the one that turns into a
        # position error straight away.
        asteroids[designation.split(" ", 1)[1]] = {
            "designation": designation,
            "elements": {
                "a": rounded(elements["a"], 9),
                "e": rounded(elements["e"], 9),
                "i": rounded(elements["i"], 6),
                "L": rounded(mean_longitude_j2000, 6),
                "peri": rounded(longitude_of_perihelion % 360.0, 6),
                "node": rounded(elements["om"] % 360.0, 6),
            },
            # A two-body ellipse drifts in nothing but mean longitude.
            "rates": {
                "a": 0,
                "e": 0,
                "i": 0,
                "L": rounded(mean_motion * DAYS_PER_CENTURY, 6),
                "peri": 0,
                "node": 0,
            },
            # Absolute magnitude and the slope parameter of the IAU H-G phase
            # law -- a rock's brightness depends on how much of its lit face
            # is turned this way, far more sharply than a planet's does.
            "H": float(physical["H"]),
            "G": float(physical.get("G", 0.15)),
        }

    if len(epochs) != 1:
        log(f"  WARNING solution epochs differ: {sorted(epochs)}")
    epoch = max(epochs)
    epoch_year = 2000.0 + (epoch - J2000) / 365.25

    payload = {
        "source": "JPL Solar System Dynamics, Small-Body Database",
        "url": "https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html",
        "licence": SBDB_LICENSE,
        "solutionEpoch": epoch,
        "validFrom": int(epoch_year) - VALID_YEARS,
        "validTo": int(epoch_year) + VALID_YEARS,
        "epoch": "J2000 (JD 2451545.0)",
        "elementOrder": ["a", "e", "i", "L", "peri", "node"],
        "units": {
            "a": "au",
            "e": "dimensionless",
            "i": "degrees",
            "L": "degrees (mean longitude, carried back to J2000)",
            "peri": "degrees (longitude of perihelion)",
            "node": "degrees (longitude of ascending node)",
            "rates": "per Julian century",
            "H": "absolute magnitude",
            "G": "IAU H-G slope parameter",
        },
        "asteroids": asteroids,
    }

    write_json(
        "asteroids.json",
        payload,
        note=f"{len(asteroids)} bodies, valid {payload['validFrom']}-{payload['validTo']}",
    )

    # A cheap guard against having parsed the wrong field: Vesta's orbit is
    # the innermost of the four and its semi-major axis has not moved in the
    # two centuries anyone has been measuring it.
    vesta = asteroids["Vesta"]["elements"]["a"]
    if not (2.3 < vesta < 2.4):
        log(f"  WARNING Vesta semi-major axis {vesta} au is not the expected ~2.36")

    return 0


if __name__ == "__main__":
    sys.exit(main())
