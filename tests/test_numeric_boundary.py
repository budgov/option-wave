"""Numeric fast paths preserve the provider boundary's existing coercion rules."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from benchmarks.benchmark_ocean_wave import make_chain
from option_wave import elo, factors


class NumericBoundaryTests(unittest.TestCase):
    def test_coercion_parity_for_numeric_strings_nullable_and_missing_columns(self) -> None:
        columns = [
            pd.Series([0.0, -0.0, np.nan, np.inf, -np.inf]),
            pd.Series([0, -1, 2], dtype="int64"),
            pd.Series([0, 2, 2**63 + 1], dtype="uint64"),
            pd.Series([True, False], dtype=bool),
            pd.Series(["1.5", "invalid", None, "Infinity", "-0"], dtype=object),
            pd.Series(["1.5", pd.NA, "bad"], dtype="string"),
            pd.Series([1, pd.NA, 3], dtype="Int64"),
            pd.Series([1.5, pd.NA, -0.0], dtype="Float64"),
            pd.Series([], dtype=float),
        ]
        for column in columns:
            frame = pd.DataFrame({"value": column})
            original = frame.copy(deep=True)
            for default in (0.0, np.nan, 7.0):
                with self.subTest(dtype=str(column.dtype), default=default):
                    expected_elo = pd.to_numeric(frame["value"], errors="coerce").fillna(default).to_numpy(float)
                    expected_factor = pd.to_numeric(frame["value"], errors="coerce").to_numpy(float)
                    actual_elo = elo._column(frame, "value", default)
                    actual_factor = factors._numeric(frame, "value", default)
                    np.testing.assert_array_equal(actual_elo, expected_elo)
                    np.testing.assert_array_equal(actual_factor, expected_factor)
                    np.testing.assert_array_equal(np.signbit(actual_elo), np.signbit(expected_elo))
                    np.testing.assert_array_equal(elo._column(frame, "absent", default), np.full(len(frame), default))
                    np.testing.assert_array_equal(factors._numeric(frame, "absent", default), np.full(len(frame), default))
            pd.testing.assert_frame_equal(frame, original, check_exact=True)

    def test_native_numeric_columns_skip_series_coercion_without_mutating_nan_or_infinity(self) -> None:
        frame = pd.DataFrame({"value": [1.0, np.nan, np.inf, -np.inf]})
        original = frame.copy(deep=True)
        with patch.object(pd, "to_numeric", side_effect=AssertionError("unexpected numeric coercion")):
            np.testing.assert_array_equal(elo._column(frame, "value"), [1.0, 0.0, np.inf, -np.inf])
            np.testing.assert_array_equal(factors._numeric(frame, "value"), [1.0, np.nan, np.inf, -np.inf])
        pd.testing.assert_frame_equal(frame, original, check_exact=True)

    def test_negative_bid_uses_price_fallback_and_never_a_quoted_mid(self) -> None:
        frame = pd.DataFrame({
            "call_bid": [-1.0, -1.0, 0.0], "call_ask": [3.0, 3.0, 2.0],
            "call_mid": [5.0, np.nan, 5.0], "call_last": [4.0, 4.0, 4.0],
        })
        original = frame.copy(deep=True)
        prices, variance = elo._mid_and_variance(frame, "call", elo.EloConfig())
        np.testing.assert_array_equal(prices, [5.0, 4.0, 1.0])
        np.testing.assert_allclose(variance, [0.0025, 0.0025, 1.0], rtol=0, atol=1e-15)
        pd.testing.assert_frame_equal(frame, original, check_exact=True)

    def test_pair_surface_and_rating_state_match_legacy_coercion_for_repeated_snapshots(self) -> None:
        chain = make_chain(expiries=3, strikes=11)
        original = chain.copy(deep=True)
        fast_ratings, legacy_ratings = {}, {}

        def legacy_column(frame, name, default=0.0):
            if name not in frame:
                return np.full(len(frame), default, dtype=float)
            return pd.to_numeric(frame[name], errors="coerce").fillna(default).to_numpy(float)

        for _ in range(3):
            actual = elo.build_elo_surface(chain, 100.0, ratings=fast_ratings)
            with patch.object(elo, "_column", legacy_column):
                expected = elo.build_elo_surface(chain, 100.0, ratings=legacy_ratings)
            pd.testing.assert_frame_equal(actual, expected, check_exact=True)
            self.assertEqual(fast_ratings, legacy_ratings)
        pd.testing.assert_frame_equal(chain, original, check_exact=True)


if __name__ == "__main__":
    unittest.main()
