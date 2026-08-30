from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from option_wave import HAS_CPP_CORE, MarketState, OceanWave, OptionWaveV09
from option_wave.realtime import RealtimePredictor, audit_option_chain, compact_previous_chain


def symmetric_chain() -> pd.DataFrame:
    rows: list[dict[str, float | str]] = []
    for expiry_days, expiry_date in ((0.0, "2026-08-28"), (1.0, "2026-08-29"), (7.0, "2026-09-04")):
        for strike in (90.0, 95.0, 100.0, 105.0, 110.0):
            rows.append({
                "strike": strike,
                "expiry_days": expiry_days,
                "expiry_date": expiry_date,
                "call_symbol": f"C-{expiry_date}-{strike}",
                "put_symbol": f"P-{expiry_date}-{strike}",
                "call_bid": 1.0,
                "call_ask": 1.1,
                "put_bid": 1.0,
                "put_ask": 1.1,
                "call_volume": 1_000.0,
                "put_volume": 1_000.0,
                "call_oi": 5_000.0,
                "put_oi": 5_000.0,
                "call_iv": 0.25,
                "put_iv": 0.25,
                "call_delta": 0.50,
                "put_delta": -0.50,
                "call_gamma": 0.02,
                "put_gamma": 0.02,
                "call_vega": 0.10,
                "put_vega": 0.10,
            })
    return pd.DataFrame(rows)


def complete_state() -> MarketState:
    return MarketState(
        spot=100.0,
        previous_close=100.0,
        vwap=100.0,
        rvol=1.0,
        realized_vol=0.25,
        return_5m=0.0,
        return_15m=0.0,
        minutes_from_open=60.0,
        data_confidence=1.0,
    )


class ActionabilityTests(unittest.TestCase):
    def test_weak_probability_is_explicit_abstention_and_keeps_raw_probability(self) -> None:
        result = OceanWave().predict(
            symmetric_chain(), complete_state(), horizons_minutes=(30.0,)
        )

        self.assertEqual(result.direction, "Abstain")
        self.assertEqual(result.actionability, "abstain")
        self.assertEqual(result.abstain_reason, "weak_directional_edge")
        self.assertEqual(result.raw_probability, result.expectations[30.0].probability_up)
        self.assertLessEqual(
            abs(result.calibrated_probability - 0.5),
            abs(result.raw_probability - 0.5),
        )
        self.assertIn("weak_directional_edge", result.diagnostics["abstain_reasons"])

    def test_each_missing_causal_feature_degrades_market_data_quality(self) -> None:
        baseline = OceanWave().predict(
            symmetric_chain(), complete_state(), horizons_minutes=(30.0,)
        )
        baseline_quality = float(baseline.diagnostics["market_data_quality"])
        missing_values = {
            "vwap": None,
            "rvol": None,
            "return_5m": None,
            "return_15m": None,
            "realized_vol": None,
            "minutes_from_open": None,
        }
        for field_name, value in missing_values.items():
            with self.subTest(field=field_name):
                state_values = complete_state().__dict__.copy()
                state_values[field_name] = value
                result = OceanWave().predict(
                    symmetric_chain(), MarketState(**state_values), horizons_minutes=(30.0,)
                )
                self.assertLess(float(result.diagnostics["market_data_quality"]), baseline_quality)
                self.assertIn(field_name, result.diagnostics["missing_market_features"])

        insufficient = complete_state().__dict__.copy()
        for field_name in missing_values:
            insufficient[field_name] = None
        abstention = OceanWave().predict(
            symmetric_chain(), MarketState(**insufficient), horizons_minutes=(30.0,)
        )
        self.assertEqual(abstention.actionability, "abstain")
        self.assertIn("insufficient_market_data", abstention.diagnostics["abstain_reasons"])

    def test_invalid_training_day_scores_without_changing_online_state(self) -> None:
        model = OceanWave()
        model.predict(symmetric_chain(), complete_state(), horizons_minutes=(30.0,))
        before = model.state_dict()
        changed = symmetric_chain()
        changed["call_bid"] = 1.8
        changed["call_ask"] = 1.9

        result = model.predict(
            changed,
            complete_state(),
            horizons_minutes=(30.0,),
            training_day_valid=False,
        )

        self.assertEqual(model.state_dict(), before)
        self.assertEqual(result.direction, "Abstain")
        self.assertEqual(result.abstain_reason, "invalid_training_day")
        self.assertFalse(result.diagnostics["training_day_valid"])

    @unittest.skipUnless(HAS_CPP_CORE, "native core is unavailable")
    def test_native_and_reference_forecast_public_values_are_exact(self) -> None:
        native = OceanWave().predict(
            symmetric_chain(), complete_state(), horizons_minutes=(5.0, 30.0)
        )
        with patch("option_wave.model.HAS_CPP_CORE", False):
            reference = OceanWave().predict(
                symmetric_chain(), complete_state(), horizons_minutes=(5.0, 30.0)
            )

        self.assertEqual(native.trend_score, reference.trend_score)
        self.assertEqual(native.confidence, reference.confidence)
        self.assertEqual(native.raw_probability, reference.raw_probability)
        self.assertEqual(native.calibrated_probability, reference.calibrated_probability)
        self.assertEqual(native.expectations, reference.expectations)
        self.assertTrue(np.array_equal(native.distance_grid, reference.distance_grid))
        self.assertTrue(np.array_equal(native.expiry_grid, reference.expiry_grid))
        self.assertTrue(np.array_equal(native.field_grid, reference.field_grid))
        self.assertTrue(np.array_equal(native.factor_covariance, reference.factor_covariance))
        pd.testing.assert_frame_equal(native.factor_table, reference.factor_table, check_exact=True)
        pd.testing.assert_frame_equal(native.elo_surface, reference.elo_surface, check_exact=True)
        self.assertEqual(native.chain_factors, reference.chain_factors)
        native_diagnostics = {key: value for key, value in native.diagnostics.items() if key != "cpp_core"}
        reference_diagnostics = {key: value for key, value in reference.diagnostics.items() if key != "cpp_core"}
        self.assertEqual(native_diagnostics, reference_diagnostics)

    def test_existing_call_shape_and_legacy_alias_remain_compatible(self) -> None:
        result = OceanWave().predict(symmetric_chain(), complete_state())
        self.assertIs(OptionWaveV09, OceanWave)
        self.assertIsInstance(result.confidence, float)
        self.assertTrue(result.expectations)
        self.assertIsInstance(result.expected_price, float)


