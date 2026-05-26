"""Fetch one primary photo per USDA plant from iNaturalist.

For each plant in the consolidated USDA cache, query iNat's /v1/taxa
endpoint by binomial + rank, take the taxon's default_photo, and record
the URL + license + attribution. Idempotent caching to:
    raw/inat_photos.json   keyed by USDA symbol

iNaturalist requests we keep below 100 calls / minute. This script does
serial fetches with a 0.7 s pause → ~85 / minute, ~38 min for ~3,200 plants.
A unique User-Agent identifying the project is required per iNat's terms.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

INAT = "https://api.inaturalist.org/v1/taxa"
UA = "rootfast/0.1 (https://rootfast-web.pages.dev; cj@gdws.co; non-commercial native plants project)"
SLEEP_BETWEEN = 0.7  # seconds

ETL_ROOT = Path(__file__).resolve().parent.parent
RAW = ETL_ROOT / "raw"
PROFILE_DIR = RAW / "profiles"
OUT = RAW / "inat_photos.json"

# USDA Rank → iNat rank vocabulary
RANK_MAP: dict[str, str] = {
    "Species":    "species",
    "Subspecies": "subspecies",
    "Variety":    "variety",
    "Form":       "form",
}

ACTIONABLE_RANKS = frozenset(RANK_MAP.keys())


def _http_get_json(url: str, retries: int = 4) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            # 429 = rate limited — back off harder
            if e.code == 429:
                wait = 5 * (attempt + 1)
                print(f"  429 rate limited; sleeping {wait}s", file=sys.stderr)
                time.sleep(wait)
                last = e
                continue
            if e.code in (500, 502, 503, 504):
                last = e
                time.sleep(2 ** attempt)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last = e
            time.sleep(2 ** attempt)
    assert last is not None
    raise last


_TAG_RE = __import__("re").compile(r"<[^>]+>")


def _binomial(sci: str | None) -> str | None:
    """Return the species/subspecies binomial (or trinomial for varieties),
    stripped of HTML and author authority. Same logic as build_sqlite.py."""
    if not sci:
        return None
    cleaned = _TAG_RE.sub("", sci).strip()
    parts = cleaned.split()
    if len(parts) < 2:
        return None
    out = f"{parts[0]} {parts[1]}"
    for i in range(2, len(parts) - 1):
        if parts[i].rstrip(".") in ("ssp", "subsp", "var", "f"):
            out += f" {parts[i]} {parts[i + 1]}"
            break
    return out


def _extract(resp: dict, query_name: str) -> dict:
    """Distill iNat /v1/taxa response into the columns the schema needs."""
    r = (resp.get("results") or [None])[0]
    if not r:
        return {"match_status": "NONE", "query_name": query_name}

    dp = r.get("default_photo") or {}
    if not dp.get("medium_url"):
        return {
            "match_status":   "TAXON_NO_PHOTO",
            "query_name":     query_name,
            "inat_taxon_id":  r.get("id"),
            "inat_name":      r.get("name"),
        }

    return {
        "match_status":   "OK",
        "query_name":     query_name,
        "inat_taxon_id":  r.get("id"),
        "inat_name":      r.get("name"),
        "photo_id":       dp.get("id"),
        "url_medium":     dp.get("medium_url"),
        "url_square":     dp.get("square_url"),
        "license":        dp.get("license_code"),
        "attribution":    dp.get("attribution"),
        "observations_count": r.get("observations_count"),
    }


def _profile_iter() -> list[tuple[str, str, str]]:
    """Yield (usda_symbol, binomial, inat_rank) for each actionable taxon."""
    rows: list[tuple[str, str, str]] = []
    for path in sorted(PROFILE_DIR.glob("*.json")):
        try:
            p = json.loads(path.read_bytes())
        except Exception:
            continue
        sym = p.get("Symbol")
        rank = p.get("Rank")
        if not sym or rank not in ACTIONABLE_RANKS:
            continue
        b = _binomial(p.get("ScientificName"))
        if not b:
            continue
        rows.append((sym, b, RANK_MAP[rank]))
    return rows


def main() -> None:
    if not PROFILE_DIR.exists():
        sys.exit("Missing raw/profiles/ — run fetch_usda_plants_mt.py first.")

    existing: dict[str, dict] = {}
    if OUT.exists():
        existing = json.loads(OUT.read_bytes())
        print(f"Reusing {len(existing)} cached photo records.")

    todo = [(s, b, r) for (s, b, r) in _profile_iter() if s not in existing]
    print(f"Plants to fetch: {len(todo)} (already cached: {len(existing)})")
    if not todo:
        _print_summary(existing)
        return

    print(f"Rate-limited at ≤ ~85 req/min ({SLEEP_BETWEEN}s/request).")
    print(f"Estimated runtime: {len(todo) * SLEEP_BETWEEN / 60:.1f} minutes.\n")

    new: dict[str, dict] = {}
    n_ok = n_none = n_no_photo = n_err = 0
    started = time.time()

    for i, (sym, name, rank) in enumerate(todo, 1):
        url = f"{INAT}?{urllib.parse.urlencode({'q': name, 'rank': rank, 'per_page': 1})}"
        try:
            resp = _http_get_json(url)
            rec = _extract(resp, name)
        except Exception as e:
            rec = {"match_status": "ERROR", "query_name": name, "error": str(e)}

        new[sym] = rec
        if rec["match_status"] == "OK":         n_ok += 1
        elif rec["match_status"] == "NONE":      n_none += 1
        elif rec["match_status"] == "TAXON_NO_PHOTO": n_no_photo += 1
        else:                                    n_err += 1

        # Periodic save so a crash doesn't lose work
        if i % 100 == 0:
            elapsed = time.time() - started
            rate = i / elapsed
            eta = (len(todo) - i) / rate / 60
            print(f"  {i:>4}/{len(todo)} done · ok={n_ok} none={n_none} no_photo={n_no_photo} err={n_err} · ~{eta:.1f} min left")
            OUT.write_text(json.dumps({**existing, **new}, indent=2, sort_keys=True))

        time.sleep(SLEEP_BETWEEN)

    merged = {**existing, **new}
    OUT.write_text(json.dumps(merged, indent=2, sort_keys=True))
    print(f"\nWrote {len(merged)} records to {OUT}")
    _print_summary(merged)


def _print_summary(records: dict[str, dict]) -> None:
    n = len(records)
    counts = {"OK": 0, "NONE": 0, "TAXON_NO_PHOTO": 0, "ERROR": 0}
    licenses: dict[str, int] = {}
    for r in records.values():
        counts[r.get("match_status", "ERROR")] = counts.get(r.get("match_status", "ERROR"), 0) + 1
        if r.get("license"):
            licenses[r["license"]] = licenses.get(r["license"], 0) + 1
    print(f"\nResults:")
    for k, v in counts.items():
        pct = 100 * v / max(n, 1)
        print(f"  {k:18}  {v:>5}  ({pct:>5.1f}%)")
    if licenses:
        print(f"\nLicense breakdown:")
        for lic, c in sorted(licenses.items(), key=lambda x: -x[1]):
            print(f"  {lic:14}  {c:>5}")


if __name__ == "__main__":
    main()
