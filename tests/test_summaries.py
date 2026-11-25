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


# ---------------------------------------------------------------------------
# Migration 008 — read-cost summaries. Each derived table must equal the
# aggregation it replaced in the API (api/src/index.ts), computed here straight
# from the base tables.
# ---------------------------------------------------------------------------

@pytest.fixture
def db8(db):
    """The base fixture plus Introduced/Both records and an excluded taxon,
    with the summaries refilled."""
    _plant(db, 6, "P6", exc=1)                      # excluded: must never appear
    _plant(db, 7, "A0")                             # sorts before every "Genus P*"
    db.executemany(
        "INSERT INTO plant_county_distribution (plant_id, county_fips, nativity) VALUES (?,?,?)",
        [(2, "30001", "Introduced"), (3, "30031", "Both"), (6, "30031", "Native"),
         (7, "30031", "Introduced"), (7, "30001", "Native"), (7, "06001", "Both")],
    )
    db.executescript(POPULATE_SQL.read_text(encoding="utf-8"))
    return db


def test_populate_is_idempotent(db8):
    tables = ["plant_endemic_state", "county_taxa_summary", "plant_name_rank", "county_plants",
              "state_plants", "state_taxa_summary", "plant_range_summary"]
    before = {t: db8.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables}
    db8.executescript(POPULATE_SQL.read_text(encoding="utf-8"))
    after = {t: db8.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables}
    assert before == after


def test_name_rank_is_accepted_taxa_in_name_order(db8):
    ranked = [r[0] for r in db8.execute("SELECT plant_id FROM plant_name_rank ORDER BY name_rank")]
    expected = [r[0] for r in db8.execute(
        "SELECT id FROM plants WHERE is_synonym = 0 AND is_excluded = 0 ORDER BY scientific_name, id")]
    assert ranked == expected
    assert 4 not in ranked and 6 not in ranked      # synonym, excluded


def test_county_plants_matches_the_old_county_listing(db8):
    for (fips,) in db8.execute("SELECT county_fips FROM counties"):
        old = db8.execute(
            """SELECT p.id, pcd.nativity
                 FROM plant_county_distribution pcd JOIN plants p ON p.id = pcd.plant_id
                WHERE pcd.county_fips = ? AND p.is_synonym = 0 AND p.is_excluded = 0
                ORDER BY p.scientific_name""", (fips,)).fetchall()
        new = db8.execute(
            "SELECT plant_id, nativity FROM county_plants WHERE county_fips = ? ORDER BY name_rank",
            (fips,)).fetchall()
        assert new == old, fips


def test_county_accepted_counts_by_nativity(db8):
    for fips, acc, nat, intro, both in db8.execute(
            "SELECT county_fips, accepted_count, native_count, introduced_count, both_count FROM county_taxa_summary"):
        rows = db8.execute(
            """SELECT pcd.nativity FROM plant_county_distribution pcd JOIN plants p ON p.id = pcd.plant_id
                WHERE pcd.county_fips = ? AND p.is_synonym = 0 AND p.is_excluded = 0""", (fips,)).fetchall()
        kinds = [r[0] for r in rows]
        assert (acc, nat, intro, both) == (
            len(kinds), kinds.count("Native"), kinds.count("Introduced"), kinds.count("Both")), fips
    # Gallatin: P1 N, P2 N, P3 Both, A0 Introduced; P4 (synonym) and P6 (excluded) are not counted.
    assert db8.execute(
        "SELECT accepted_count, native_count, introduced_count, both_count FROM county_taxa_summary WHERE county_fips='30031'"
    ).fetchone() == (4, 2, 1, 1)