class OpenInterestIsolationTests(unittest.TestCase):
    def _predict(self, current: pd.DataFrame, *, seed_history: bool, previous: pd.DataFrame | None) -> tuple[dict, object]:
        class FakeSchwabClient:
            def __init__(self, _config: object) -> None:
                pass

            def fetch_market_snapshot(self, _symbol: str, *, strike_count: int) -> tuple[pd.DataFrame, MarketState]:
                return current, complete_state()

        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        client_patch = patch("option_wave.realtime.SchwabHTTPClient", FakeSchwabClient)
        client_patch.start()
        self.addCleanup(client_patch.stop)
        predictor = RealtimePredictor(Path(directory.name), async_checkpoints=False, require_native_core=False)
        self.addCleanup(predictor.close)
        runtime = predictor._load("SPY")
        baseline = symmetric_chain()
        baseline_oi = audit_option_chain(baseline, 100.0).oi_gross
        runtime.oi_history = (baseline_oi,) * 5 if seed_history else ()
        runtime.previous_chain = compact_previous_chain(previous) if previous is not None else None
        before = runtime.model.state_dict()
        snapshot = predictor.predict(
            symbol="SPY",
            signal_published_at="2026-08-28T17:00:00Z",
            access_token="test-token",
            horizons=(30.0,),
            strike_count=40,
            checkpoint_async=False,
        )
        self.assertEqual(runtime.model.state_dict(), before)
        self.assertFalse(snapshot["runtime"]["state_updated"])
        self.assertEqual(snapshot["runtime"]["checkpoint"], "none")
        self.assertFalse((Path(directory.name) / "SPY.state.json").exists())
        return snapshot, runtime

    def test_extreme_oi_isolated_without_gamma_or_gex_baseline(self) -> None:
        extreme = symmetric_chain()
        extreme["call_gamma"] = np.nan
        extreme["put_gamma"] = np.nan
        extreme["call_oi"] = 100_000_000.0
        snapshot, _runtime = self._predict(extreme, seed_history=False, previous=None)
        self.assertTrue(snapshot["quarantined"])
        self.assertIn("open_interest_exceeds_per_contract_limit", snapshot["quarantine_reasons"])

    def test_robust_oi_baseline_isolates_relative_outlier_when_gamma_missing(self) -> None:
        extreme = symmetric_chain()
        extreme["call_gamma"] = np.nan
        extreme["put_gamma"] = np.nan
        extreme["call_oi"] = 5_000_000.0
        extreme["put_oi"] = 5_000_000.0
        snapshot, _runtime = self._predict(extreme, seed_history=True, previous=None)
        self.assertTrue(snapshot["quarantined"])
        self.assertIn("oi_gross_extreme_outlier", snapshot["quarantine_reasons"])

    def test_cold_start_previous_chain_isolates_extreme_oi_change(self) -> None:
        baseline = symmetric_chain()
        extreme = baseline.copy()
        extreme["call_gamma"] = np.nan
        extreme["put_gamma"] = np.nan
        extreme["call_oi"] = 5_000_000.0
        snapshot, _runtime = self._predict(extreme, seed_history=False, previous=baseline)
        self.assertTrue(snapshot["quarantined"])
        self.assertTrue({
            "oi_gross_change_extreme_outlier",
            "oi_contract_change_extreme_outlier",
        }.intersection(snapshot["quarantine_reasons"]))


if __name__ == "__main__":
    unittest.main()
