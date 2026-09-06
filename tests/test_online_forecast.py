from __future__ import annotations

import copy
import json
import unittest

from option_wave._backend import cpp_core
from option_wave.online_forecast import (
    HAS_ONLINE_CORE, MAX_RECENT_EVENTS, OnlineForecastChallenger,
)


@unittest.skipUnless(HAS_ONLINE_CORE, "upgraded native online forecast core is not installed")
class OnlineForecastTests(unittest.TestCase):
    def setUp(self) -> None:
        self.model = OnlineForecastChallenger()
        self.issued = 1_788_800_000.0

    def forecast(self, *, symbol="QQQ", horizon=30, issued=None, identifier="forecast-1"):
        return self.model.predict(symbol, horizon,
            {"return_5m": 0.003, "return_15m": 0.006, "vwap_gap": 0.002,
             "relative_volume": 1.4, "realized_vol": 0.35},
            {"iv_skew": 0.03, "iv_level": 0.3}, 0.8, 200.0, identifier,
            self.issued if issued is None else issued)

    def learn(self, receipt, actual=0.01, event="event-1", **kwargs):
        return self.model.learn(receipt, actual, event,
            matured_at=kwargs.pop("matured_at", receipt["matures_at"]), **kwargs)

    def test_predict_is_read_only_and_json_safe_missing_features(self):
        before = self.model.export_state()
        receipt = self.forecast()
        self.assertEqual(before, self.model.export_state())
        self.assertIsNone(receipt["stock_features"]["sector_return_5m"])
        self.assertIsNone(receipt["option_features"]["delta_flow"])
        self.assertTrue(receipt["shadow_only"])
        self.assertEqual(receipt["probability_up"], 0.5)
        self.assertEqual(receipt["readiness"], "warmup")
        self.assertEqual(set(receipt["probabilities_up"]), {"stock", "fused", "trend", "reversion"})
        json.dumps(receipt, allow_nan=False)

    def test_maturity_and_eligibility_are_mandatory_and_do_not_change_state(self):
        receipt = self.forecast()
        before = self.model.export_state()
        self.assertEqual(self.model.learn(receipt, 0.01, "event-1")["reason"], "maturity_required")
        self.assertEqual(self.learn(receipt, matured_at=receipt["matures_at"] - 1)["reason"], "not_mature")
        self.assertEqual(self.learn(receipt, eligible=False)["reason"], "ineligible")
        self.assertEqual(before, self.model.export_state())

    def test_each_forecast_and_event_learn_once_across_checkpoint_roundtrip(self):
        receipt = self.forecast()
        learned = self.learn(receipt)
        self.assertTrue(learned["updated"])
        self.assertEqual(learned["trained_samples"], 1)
        self.assertEqual(self.learn(receipt, event="different-event")["reason"], "duplicate")
        self.model = OnlineForecastChallenger.from_state(json.loads(json.dumps(self.model.export_state())))
        self.assertEqual(self.learn(receipt)["reason"], "duplicate")
        second = self.forecast(issued=receipt["matures_at"], identifier="different-forecast")
        self.assertEqual(self.learn(second)["reason"], "duplicate")
        self.assertEqual(self.learn(second, event="event-2")["trained_samples"], 2)

    def test_labels_are_isolated_by_symbol_and_horizon(self):
        receipt = self.forecast()
        self.learn(receipt)
        later = receipt["matures_at"]
        self.assertEqual(self.forecast(issued=later)["trained_samples"], 1)
        for symbol in ("SPY", "TSLA", "AAPL"):
            self.assertEqual(self.forecast(symbol=symbol, issued=later)["trained_samples"], 0)
        self.assertEqual(self.forecast(horizon=60, issued=later)["trained_samples"], 0)

    def test_modified_receipt_and_future_leakage_are_rejected(self):
        receipt = self.forecast()
        changed = copy.deepcopy(receipt)
        changed["probability_up"] = 0.99
        with self.assertRaisesRegex(ValueError, "modified"):
            self.learn(changed)
        self.learn(receipt)
        with self.assertRaisesRegex(ValueError, "watermark"):
            self.forecast(issued=self.issued + 1)

    def test_feedback_uses_frozen_probability_and_preserves_receipt(self):
        first = self.forecast()
        second = self.forecast(identifier="forecast-2", issued=self.issued + 60)
        copy_second = copy.deepcopy(second)
        self.learn(first)
        learned = self.learn(second, event="event-2", actual=-0.01)
        self.assertEqual(second, copy_second)
        self.assertEqual(learned["brier_sums"], {name: 0.5 for name in first["probabilities_up"]})

    def test_out_of_order_labels_are_rejected_without_mutation(self):
        early = self.forecast()
        later = self.forecast(identifier="later", issued=self.issued + 60)
        self.learn(later)
        before = self.model.export_state()
        self.assertEqual(self.learn(early, event="earlier")["reason"], "stale_or_out_of_order")
        self.assertEqual(before, self.model.export_state())

    def test_memory_is_bounded_and_evicted_duplicates_cannot_return(self):
        oldest = self.forecast()
        for index in range(MAX_RECENT_EVENTS + 20):
            receipt = oldest if index == 0 else self.forecast(
                issued=self.issued + index * 1800, identifier=f"forecast-{index + 1}")
            self.learn(receipt, event=f"event-{index + 1}")
        state = self.model.export_state()
        self.assertEqual(len(state["models"]["QQQ:30"]["recent"]), MAX_RECENT_EVENTS)
        self.assertEqual(len(state["models"]["QQQ:30"]["native_state"]), cpp_core.ONLINE_FORECAST_STATE_SIZE)
        self.assertLess(len(json.dumps(state)), 110_000)
        self.assertEqual(self.learn(oldest, event="new-id-for-old-label")["reason"], "stale_or_out_of_order")
        restored = OnlineForecastChallenger.from_state(state)
        self.assertEqual(restored.export_state(), state)

    def test_state_and_input_validation(self):
        with self.assertRaises(ValueError):
            self.forecast(symbol="UNKNOWN")
        with self.assertRaises(ValueError):
            self.forecast(horizon=0)
        with self.assertRaises(ValueError):
            self.forecast(issued="2026-09-01T10:30:00")
        receipt = self.forecast()
        self.learn(receipt)
        state = self.model.export_state()
        state["models"]["QQQ:30"]["native_state"][0] = -1
        with self.assertRaises(RuntimeError):
            OnlineForecastChallenger.from_state(state)

    def test_replay_overlapping_horizons_after_checkpoint_rollback(self):
        first = self.forecast()
        overlapping = self.forecast(issued=self.issued + 60, identifier="overlap")
        self.learn(first)
        later = self.forecast(issued=first["matures_at"], identifier="trained-receipt")
        self.assertEqual(later["trained_samples"], 1)
        original = copy.deepcopy(later)
        self.model = OnlineForecastChallenger()
        # A receipt can predate the replay state's sample count after removing an
        # invalid day. Training can still be rebuilt; scoring remains original.
        rejected_before = self.model.export_state()
        with self.assertRaisesRegex(RuntimeError, "predates"):
            self.learn(later)
        self.assertEqual(self.model.export_state(), rejected_before)
        for index, receipt in enumerate((first, overlapping, later)):
            result = self.model.learn_replay(receipt, -0.01, f"replay-{index}",
                matured_at=receipt["matures_at"])
            self.assertTrue(result["updated"])
            self.assertTrue(result["replay_reencoded"])
        self.assertEqual(later, original)
        for expert in later["probabilities_up"]:
            expected = sum(receipt["probabilities_up"][expert] ** 2 for receipt in (first, overlapping, later))
            self.assertAlmostEqual(result["brier_sums"][expert], expected)
        self.assertEqual(result["trained_samples"], 3)
        checkpoint = self.model.export_state()
        restored = OnlineForecastChallenger.from_state(checkpoint)
        self.assertEqual(restored.export_state(), checkpoint)

    def test_option_profit_probability_accounts_for_holding_costs_and_vega_units(self):
        zero_cost = cpp_core.option_profit_probability(100.0, 0.0, 0.0001,
            0.5, 0.0, 0.0, 0.1, 0.0, 0.0, 0.0)
        costs = cpp_core.option_profit_probability(100.0, 0.0, 0.0001,
            0.5, 0.0, -0.2, 0.1, 0.0, 0.1, 0.01)
        vol_rise = cpp_core.option_profit_probability(100.0, 0.0, 0.0001,
            0.5, 0.0, -0.2, 0.1, 2.0, 0.1, 0.01)
        self.assertAlmostEqual(zero_cost["probability_profit"], 0.5)
        self.assertLess(costs["probability_profit"], 0.3)
        self.assertAlmostEqual(vol_rise["expected_net_pnl"] - costs["expected_net_pnl"], 0.2)
        self.assertEqual(costs["approximation"], "delta_gamma_normal")


if __name__ == "__main__":
    unittest.main()
