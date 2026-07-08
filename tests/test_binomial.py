"""The scientific-name -> binomial reducer is duplicated in three ETL scripts.
They must agree, or the GBIF match name, the iNaturalist query name, and the
stored canonical name diverge and corrupt the cross-source join for
infraspecific taxa.
"""

from __future__ import annotations

import pytest

from loader import load

build = load("sources/usda-plants/etl/scripts/build_sqlite.py")
gbif = load("sources/usda-plants/etl/scripts/match_gbif.py")
inat = load("sources/usda-plants/etl/scripts/fetch_inat_photos.py")

IMPLS = [build._binomial, gbif._binomial, inat._binomial]

CASES = [
    ("Pinus ponderosa Lawson & C. Lawson", "Pinus ponderosa"),
    ("Quercus alba L.", "Quercus alba"),
    ("Pinus ponderosa var. scopulorum Engelm.", "Pinus ponderosa var. scopulorum"),
    ("Carex aquatilis subsp. stans (Drejer) Hultén", "Carex aquatilis subsp. stans"),
    # Dotless rank marker — the case match_gbif previously missed (it required
    # the trailing dot) before the reducers were unified on rstrip(".").
    ("Carex aquatilis var stricta", "Carex aquatilis var stricta"),
]


@pytest.mark.parametrize("impl", IMPLS, ids=["build_sqlite", "match_gbif", "fetch_inat"])
@pytest.mark.parametrize("sci,expected", CASES, ids=[c[0] for c in CASES])
def test_each_impl_matches_expected(impl, sci, expected):
    assert impl(sci) == expected


@pytest.mark.parametrize("sci,_expected", CASES, ids=[c[0] for c in CASES])
def test_all_three_impls_agree(sci, _expected):
    results = {impl(sci) for impl in IMPLS}
    assert len(results) == 1, f"reducers disagree on {sci!r}: {results}"


@pytest.mark.parametrize("impl", IMPLS, ids=["build_sqlite", "match_gbif", "fetch_inat"])
def test_single_token_and_empty(impl):
    assert impl("Pinus") is None
    assert impl("") is None
    assert impl(None) is None
