"""Fetch reference positions from JPL Horizons as test fixtures.

The astronomy in `packages/core` is only trustworthy if something independent
agrees with it. This queries JPL Horizons for the Sun, Moon and planets at
several epochs and writes the answers to
`packages/core/test/fixtures/horizons.json`, which the test suite asserts
against.

Run once; the fixture is committed, so the tests stay offline.

    python tools/fetch_reference.py
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

from common import ROOT, log

API = "https://ssd.jpl.nasa.gov/api/horizons.api"

FIXTURE = ROOT / "packages" / "core" / "test" / "fixtures" / "horizons.json"

# Horizons body ids.
BODIES = {
    "Sun": "10",
    "Mercury": "199",
    "Venus": "299",
    "Mars": "499",
    "Jupiter": "599",
    "Saturn": "699",
    "Uranus": "799",
    "Neptune": "899",
}

MOON = "301"

# The bright minor planets. Horizons takes a small-body record number with a
# trailing semicolon; without it, "1" is Mercury's barycentre rather than Ceres,
# which is the kind of mistake that produces plausible-looking wrong numbers.
ASTEROIDS = {
    "Ceres": "1;",
    "Pallas": "2;",
    "Juno": "3;",
    "Vesta": "4;",
}

# Asteroid epochs are their own list because the elements are a single
# osculating solution with a validity window (see tools/build_asteroids.py),
# and the planetary epochs deliberately run out to 2045 to exercise the edge of
# JPL's fitted range. Testing a two-body asteroid solution there would only
# prove it degrades, which is already documented.
ASTEROID_EPOCHS = [
    "2024-03-15 22:00",
    "2026-01-08 19:45",
    "2027-09-30 11:15",
    "2030-05-22 04:10",
]

# Spread across the seasons and across two decades, so a term that only
# matters at one point in an orbit -- or only shows up decades from the
# original four dates -- cannot hide. The range stays inside 1800-2050, where
# JPL's element set is valid; going further would be testing extrapolation
# the model never claimed to support.
EPOCHS = [
    "2021-11-02 08:20",
    "2024-03-15 22:00",
    "2025-06-21 03:30",
    "2026-01-08 19:45",
    "2027-09-30 11:15",
    "2045-07-14 15:50",
]

# An arbitrary but real observing site, for the Moon's topocentric test.
SITE = {"name": "Bengaluru", "lat": 12.9716, "lon": 77.5946, "elevation_km": 0.92}


def one_minute_later(when: str) -> str:
    """Horizons insists the stop time be strictly after the start time."""
    moment = datetime.strptime(when, "%Y-%m-%d %H:%M")
    return (moment + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M")


def query(params: dict[str, str]) -> str:
    """Call the Horizons API and return the ephemeris text."""
    full = {
        "format": "json",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "OBSERVER",
        "ANG_FORMAT": "DEG",
        "CSV_FORMAT": "YES",
        "OBJ_DATA": "NO",
        "STEP_SIZE": "1m",
        **params,
    }
    url = f"{API}?{urllib.parse.urlencode(full)}"
    request = urllib.request.Request(url, headers={"User-Agent": "stargaze-tests"})
    with urllib.request.urlopen(request, timeout=120) as response:
        payload = json.load(response)
    return payload["result"]


def first_row(result: str) -> list[str]:
    """Pull the first data row out of the $$SOE / $$EOE block."""
    inside = False
    for line in result.splitlines():
        if line.startswith("$$SOE"):
            inside = True
            continue
        if line.startswith("$$EOE"):
            break
        if inside and line.strip():
            return [cell.strip() for cell in line.split(",")]
    raise ValueError("no ephemeris rows in the Horizons reply")


def geocentric_astrometric(body: str, when: str) -> tuple[float, float]:
    """Astrometric J2000 RA/Dec as seen from the Earth's centre."""
    result = query(
        {
            "COMMAND": f"'{body}'",
            "CENTER": "'500@399'",
            "START_TIME": f"'{when}'",
            "STOP_TIME": f"'{one_minute_later(when)}'",
            "QUANTITIES": "'1'",
        }
    )
    row = first_row(result)
    # Columns: date, (solar presence), (lunar presence), RA, Dec
    numbers = [c for c in row[1:] if _is_number(c)]
    return float(numbers[0]), float(numbers[1])


def topocentric_apparent(body: str, when: str) -> tuple[float, float]:
    """Apparent RA/Dec of date, from the observing site on the surface."""
    result = query(
        {
            "COMMAND": f"'{body}'",
            "CENTER": "'coord@399'",
            "COORD_TYPE": "'GEODETIC'",
            "SITE_COORD": f"'{SITE['lon']},{SITE['lat']},{SITE['elevation_km']}'",
            "START_TIME": f"'{when}'",
            "STOP_TIME": f"'{one_minute_later(when)}'",
            "QUANTITIES": "'2'",
        }
    )
    row = first_row(result)
    numbers = [c for c in row[1:] if _is_number(c)]
    return float(numbers[0]), float(numbers[1])


def _is_number(cell: str) -> bool:
    try:
        float(cell)
        return True
    except ValueError:
        return False


def main() -> int:
    log("fetch_reference (JPL Horizons)")

    fixture: dict[str, object] = {
        "source": "JPL Horizons",
        "url": API,
        "note": (
            "Geocentric entries are astrometric J2000 (Horizons quantity 1). "
            "Moon entries are apparent coordinates of date (quantity 2), "
            "topocentric from the site below."
        ),
        "site": SITE,
        "epochs": EPOCHS,
        "asteroidEpochs": ASTEROID_EPOCHS,
        "geocentric": {},
        "asteroids": {},
        "moonTopocentric": {},
        "moonGeocentric": {},
    }

    for name, body in BODIES.items():
        rows = []
        for when in EPOCHS:
            ra, dec = geocentric_astrometric(body, when)
            rows.append({"utc": when, "ra": ra, "dec": dec})
            log(f"  {name:9} {when}  RA {ra:10.5f}  Dec {dec:+9.5f}")
        fixture["geocentric"][name] = rows  # type: ignore[index]

    for name, body in ASTEROIDS.items():
        rows = []
        for when in ASTEROID_EPOCHS:
            ra, dec = geocentric_astrometric(body, when)
            rows.append({"utc": when, "ra": ra, "dec": dec})
            log(f"  {name:9} {when}  RA {ra:10.5f}  Dec {dec:+9.5f}")
        fixture["asteroids"][name] = rows  # type: ignore[index]

    moon_topo = []
    moon_geo = []
    for when in EPOCHS:
        ra, dec = topocentric_apparent(MOON, when)
        moon_topo.append({"utc": when, "ra": ra, "dec": dec})
        log(f"  {'Moon/topo':9} {when}  RA {ra:10.5f}  Dec {dec:+9.5f}")

        result = query(
            {
                "COMMAND": f"'{MOON}'",
                "CENTER": "'500@399'",
                "START_TIME": f"'{when}'",
                "STOP_TIME": f"'{one_minute_later(when)}'",
                "QUANTITIES": "'2'",
            }
        )
        row = first_row(result)
        numbers = [c for c in row[1:] if _is_number(c)]
        moon_geo.append({"utc": when, "ra": float(numbers[0]), "dec": float(numbers[1])})

    fixture["moonTopocentric"] = moon_topo
    fixture["moonGeocentric"] = moon_geo

    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    log(f"  wrote   {FIXTURE.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
