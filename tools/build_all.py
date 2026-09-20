"""Run every data build in order.

    python tools/build_all.py

Downloads are cached under tools/.cache, so re-runs are offline and fast.
"""

from __future__ import annotations

import sys
import time

import build_constellations
import build_declination
import build_deepsky
import build_planets
import build_stars
from common import DATA_DIR, ROOT, log

STEPS = [
    ("stars", build_stars.main),
    ("constellations", build_constellations.main),
    ("deepsky", build_deepsky.main),
    ("planets", build_planets.main),
    ("declination", build_declination.main),
]


def main() -> int:
    started = time.time()
    failed: list[str] = []

    for name, run in STEPS:
        try:
            if run() != 0:
                failed.append(name)
        except Exception as exc:  # keep going; one bad source should not block the rest
            log(f"  ERROR {name}: {type(exc).__name__}: {exc}")
            failed.append(name)
        log("")

    total = sum(p.stat().st_size for p in DATA_DIR.glob("*.json")) if DATA_DIR.exists() else 0
    log(f"data -> {DATA_DIR.relative_to(ROOT)}  ({total:,} bytes across {len(list(DATA_DIR.glob('*.json')))} files)")
    log(f"took {time.time() - started:.1f}s")

    if failed:
        log(f"FAILED: {', '.join(failed)}")
        return 1

    log("all builds ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