def test_state_plants_matches_the_old_state_rollup(db8):
    old = db8.execute(
        """SELECT c.state_code, p.scientific_name, p.id, COUNT(*),
                  SUM(CASE WHEN pcd.nativity='Native' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN pcd.nativity='Introduced' THEN 1 ELSE 0 END),
                  SUM(CASE WHEN pcd.nativity='Both' THEN 1 ELSE 0 END)
             FROM plants p
             JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
             JOIN counties c ON c.county_fips = pcd.county_fips
            WHERE p.is_synonym = 0 AND p.is_excluded = 0
            GROUP BY c.state_code, p.id
            ORDER BY 1, 2, 3""").fetchall()
    new = db8.execute("SELECT * FROM state_plants ORDER BY 1, 2, 3").fetchall()
    assert new == old
    # A0 in MT: one Introduced county and one Native county.
    assert db8.execute(
        "SELECT county_count, native_counties, introduced_counties, both_counties FROM state_plants WHERE state_code='MT' AND plant_id=7"
    ).fetchone() == (2, 1, 1, 0)


def test_state_taxa_summary_matches_old_aggregates(db8):
    for state, counties, taxa, acc, nat, intro, both in db8.execute("SELECT * FROM state_taxa_summary"):
        assert counties == db8.execute(
            "SELECT COUNT(*) FROM counties WHERE state_code = ?", (state,)).fetchone()[0]
        # taxa_count is ALL distribution rows (synonyms/excluded included), as /v1/states always reported.
        assert taxa == db8.execute(
            """SELECT COUNT(DISTINCT pcd.plant_id) FROM plant_county_distribution pcd
                 JOIN counties c ON c.county_fips = pcd.county_fips WHERE c.state_code = ?""", (state,)).fetchone()[0]
        def with_any(kind):
            return db8.execute(
                """SELECT COUNT(DISTINCT p.id) FROM plants p
                     JOIN plant_county_distribution pcd ON pcd.plant_id = p.id
                     JOIN counties c ON c.county_fips = pcd.county_fips
                    WHERE c.state_code = ? AND p.is_synonym = 0 AND p.is_excluded = 0
                      AND (? IS NULL OR pcd.nativity = ?)""", (state, kind, kind)).fetchone()[0]
        assert (acc, nat, intro, both) == (
            with_any(None), with_any("Native"), with_any("Introduced"), with_any("Both")), state
    # Only states with distribution data get a row.
    assert {r[0] for r in db8.execute("SELECT state_code FROM state_taxa_summary")} == {"MT", "WY", "CA"}
    # MT: 6 distinct plants recorded (P1 P2 P3 P4 P6 A0), 4 accepted.
    assert db8.execute(
        "SELECT taxa_count, accepted_count FROM state_taxa_summary WHERE state_code='MT'").fetchone() == (6, 4)


def test_plant_range_summary_matches_old_having_query(db8):
    old = db8.execute(
        "SELECT plant_id, COUNT(DISTINCT county_fips) FROM plant_county_distribution GROUP BY plant_id ORDER BY 1"
    ).fetchall()
    assert db8.execute("SELECT plant_id, county_count FROM plant_range_summary ORDER BY 1").fetchall() == old


def test_every_migration_table_is_classified():
    """A new table must be either dataset (build.py TABLE_ORDER) or explicitly
    operational/bookkeeping — a copy of TABLE_ORDER going stale is what broke
    the chunked reload."""
    import sys
    sys.path.insert(0, str(REPO_ROOT / "api" / "scripts"))
    import build, build_chunks, build_split_dump, export_release
    con = sqlite3.connect(":memory:")
    for migration in sorted(SCHEMA_DIR.glob("*.sql")):
        con.executescript(migration.read_text(encoding="utf-8"))
    tables = {r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'plants_fts%'")}
    not_dataset = {"schema_meta", *export_release._OPERATIONAL}
    assert tables - not_dataset == set(build.TABLE_ORDER)
    assert build_chunks.TABLE_ORDER is build.TABLE_ORDER
    assert build_split_dump.TABLE_ORDER is build.TABLE_ORDER
    assert set(export_release._OPERATIONAL) <= export_release._SKIP

