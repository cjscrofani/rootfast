"""Aggregate per-county SSURGO data into a single representative soil
profile per county. Emits processed/soil.db conforming to the Rootfast
unified schema (api/schema/005_soil.sql).

For each county we:
  1. Take the mukey sampled at its centroid (already done in fetch_soil.py).
  2. Compute component-percentage-weighted means of the surface (0–25 cm)
     horizon attributes: pH, organic matter, sand/silt/clay %, AWC.
  3. Pick the dominant component for naming + drainage class + slope.
  4. Derive a coarse USDA texture class from the weighted sand/silt/clay.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

ETL_ROOT  = Path(__file__).resolve().parent.parent
REPO_ROOT = ETL_ROOT.parents[2]
RAW        = ETL_ROOT / "raw"
COUNTY_DIR = RAW / "county_soil"
PROCESSED  = ETL_ROOT / "processed"
OUT        = PROCESSED / "soil.db"
SCHEMA_DIR = REPO_ROOT / "api" / "schema"


def _f(v) -> float | None:
    try:
        return float(v) if v not in (None, "", "null") else None
    except (TypeError, ValueError):
        return None


def _i(v) -> int | None:
    try:
        return int(float(v)) if v not in (None, "", "null") else None
    except (TypeError, ValueError):
        return None


def usda_texture_class(sand: float | None, silt: float | None, clay: float | None) -> str | None:
    """Approximation of the USDA soil texture triangle. Returns one of:
    Sand, Loamy sand, Sandy loam, Loam, Silt loam, Silt, Sandy clay loam,
    Clay loam, Silty clay loam, Sandy clay, Silty clay, Clay. (Heavy fallback
    on the dominant fraction when an exact boundary check fails.)"""
    if sand is None or silt is None or clay is None:
        return None
    s, si, c = sand, silt, clay

    # Boundaries straight from the USDA soil texture chart.
    if c >= 40:
        if s >= 45: return "Sandy clay"
        if si >= 40: return "Silty clay"
        return "Clay"
    if c >= 27 and c < 40:
        if s > 45: return "Sandy clay loam"
        if si >= 40: return "Silty clay loam"
        return "Clay loam"
    if c >= 7 and c < 27:
        if si >= 50 and (c >= 12 or si < 80): return "Silt loam"
        if si >= 80: return "Silt"
        if s >= 70 and s < 87 - (c * 1.0): return "Sandy loam"
        if s >= 50: return "Sandy loam"
        return "Loam"
    # clay < 7
    if si >= 50:
        return "Silt" if si >= 80 else "Silt loam"
    if s >= 85: return "Sand"
    if s >= 70: return "Loamy sand"
    return "Sandy loam"


def aggregate(rows: list[dict]) -> dict | None:
    """rows: list of (mukey, component, horizon) joins from fetch_soil. Returns
    None if nothing usable. Otherwise a dict ready for INSERT."""
    if not rows:
        return None

    # Header carries muname (constant per mukey).
    muname = rows[0].get("muname")

    # Group by cokey so we can find a dominant component + iterate surface
    # horizons within each.
    by_co: dict[str, list[dict]] = {}
    for r in rows:
        by_co.setdefault(r["cokey"], []).append(r)

    # Dominant component: highest comppct_r.
    components = sorted(
        by_co.values(),
        key=lambda hs: _f(hs[0].get("comppct_r")) or 0,
        reverse=True,
    )
    if not components:
        return None

    dom = components[0][0]
    dominant_comp = dom.get("compname")
    drainage = dom.get("drainagecl")
    slope_pct = _f(dom.get("slope_r"))

    # Component-percentage-weighted means over the 0-25 cm zone.
    weighted: dict[str, tuple[float, float]] = {}  # key → (sum_of_value*weight, sum_of_weight)
    keys = ["sandtotal_r", "silttotal_r", "claytotal_r", "om_r", "ph1to1h2o_r", "awc_r"]
    for horizons in components:
        compname = horizons[0].get("compname")
        comppct = _f(horizons[0].get("comppct_r")) or 0
        if comppct <= 0:
            continue
        # Surface horizons: anything starting above 25 cm depth.
        surface = [h for h in horizons if (_f(h.get("hzdept_r")) or 999) < 25]
        if not surface:
            continue
        # Take the first surface horizon (the topmost) for each component.
        h = surface[0]
        for k in keys:
            v = _f(h.get(k))
            if v is None:
                continue
            cur = weighted.get(k, (0.0, 0.0))
            weighted[k] = (cur[0] + v * comppct, cur[1] + comppct)

    def mean_of(k: str) -> float | None:
        if k not in weighted:
            return None
        s, w = weighted[k]
        return round(s / w, 2) if w else None

    sand = mean_of("sandtotal_r")
    silt = mean_of("silttotal_r")
    clay = mean_of("claytotal_r")
    om = mean_of("om_r")
    ph = mean_of("ph1to1h2o_r")
    awc = mean_of("awc_r")

    return {
        "muname":           muname,
        "dominant_comp":    dominant_comp,
        "drainage_class":   drainage,
        "slope_pct":        slope_pct,
        "surface_ph":       ph,
        "surface_om_pct":   om,
        "surface_sand_pct": sand,
        "surface_silt_pct": silt,
        "surface_clay_pct": clay,
        "texture_class":    usda_texture_class(sand, silt, clay),
        "awc_in_top_25cm":  awc,
    }


def open_fresh_db() -> sqlite3.Connection:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()
    db = sqlite3.connect(OUT)
    db.isolation_level = None
    db.execute("PRAGMA foreign_keys = OFF")
    db.execute("PRAGMA journal_mode = OFF")
    db.execute("PRAGMA synchronous = OFF")
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        db.executescript(migration.read_text())
    return db


def main() -> None:
    if not COUNTY_DIR.exists():
        raise SystemExit(f"Missing {COUNTY_DIR}. Run fetch_soil.py first.")

    print(f"Building {OUT}")
    db = open_fresh_db()
    db.execute("BEGIN")

    inserted = 0
    skipped_no_mukey = 0
    skipped_no_surface = 0
    files = sorted(COUNTY_DIR.glob("*.json"))
    for f in files:
        d = json.loads(f.read_bytes())
        fips  = d["county_fips"]
        mukey = d.get("mukey")
        if not mukey:
            skipped_no_mukey += 1
            continue
        agg = aggregate(d.get("rows", []))
        if not agg:
            skipped_no_surface += 1
            continue
        db.execute(
            """INSERT INTO soil_by_county
                 (county_fips, mukey, muname, dominant_comp,
                  drainage_class, slope_pct,
                  surface_ph, surface_om_pct,
                  surface_sand_pct, surface_silt_pct, surface_clay_pct,
                  texture_class, awc_in_top_25cm)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                fips, mukey,
                agg["muname"], agg["dominant_comp"],
                agg["drainage_class"], agg["slope_pct"],
                agg["surface_ph"], agg["surface_om_pct"],
                agg["surface_sand_pct"], agg["surface_silt_pct"], agg["surface_clay_pct"],
                agg["texture_class"], agg["awc_in_top_25cm"],
            ),
        )
        inserted += 1

    db.execute("COMMIT")
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"  inserted {inserted} county soil rows")
    print(f"  skipped: {skipped_no_mukey} no-mukey, {skipped_no_surface} no-surface-data")
    print(f"\nFinal: {OUT} ({size_mb:.2f} MB)")

    # Cheap validation
    rows = db.execute(
        "SELECT drainage_class, COUNT(*) FROM soil_by_county GROUP BY drainage_class ORDER BY 2 DESC LIMIT 6"
    ).fetchall()
    print("Drainage class distribution:")
    for r in rows:
        print(f"  {r[0]!r:30}  {r[1]}")
    rows = db.execute(
        "SELECT texture_class, COUNT(*) FROM soil_by_county GROUP BY texture_class ORDER BY 2 DESC LIMIT 6"
    ).fetchall()
    print("Texture class distribution:")
    for r in rows:
        print(f"  {r[0]!r:30}  {r[1]}")

    db.close()


if __name__ == "__main__":
    main()
