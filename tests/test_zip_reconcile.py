"""build.py must fold renamed county FIPS codes into the ones USDA still uses
and drop crosswalk rows for counties the unified schema doesn't know, so the
FK check passes and ZIPs in renamed counties keep resolving."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from loader import load

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = REPO_ROOT / "api" / "schema"

build = load("api/scripts/build.py")


@pytest.fixture
def db():
    con = sqlite3.connect(":memory:")
    con.isolation_level = None
    con.execute("PRAGMA foreign_keys = OFF")
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        con.executescript(migration.read_text(encoding="utf-8"))
    con.execute("INSERT INTO states (state_code, state_name) VALUES ('SD','South Dakota'),('MT','Montana')")
    con.executemany(
        "INSERT INTO counties (county_fips, county_name, state_code) VALUES (?,?,?)",
        [("46113", "Shannon", "SD"), ("30031", "Gallatin", "MT")],
    )
    con.executemany(
        "INSERT INTO zip_counties (zip_code, county_fips, land_share) VALUES (?,?,?)",
        [
            ("57752", "46102", 1.0),     # renamed county → remap to 46113
            ("57770", "46102", 0.6),     # straddles a remapped + known county
            ("57770", "30031", 0.4),
            ("06001", "09001", 1.0),     # Connecticut pre-2022 county → dropped
            ("59715", "30031", 1.0),     # untouched
        ],
    )
    yield con
    con.close()


def rows(db):
    return sorted(db.execute("SELECT zip_code, county_fips, land_share FROM zip_counties").fetchall())


def test_remap_renamed_fips_and_drop_unknown(db):
    build.reconcile_zip_counties(db)
    assert rows(db) == [
        ("57752", "46113", 1.0),
        ("57770", "30031", 0.4),
        ("57770", "46113", 0.6),
        ("59715", "30031", 1.0),
    ]
    db.execute("PRAGMA foreign_keys = ON")
    assert db.execute("PRAGMA foreign_key_check(zip_counties)").fetchall() == []


def test_remap_sums_shares_when_both_codes_present(db):
    # A ZIP that already has a row for the old code AND one for the new code
    # ends up with one row whose share is the sum, capped at 1.
    db.execute("INSERT INTO zip_counties VALUES ('57752', '46113', 0.25)")
    build.reconcile_zip_counties(db)
    assert db.execute("SELECT land_share FROM zip_counties WHERE zip_code='57752'").fetchall() == [(1.0,)]


def test_noop_when_table_empty(db):
    db.execute("DELETE FROM zip_counties")
    build.reconcile_zip_counties(db)
    assert rows(db) == []


def test_populate_meta_stamps_counts_and_dates(db):
    db.execute(
        """INSERT INTO plants (id, usda_symbol, scientific_name, scientific_name_canonical, rank,
                               is_synonym, is_excluded, photo_url, source_version, fetched_at)
           VALUES (1, 'PIPO', 'Pinus ponderosa', 'Pinus ponderosa', 'Species', 0, 0, 'u', 't', '2026-05-26T21:14:40Z')"""
    )
    db.execute("INSERT INTO plant_county_distribution (plant_id, county_fips, nativity) VALUES (1, '30031', 'Native')")
    build.reconcile_zip_counties(db)
    build.populate_meta(db, None)
    meta = dict(db.execute("SELECT key, value FROM schema_meta").fetchall())
    assert meta["dataset_date"] == "2026-05-26"
    assert meta["dataset_version"] == "2026.05"          # derived from the pull month
    assert meta["count_taxa"] == "1"
    assert meta["count_states"] == "1"
    assert meta["count_zip_counties"] == "3"            # distinct ZIPs after reconcile
    assert meta["source_census_zcta_vintage"] == "2020"
    build.populate_meta(db, "2026.07")
    assert dict(db.execute("SELECT key, value FROM schema_meta").fetchall())["dataset_version"] == "2026.07"
