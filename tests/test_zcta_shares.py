"""The Census ZCTA → county crosswalk reducer must turn overlap areas into
per-ZIP land shares that sum to 1 and order counties largest-first."""

from __future__ import annotations

from loader import load

zcta = load("sources/census-zcta/etl/scripts/build_sqlite.py")


def _row(zip_code, fips, land, water=0):
    return {
        "GEOID_ZCTA5_20": zip_code,
        "GEOID_COUNTY_20": fips,
        "AREALAND_PART": str(land),
        "AREAWATER_PART": str(water),
    }


def test_single_county_zip_gets_share_one():
    out = zcta.compute_shares([_row("10001", "36061", 1_000)])
    assert out == [("10001", "36061", 1.0)]


def test_multi_county_zip_shares_sum_to_one_largest_first():
    out = zcta.compute_shares([
        _row("59715", "30067", 82),
        _row("59715", "30031", 918),
    ])
    assert [o[1] for o in out] == ["30031", "30067"]
    assert abs(sum(o[2] for o in out) - 1.0) < 1e-6
    assert out[0][2] == 0.918


def test_water_only_zip_falls_back_to_total_area():
    out = zcta.compute_shares([
        _row("00000", "12086", 0, water=300),
        _row("00000", "12087", 0, water=100),
    ])
    assert out == [("00000", "12086", 0.75), ("00000", "12087", 0.25)]


def test_rows_without_a_zcta_are_skipped():
    out = zcta.compute_shares([
        _row("", "30031", 500),
        _row("59715", "30031", 500),
    ])
    assert out == [("59715", "30031", 1.0)]


def test_duplicate_pairs_are_summed_before_sharing():
    out = zcta.compute_shares([
        _row("80301", "08013", 250),
        _row("80301", "08013", 250),
        _row("80301", "08014", 500),
    ])
    assert out == [("80301", "08013", 0.5), ("80301", "08014", 0.5)]
