"""Upstream catalogue sources, and the parsing each one needs.

Both star positions and constellation figures are read here because
`build_stars.py` needs to know which stars the constellation lines reference:
a line vertex that is fainter than the magnitude cutoff must still ship, or the
figure comes out with holes in it.
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Iterator, NamedTuple

from common import fetch

# HYG v4.0 — Hipparcos/Yale/Gliese merge. The GitHub copy is frozen but intact;
# the maintained repo moved to Codeberg and serves its CSVs through Git LFS,
# which is not worth the fragility for positions that do not change.
HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz"
HYG_FILE = "hygdata_v40.csv.gz"
HYG_LICENSE = "CC BY-SA 4.0 - HYG Database, David Nash / astronexus"

# Stellarium's IAU sky culture: the 88 official constellations as polylines of
# HIP numbers. Stellarium replaced the old constellationship.fab files with a
# single index.json per sky culture.
SKYCULTURE_URL = "https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern_iau/index.json"
SKYCULTURE_FILE = "modern_iau.json"
SKYCULTURE_LICENSE = "CC BY-SA 4.0 - Stellarium sky culture 'modern_iau'"


# A handful of stars reach HYG without a Hipparcos number, because HYG
# catalogues them under another designation. Stellarium's constellation lines
# still refer to them by HIP, so the figure breaks unless the two are rejoined.
#
# HD number -> the HIP number Stellarium uses.
HD_TO_HIP = {
    98231: 55203,  # Xi Ursae Majoris (Alula Australis) -- HYG files it as Gl 423
}


class Star(NamedTuple):
    hip: int
    ra_deg: float       # J2000 right ascension, degrees
    dec_deg: float      # J2000 declination, degrees
    mag: float          # apparent visual magnitude
    ci: float           # B-V colour index (0.0 when the catalogue has none)
    proper: str         # proper name, or ""
    bayer: str          # Bayer designation, or ""
    flamsteed: str      # Flamsteed number, or ""
    con: str            # IAU 3-letter constellation abbreviation, or ""
    dist_pc: float      # distance in parsecs (0.0 when unknown)
    pmra_masyr: float   # proper motion in RA, mas/yr, times cos(dec) (0.0 when unknown)
    pmdec_masyr: float  # proper motion in Dec, mas/yr (0.0 when unknown)


def _float(value: str, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def iter_hyg() -> Iterator[Star]:
    """Yield every HYG row that has a usable HIP number and position."""
    text = fetch(HYG_URL, HYG_FILE, decompress=True).decode("utf-8", "replace")
    reader = csv.DictReader(io.StringIO(text))

    for row in reader:
        hip_raw = row.get("hip", "").strip()
        if hip_raw:
            try:
                hip = int(hip_raw)
            except ValueError:
                continue
        else:
            # No HIP number: keep it only if it is one of the stars a
            # constellation line needs (see HD_TO_HIP).
            try:
                hd = int(row.get("hd", "").strip())
            except ValueError:
                continue
            hip = HD_TO_HIP.get(hd, 0)
            if not hip:
                continue

        mag_raw = row.get("mag", "").strip()
        if not mag_raw:
            continue

        # HYG stores right ascension in HOURS. Everything downstream is degrees.
        yield Star(
            hip=hip,
            ra_deg=_float(row["ra"]) * 15.0,
            dec_deg=_float(row["dec"]),
            mag=_float(mag_raw),
            ci=_float(row.get("ci", "")),
            proper=row.get("proper", "").strip(),
            bayer=row.get("bayer", "").strip(),
            flamsteed=row.get("flam", "").strip(),
            con=row.get("con", "").strip(),
            dist_pc=_float(row.get("dist", "")),
            pmra_masyr=_float(row.get("pmra", "")),
            pmdec_masyr=_float(row.get("pmdec", "")),
        )


class Constellation(NamedTuple):
    abbr: str                     # "Ori"
    name: str                     # "Orion" -- the Latin IAU name
    common: str                   # "Hunter" -- the English translation, or ""
    lines: list[list[int]]        # polylines of HIP numbers


def load_constellations() -> list[Constellation]:
    """Parse Stellarium's IAU sky culture into constellation polylines."""
    raw = json.loads(fetch(SKYCULTURE_URL, SKYCULTURE_FILE).decode("utf-8"))
    out: list[Constellation] = []

    for entry in raw.get("constellations", []):
        # ids look like "CON modern_iau Ori"
        match = re.search(r"([A-Za-z]{3})$", entry.get("id", ""))
        if not match:
            continue

        # Stellarium's "native" is the Latin IAU name (Orion, Ursa Major) and
        # "english" is the translation (Hunter, Great Bear). The Latin name is
        # the label; the translation is a nice secondary line, not a substitute.
        names = entry.get("common_name") or {}
        native = names.get("native") or ""
        english = names.get("english") or ""
        name = native or english or match.group(1)
        common = english if english and english != name else ""

        lines = [
            [int(h) for h in polyline]
            for polyline in entry.get("lines", [])
            if len(polyline) >= 2
        ]
        if lines:
            out.append(Constellation(abbr=match.group(1), name=name, common=common, lines=lines))

    return sorted(out, key=lambda c: c.abbr)


