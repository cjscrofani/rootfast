"""The precomputed summary tables (migration 006 + populate_summaries.sql) must
reproduce the aggregations the API used to compute on the fly — including the
accepted-only endemic rule and the all-distribution county counts.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA_DIR = REPO_ROOT / "api" / "schema"
POPULATE_SQL = REPO_ROOT / "api" / "scripts" / "populate_summaries.sql"


def _plant(db, pid, symbol, syn=0, exc=0, photo=None):
    db.execute(
        """INSERT INTO plants (id, usda_symbol, scientific_name, scientific_name_canonical,
                               rank, is_synonym, is_excluded, photo_url, source_version, fetched_at)
           VALUES (?, ?, ?, ?, 'Species', ?, ?, ?, 't', '2026-01-01T00:00:00Z')""",
        (pid, symbol, f"Genus {symbol}", f"Genus {symbol}", syn, exc, photo),
    )


@pytest.fixture
def db():
    con = sqlite3.connect(":memory:")
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        con.executescript(migration.read_text(encoding="utf-8"))
    # Geography
    con.execute("INSERT INTO states (state_code, state_name) VALUES ('MT','Montana'),('WY','Wyoming'),('CA','California')")
    con.executemany(
        "INSERT INTO counties (county_fips, county_name, state_code) VALUES (?,?,?)",
        [("30031", "Gallatin", "MT"), ("30001", "Beaverhead", "MT"),
         ("56001", "Albany", "WY"), ("06001", "Alameda", "CA")],
    )
    # Plants: P1 MT-only (endemic), P2 MT+WY (not), P3 CA-only (endemic),
    # P4 MT-only but a synonym (excluded from endemics), P5 CA-only with a photo.
    _plant(con, 1, "P1")
    _plant(con, 2, "P2")
    _plant(con, 3, "P3")
    _plant(con, 4, "P4", syn=1)
    _plant(con, 5, "P5", photo="https://img/p5.jpg")
    con.executemany(
        "INSERT INTO plant_county_distribution (plant_id, county_fips, nativity) VALUES (?,?, 'Native')",
        [(1, "30031"), (1, "30001"), (2, "30031"), (2, "56001"),
         (3, "06001"), (4, "30031"), (5, "06001")],
    )
    con.executescript(POPULATE_SQL.read_text(encoding="utf-8"))
    yield con
    con.close()


def test_endemics_are_accepted_only(db):
    rows = dict(db.execute("SELECT plant_id, state_code FROM plant_endemic_state").fetchall())
    # P1 -> MT, P3 & P5 -> CA. P2 is multi-state; P4 is a synonym.
    assert rows == {1: "MT", 3: "CA", 5: "CA"}


def test_endemic_counts_per_state(db):
    counts = dict(db.execute(
        "SELECT state_code, COUNT(*) FROM plant_endemic_state GROUP BY state_code"
    ).fetchall())
    assert counts == {"MT": 1, "CA": 2}


def test_county_taxa_counts_are_all_distribution(db):
    rows = dict(db.execute(
        "SELECT county_fips, taxa_count FROM county_taxa_summary"
    ).fetchall())
    # 30031 has P1,P2,P4 = 3 (synonyms included, matching prior endpoint behaviour).
    assert rows == {"30031": 3, "30001": 1, "56001": 1, "06001": 2}


def test_county_photo_counts(db):
    photos = dict(db.execute(
        "SELECT county_fips, photo_count FROM county_taxa_summary"
    ).fetchall())
    # Only P5 (in 06001) has a photo.
    assert photos["06001"] == 1
    assert photos["30031"] == 0


def test_every_county_has_a_row(db):
    n = db.execute("SELECT COUNT(*) FROM county_taxa_summary").fetchone()[0]
    assert n == 4
