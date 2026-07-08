"""Tests for the SSURGO soil aggregation."""

from __future__ import annotations

from loader import load

soil = load("sources/usda-soil/etl/scripts/build_sqlite.py")


def _horizon(cokey, comppct, hzdept, **vals):
    row = {"cokey": cokey, "comppct_r": comppct, "hzdept_r": hzdept, "muname": "Test map unit"}
    row.update(vals)
    return row


class TestSurfaceHorizon:
    def test_surface_horizon_at_zero_depth_is_included(self):
        """Regression: hzdept_r == 0 is the real surface horizon and must be
        used. The old `(_f(hzdept_r) or 999) < 25` treated 0.0 as falsy and
        dropped it, computing surface properties from a deeper layer (or None)."""
        rows = [
            _horizon("c1", 100, 0, ph1to1h2o_r=6.5, sandtotal_r=40, silttotal_r=40, claytotal_r=20),
            _horizon("c1", 100, 30, ph1to1h2o_r=8.0, sandtotal_r=10, silttotal_r=10, claytotal_r=80),
        ]
        out = soil.aggregate(rows)
        assert out is not None
        # Must come from the 0 cm horizon, not the 30 cm one.
        assert out["surface_ph"] == 6.5
        assert out["surface_clay_pct"] == 20

    def test_horizon_below_25cm_only_yields_no_surface(self):
        """A component whose shallowest horizon starts at/after 25 cm has no
        surface sample and contributes nothing."""
        rows = [_horizon("c1", 100, 30, ph1to1h2o_r=8.0)]
        out = soil.aggregate(rows)
        assert out is not None
        assert out["surface_ph"] is None

    def test_missing_depth_is_excluded(self):
        rows = [_horizon("c1", 100, None, ph1to1h2o_r=7.0)]
        out = soil.aggregate(rows)
        assert out is not None
        assert out["surface_ph"] is None

    def test_component_percentage_weighting(self):
        """Two components: pH is weighted by comppct_r."""
        rows = [
            _horizon("c1", 75, 0, ph1to1h2o_r=6.0),
            _horizon("c2", 25, 0, ph1to1h2o_r=8.0),
        ]
        out = soil.aggregate(rows)
        # (6.0*75 + 8.0*25) / 100 = 6.5
        assert out["surface_ph"] == 6.5

    def test_empty_rows_returns_none(self):
        assert soil.aggregate([]) is None


class TestTextureClass:
    def test_known_texture_points(self):
        assert soil.usda_texture_class(90, 5, 5) == "Sand"
        assert soil.usda_texture_class(20, 20, 60) == "Clay"
        assert soil.usda_texture_class(40, 40, 20) == "Loam"

    def test_none_inputs_return_none(self):
        assert soil.usda_texture_class(None, 10, 10) is None
