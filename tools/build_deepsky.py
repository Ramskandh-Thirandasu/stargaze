"""Emit deepsky.json: the Messier objects a person could plausibly find.

Same shape as stars.json -- a header plus parallel arrays, sorted
brightest-first -- for the same reason: the client slices rather than filters.

Only down to MAG_LIMIT. The full Messier list is a telescope target list, and
drawing a marker over a magnitude 11 galaxy would be a label over blank sky.
"""

from __future__ import annotations

import sys

from common import log, rounded, write_json
from sources import OPENNGC_LICENSE, iter_messier

# Where "you might actually see this" runs out.
#
# 6.0 is the classic naked-eye limit under a genuinely dark sky. It is a
# magnitude and a half past where the star catalogue stops (4.5, what a phone
# camera records handheld), and deliberately so: a deep-sky object is extended,
# so its light is spread out and its listed integrated magnitude flatters it.
# Anything fainter than this is a binocular or telescope object and has no
# business being drawn on a phone screen over open sky.
MAG_LIMIT = 6.0


def main() -> int:
    log("build_deepsky")

    objects = [obj for obj in iter_messier() if obj.mag <= MAG_LIMIT]
    objects.sort(key=lambda o: (o.mag, o.messier))

    named = sum(1 for o in objects if o.name)

    payload = {
        "epoch": "J2000",
        "magLimit": MAG_LIMIT,
        "count": len(objects),
        "order": "magnitude ascending",
        "units": {"ra": "degrees", "dec": "degrees", "major": "arcminutes", "minor": "arcminutes"},
        "source": OPENNGC_LICENSE,
        "m": [o.messier for o in objects],
        # 0 where the object has no NGC number at all -- the Pleiades, and the
        # two Messier entries that only ever got an IC designation.
        "ngc": [o.ngc for o in objects],
        # "" rather than omitted, so every array stays the same length and the
        # client can index across all of them with one loop counter.
        "name": [o.name for o in objects],
        "type": [o.kind for o in objects],
        "ra": [rounded(o.ra_deg, 4) for o in objects],
        "dec": [rounded(o.dec_deg, 4) for o in objects],
        "mag": [rounded(o.mag, 2) for o in objects],
        "major": [rounded(o.major_arcmin, 1) for o in objects],
        "minor": [rounded(o.minor_arcmin, 1) for o in objects],
    }
    write_json(
        "deepsky.json",
        payload,
        note=f"{len(objects)} Messier objects to magnitude {MAG_LIMIT}, {named} with a common name",
    )

    missing = [o.messier for o in objects if o.major_arcmin <= 0]
    if missing:
        log(f"  WARNING no apparent size for M{', M'.join(str(m) for m in missing)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
