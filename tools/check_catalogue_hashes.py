"""Detect whether the upstream HYG or Stellarium sky-culture source has
changed since tools/source-hashes.json was last updated.

Meant to run on a schedule (see .github/workflows/verify-sources.yml). A
changed hash does not mean anything in the app is wrong -- it means the
committed catalogue in packages/web/public/data/ was built from an older
copy of the source and might be worth rebuilding (`npm run data`). This is
a report, never a gate on the app itself, and never runs at app runtime --
CI only, same as fetch_reference.py.

Always bypasses tools/.cache/: the point is to see what upstream has right
now, not what was cached the last time someone ran the data pipeline.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request

from common import ROOT, log

HASHES_FILE = ROOT / "tools" / "source-hashes.json"
USER_AGENT = "stargaze-source-check/1.0"

SOURCES = {
    "hyg": "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz",
    "stellarium_modern_iau": "https://raw.githubusercontent.com/Stellarium/stellarium/master/skycultures/modern_iau/index.json",
    "openngc": "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv",
    "openngc_addendum": "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/addendum.csv",
}


def fetch_hash(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=120) as response:
        return hashlib.sha256(response.read()).hexdigest()


def main() -> int:
    known = json.loads(HASHES_FILE.read_text()) if HASHES_FILE.exists() else {}
    changed: list[str] = []

    for name, url in SOURCES.items():
        current = fetch_hash(url)
        previous = known.get(name)
        if previous is None:
            log(f"  {name}: no recorded hash yet -- recording {current[:12]}")
        elif previous != current:
            log(f"  {name}: CHANGED -- was {previous[:12]}, now {current[:12]}")
            changed.append(name)
        else:
            log(f"  {name}: unchanged ({current[:12]})")
        known[name] = current

    HASHES_FILE.write_text(json.dumps(known, indent=2, sort_keys=True) + "\n")

    if changed:
        log(f"Upstream changed: {', '.join(changed)}. Consider `npm run data` and reviewing the diff.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