def constellation_line_hips() -> set[int]:
    """Every HIP number a constellation figure draws through."""
    return {hip for c in load_constellations() for line in c.lines for hip in line}


# OpenNGC -- the NGC/IC catalogue as a plain semicolon-separated CSV, actively
# maintained and versioned in git. Picked over scraping SEDS or Wikipedia
# because it carries type, axes and magnitudes in one consistent schema, and
# because a CSV in a git repo is a stable thing to build against.
#
# `addendum.csv` holds the objects that are in neither the NGC nor the IC --
# the Pleiades most of all, which is the brightest Messier object there is.
OPENNGC_URL = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv"
OPENNGC_FILE = "openngc.csv"
OPENNGC_ADDENDUM_URL = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv"
OPENNGC_ADDENDUM_FILE = "openngc_addendum.csv"
OPENNGC_LICENSE = "CC BY-SA 4.0 - OpenNGC, Mattia Verga"

# OpenNGC's type codes, collapsed to the handful of words a person would
# actually use. The distinctions this drops (emission versus reflection
# nebula, galaxy pair versus triplet) are real, but they are not what someone
# standing in a field pointing a phone at a smudge is asking.
#
# SNR folds into "nebula" rather than earning its own word: exactly one
# Messier object is one (M1, the Crab), so "supernova remnant" would be a
# vocabulary entry with a single member.
OPENNGC_TYPES = {
    "G": "galaxy",
    "GPair": "galaxy",
    "GTrpl": "galaxy",
    "GGroup": "galaxy",
    "GCl": "globular",
    "OCl": "cluster",
    "*Ass": "cluster",
    "Cl+N": "nebula",
    "Neb": "nebula",
    "EmN": "nebula",
    "RfN": "nebula",
    "HII": "nebula",
    "SNR": "nebula",
    "PN": "planetary",
    "**": "star",
    "*": "star",
    "Other": "star",
}


# OpenNGC lists common names alphabetically, so for M11 the French name sorts
# ahead of the one an English-speaking user would recognise.
#
# Messier number -> the name to use instead of the first one listed.
MESSIER_NAMES = {
    11: "Wild Duck Cluster",
}


class DeepSky(NamedTuple):
    messier: int         # Messier number, 1-110
    ngc: int             # NGC number, or 0 when the object has none
    name: str            # common name, or ""
    kind: str            # one of OPENNGC_TYPES' values
    ra_deg: float        # J2000 right ascension, degrees
    dec_deg: float       # J2000 declination, degrees
    mag: float           # apparent visual magnitude
    major_arcmin: float  # apparent size along the long axis
    minor_arcmin: float  # ... and the short one; equal to major when round


def _sexagesimal(value: str, per_unit: float) -> float:
    """"HH:MM:SS.SS" or "+DD:MM:SS.S" to a single number.

    `per_unit` is what one leading unit is worth in degrees: 15 for hours of
    right ascension, 1 for degrees of declination. The sign has to come off
    before the split, or "-00:49:23" comes out positive -- the minus lives on
    a degrees field that is already zero.
    """
    text = value.strip()
    sign = -1.0 if text.startswith("-") else 1.0
    units, minutes, seconds = (_float(part) for part in text.lstrip("+-").split(":"))
    return sign * (units + minutes / 60.0 + seconds / 3600.0) * per_unit


def iter_messier() -> Iterator[DeepSky]:
    """Yield the Messier objects, from OpenNGC's NGC and addendum files."""
    seen: set[int] = set()

    for url, filename in (
        (OPENNGC_URL, OPENNGC_FILE),
        (OPENNGC_ADDENDUM_URL, OPENNGC_ADDENDUM_FILE),
    ):
        text = fetch(url, filename).decode("utf-8", "replace")

        for row in csv.DictReader(io.StringIO(text), delimiter=";"):
            messier = row.get("M", "").strip()
            if not messier:
                continue
            # OpenNGC files M102 as a duplicate row pointing back at M101,
            # which is the modern reading of a 250-year-old bookkeeping error.
            # Keeping it would draw one galaxy twice under two names.
            if row["Type"] == "Dup":
                continue

            number = int(messier)
            if number in seen:
                continue
            seen.add(number)

            designation = row["Name"].strip()
            major = _float(row.get("MajAx", ""))
            # Some entries carry no minor axis, because they are round enough
            # that nobody measured one.
            minor = _float(row.get("MinAx", "")) or major

            yield DeepSky(
                messier=number,
                ngc=int(designation[3:]) if designation.startswith("NGC") else 0,
                # Several objects carry a comma-separated list of names; the
                # first is the one people use, bar the exceptions above.
                name=MESSIER_NAMES.get(number, row.get("Common names", "").split(",")[0].strip()),
                kind=OPENNGC_TYPES.get(row["Type"], "star"),
                ra_deg=_sexagesimal(row["RA"], 15.0),
                dec_deg=_sexagesimal(row["Dec"], 1.0),
                mag=_float(row["V-Mag"], 99.0),
                major_arcmin=major,
                minor_arcmin=minor,
            )
