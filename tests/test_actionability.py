from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from option_wave import EventContext, HAS_CPP_CORE, MarketState, OceanWave, OptionWaveV09
from option_wave.elo import build_elo_surface
from option_wave.factors import extract_chain_factors


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
        # This test isolates directional-edge gating, not data coverage. Under
        # bounded budgets, absent inverse/macro data rightly stays neutral and
        # can fail evidence-quality first. Explicitly observed zero signals
        # are different from missing signals and supply the complete fixture.
        macro_names = ("gold", "treasury_10y", "dollar_index", "vix")
        result = OceanWave().predict(
            symmetric_chain(), complete_state(), horizons_minutes=(30.0,),
            market_context={"inverse_signal": 0.0, "inverse_confidence": 1.0,
                            "macro_signals": dict.fromkeys(macro_names, 0.0),
                            "macro_confidences": dict.fromkeys(macro_names, 1.0)},
        )

        self.assertGreaterEqual(result.evidence_quality, 0.25)
        self.assertGreaterEqual(result.diagnostics["market_data_quality"], 0.50)
        self.assertEqual(result.direction, "Abstain")
        self.assertEqual(result.actionability, "abstain")
        self.assertEqual(result.abstain_reason, "weak_directional_edge")
        self.assertEqual(result.raw_probability, result.expectations[30.0].probability_up)
        self.assertLessEqual(
            abs(result.calibrated_probability - 0.5),
            abs(result.raw_probability - 0.5),
        )
        self.assertEqual(result.diagnostics["abstain_reasons"], ["weak_directional_edge"])

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

    def test_event_context_changes_risk_but_not_direction(self) -> None:
        baseline = OceanWave().predict(
            symmetric_chain(), complete_state(), horizons_minutes=(30.0,)
        )
        stressed = OceanWave().predict(
            symmetric_chain(),
            complete_state(),
            event_context=EventContext(
                minutes_to_earnings=5.0,
                minutes_to_macro=15.0,
                event_surprise_z=2.0,
                headline_intensity=0.8,
                confidence=1.0,
            ),
            horizons_minutes=(30.0,),
        )

        self.assertGreater(
            stressed.expectations[30.0].return_variance,
            baseline.expectations[30.0].return_variance,
        )
        self.assertLess(stressed.confidence, baseline.confidence)
        self.assertEqual(stressed.direction, baseline.direction)

    def test_online_state_is_bounded_and_round_trips(self) -> None:
        ratings: dict[tuple[str, float, float], float] = {}
        latest = None
        for spot in np.linspace(99.0, 101.0, 80):
            latest = build_elo_surface(symmetric_chain(), float(spot), ratings=ratings)
        self.assertIsNotNone(latest)
        assert latest is not None
        self.assertLessEqual(len(ratings), 2 * len(latest))

        original = OceanWave()
        original.predict(symmetric_chain(), complete_state(), horizons_minutes=(30.0,))
        state = original.state_dict()
        restored = OceanWave()
        restored.load_state_dict(state)
        self.assertEqual(restored.state_dict(), state)

    def test_oi_change_uses_stable_contract_identity(self) -> None:
        previous = symmetric_chain()
        previous["call_symbol"] = [f"TEST-C-{index}" for index in range(len(previous))]
        previous["put_symbol"] = [f"TEST-P-{index}" for index in range(len(previous))]
        current = previous.copy()
        current["expiry_days"] = np.maximum(current["expiry_days"] - 1.0, 0.0)
        current["call_oi"] += 100.0

        with patch("option_wave.factors.HAS_CPP_CORE", False):
            reference = extract_chain_factors(current, 100.0, previous_chain=previous)
        native = extract_chain_factors(current, 100.0, previous_chain=previous)

        self.assertGreater(native.oi_signal, 0.0)
        self.assertGreater(native.oi_confidence, 0.0)
        self.assertAlmostEqual(native.oi_signal, reference.oi_signal, places=10)
        self.assertAlmostEqual(native.oi_confidence, reference.oi_confidence, places=10)

        unchanged = previous.copy()
        unchanged["expiry_days"] = np.maximum(unchanged["expiry_days"] - 1.0, 0.0)
        with patch("option_wave.factors.HAS_CPP_CORE", False):
            unchanged_reference = extract_chain_factors(
                unchanged, 100.0, previous_chain=previous
            )
        unchanged_native = extract_chain_factors(
            unchanged, 100.0, previous_chain=previous
        )
        self.assertEqual(unchanged_reference.oi_signal, 0.0)
        self.assertEqual(unchanged_reference.oi_confidence, 0.0)
        self.assertEqual(unchanged_native.oi_signal, 0.0)
        self.assertEqual(unchanged_native.oi_confidence, 0.0)


if __name__ == "__main__":
    unittest.main()
