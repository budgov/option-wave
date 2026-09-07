from __future__ import annotations

import copy
import json
import math
import random
import unittest

from option_wave._backend import cpp_core
from option_wave.online_forecast import (
    CONTEXT_FEATURES, HAS_ONLINE_CORE, MAX_RECENT_EVENTS, OPTION_FEATURES,
    STOCK_FEATURES, VERSION, OnlineForecastChallenger,
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
        self.assertNotIn("delta_flow", receipt["option_features"])
        self.assertIsNone(receipt["context_features"]["gold_return_5m"])
        self.assertIsNone(receipt["option_features"]["premium_elo_signal"])
        self.assertEqual(len(receipt["option_features"]), 11)
        self.assertAlmostEqual(receipt["option_feature_coverage"], 2 / 11)
        self.assertEqual(receipt["option_quality"], .8)
        self.assertTrue(receipt["shadow_only"])
        self.assertEqual(receipt["probability_up"], 0.5)
        self.assertEqual(receipt["readiness"], "warmup")
        self.assertEqual(set(receipt["probabilities_up"]), {"stock", "fused", "context", "trend", "reversion"})
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

    def context_forecast(self, *, issued=None, identifier="context-1", context=None):
        values = {"inverse_return_5m": .002, "inverse_return_15m": .004,
                  "gold_return_5m": .003, "treasury_10y_change_bps": 2.,
                  "dollar_return_5m": .001, "vix_change": -.5, "vix_level": 21.}
        return self.model.predict("AAPL", 30, None, None, 0.0, 200., identifier,
                                  self.issued if issued is None else issued,
                                  context_features=values if context is None else context)

    def test_v3_context_learns_without_options_or_option_quality(self):
        receipt = self.context_forecast()
        self.assertEqual(receipt["model_version"], "online_forecast.v3")
        self.assertEqual(receipt["feature_version"], 3)
        self.assertEqual(receipt["context_quality"], 1.)
        self.assertEqual(receipt["input_quality"], 0.)
        self.assertTrue(all(value is None for value in receipt["option_features"].values()))
        before = self.model.export_state()
        self.assertEqual(before["models"], {})
        learned = self.learn(receipt, event="context-label", actual=.01)
        self.assertTrue(learned["updated"])
        packed = self.model.export_state()["models"]["AAPL:30"]["native_state"]
        # The public native pack starts with sample count, then feature counts.
        # Unknown stock/options must not become synthetic zero observations.
        feature_counts = packed[1:1 + len(STOCK_FEATURES) + len(OPTION_FEATURES) + len(CONTEXT_FEATURES)]
        context_offset = len(STOCK_FEATURES) + len(OPTION_FEATURES)
        self.assertEqual(feature_counts[:context_offset], [0.] * context_offset)
        self.assertEqual(feature_counts[context_offset:], [1.] * len(CONTEXT_FEATURES))
        later = self.context_forecast(issued=receipt["matures_at"], identifier="context-2")
        self.assertGreater(later["probabilities_up"]["context"], later["probabilities_up"]["stock"])
        self.assertEqual(later["probabilities_up"]["fused"], later["probabilities_up"]["stock"])
        without_context = self.context_forecast(issued=receipt["matures_at"], identifier="missing-context", context={})
        self.assertEqual(without_context["context_quality"], 0.)
        self.assertEqual(without_context["probabilities_up"]["context"], without_context["probabilities_up"]["stock"])

    def test_old_v1_and_v2_state_and_receipt_are_rejected_without_mutation(self):
        receipt = self.context_forecast()
        before = self.model.export_state()
        for version in ("online_forecast.v1", "online_forecast.v2"):
            old_state = copy.deepcopy(before)
            old_state["model_version"] = version
            with self.assertRaisesRegex(ValueError, "incompatible model version"):
                OnlineForecastChallenger.from_state(old_state)
            old_receipt = copy.deepcopy(receipt)
            old_receipt["model_version"] = version
            with self.assertRaisesRegex(ValueError, "incompatible model version"):
                self.learn(old_receipt)
        self.assertEqual(before, self.model.export_state())
        self.assertEqual(VERSION, "online_forecast.v3")

    def test_removed_flow_and_oi_placeholders_cannot_enter_v3(self):
        before = self.model.export_state()
        for removed in ("delta_flow", "oi_change"):
            with self.assertRaisesRegex(ValueError, "unknown feature names"):
                self.model.predict("QQQ", 30, None, {removed: .5}, .8, 200., removed, self.issued)
        self.assertEqual(before, self.model.export_state())

    def test_context_receipt_is_frozen_and_replay_preserves_original_scores(self):
        first = self.context_forecast()
        self.learn(first, event="first-context")
        frozen = self.context_forecast(issued=first["matures_at"], identifier="trained-context")
        original = copy.deepcopy(frozen)
        changed = copy.deepcopy(frozen)
        changed["context_features"]["gold_return_5m"] = -.9
        with self.assertRaisesRegex(ValueError, "modified"):
            self.learn(changed, event="tampered-context")
        self.model = OnlineForecastChallenger()
        rebuilt = self.model.learn_replay(frozen, 0., "replay-context", matured_at=frozen["matures_at"])
        self.assertTrue(rebuilt["updated"])
        self.assertTrue(rebuilt["replay_reencoded"])
        self.assertEqual(rebuilt["scoring_source"], "original_frozen_forecast")
        self.assertEqual(frozen, original)
        for expert, probability in frozen["probabilities_up"].items():
            self.assertAlmostEqual(rebuilt["brier_sums"][expert], probability * probability)
        expected_score = -1 if frozen["probability_up"] > .5 else 1
        self.assertEqual(rebuilt["direction_score"], expected_score)
        duplicate = self.model.learn_replay(frozen, 0., "another-context-event", matured_at=frozen["matures_at"])
        self.assertEqual(duplicate["reason"], "duplicate")
        packed = self.model.export_state()["models"]["AAPL:30"]["native_state"]
        context_start = 1 + len(STOCK_FEATURES) + len(OPTION_FEATURES)
        self.assertEqual(packed[context_start:context_start + len(CONTEXT_FEATURES)], [1.] * len(CONTEXT_FEATURES))

    def test_flat_outcome_is_not_up_and_each_label_scores_exactly_plus_or_minus_one(self):
        # A neutral 0.5 forecast resolves as not-up for deterministic scoring;
        # zero outcomes are never excluded or represented by an abstain score.
        for actual, expected in ((0., 1.), (-0., 1.), (-.01, 1.), (.01, -1.), (1e-12, -1.)):
            self.model = OnlineForecastChallenger()
            receipt = self.forecast()
            self.assertEqual(receipt["probability_up"], .5)
            learned = self.learn(receipt, actual=actual)
            self.assertEqual(learned["direction_score"], expected)
            self.assertEqual(learned["trained_samples"], 1)
            self.assertEqual(learned["brier_sums"], {name: .25 for name in receipt["probabilities_up"]})

        self.model = OnlineForecastChallenger()
        first = self.model.predict("SPY", 30, None, None, 0., 200., "up-training", self.issued)
        first_result = self.learn(first, actual=.01, event="up-label")
        upward = self.model.predict("SPY", 30, None, None, 0., 200., "upward", first["matures_at"])
        self.assertGreater(upward["probability_up"], .5)
        flat_result = self.learn(upward, actual=0., event="flat-label")
        self.assertEqual(flat_result["direction_score"] - first_result["direction_score"], -1.)

    def test_elo_has_observed_confidence_and_optional_columns_do_not_dilute_quality(self):
        for confidence in (None, 0., 1.):
            options = {"premium_elo_signal": .8, "premium_elo_confidence": confidence}
            receipt = self.model.predict("QQQ", 30, None, options, .9, 100., "elo-gate", self.issued)
            total_features = len(STOCK_FEATURES) + len(OPTION_FEATURES) + len(CONTEXT_FEATURES)
            effective_seen = receipt["frozen_native"][total_features:2 * total_features]
            self.assertEqual(effective_seen[len(STOCK_FEATURES)], 1. if confidence == 1. else 0.)
            transform = receipt["feature_attributions"]["transforms"]["option.premium_elo_signal"]
            self.assertEqual(transform["observed"], confidence == 1.)
            if confidence != 1.:
                self.assertEqual(transform["conditional_design"], 0.)
            self.assertEqual(receipt["option_features"]["premium_elo_confidence"], confidence)
            if confidence == 1.:
                self.assertAlmostEqual(receipt["option_feature_coverage"], 2 / len(OPTION_FEATURES))
                self.assertEqual(receipt["option_quality"], .9)
        with self.assertRaisesRegex(ValueError, "contain 11 values"):
            self.model.predict("QQQ", 30, None, [.02, .3, .1], .9, 100., "old-three-inputs", self.issued)

    def test_interactions_require_all_measured_parents(self):
        receipt = self.model.predict("QQQ", 30, None,
            {"premium_elo_signal": .8, "premium_elo_confidence": 1.}, 1., 100., "masked-interaction", self.issued)
        feature_count = len(STOCK_FEATURES) + len(OPTION_FEATURES) + len(CONTEXT_FEATURES)
        residual_offset = 2 * feature_count + 1 + 2 * len(STOCK_FEATURES)
        residual_size = 2 * (len(OPTION_FEATURES) + len(CONTEXT_FEATURES)) + 3
        residual = receipt["frozen_native"][residual_offset:residual_offset + residual_size]
        self.assertEqual(residual[-3:], [0., 0., 0.])
        present = self.model.predict("QQQ", 30, {"return_5m": .003},
            {"premium_elo_signal": .8, "premium_elo_confidence": 1., "iv_skew": .04,
             "gamma_concentration": .5, "iv_term_slope": .02}, 1., 100., "present-interaction", self.issued)
        present_residual = present["frozen_native"][residual_offset:residual_offset + residual_size]
        self.assertTrue(all(abs(value) > 0. for value in present_residual[-3:]))

    def test_hedge_softmax_is_exactly_driven_by_frozen_loss_and_weak_prior(self):
        expected_logs = None
        for index in range(24):
            receipt = self.forecast(issued=self.issued + index * 1800, identifier=f"hedge-{index}")
            if expected_logs is None:
                expected_logs = {expert: 0. for expert in receipt["probabilities_up"]}
            exponentials = {expert: math.exp(value) for expert, value in expected_logs.items()}
            denominator = sum(exponentials.values())
            for expert, value in exponentials.items():
                self.assertAlmostEqual(receipt["expert_weights"][expert], value / denominator, places=12)
            target = 1. if index % 4 else 0.
            rule = receipt["expert_weight_rule"]
            raw_logs = {expert: (1. - rule["prior_reversion"]) * expected_logs[expert]
                        - rule["eta"] * (probability - target) ** 2
                        for expert, probability in receipt["probabilities_up"].items()}
            largest = max(raw_logs.values())
            expected_logs = {expert: max(rule["log_weight_minimum"], value - largest)
                             for expert, value in raw_logs.items()}
            self.learn(receipt, actual=.01 if target else -.01, event=f"hedge-label-{index}")
        # With differentiated frozen probabilities, these are learned weights,
        # not the unchanged five-way initial allocation.
        self.assertGreater(max(expected_logs.values()) - min(expected_logs.values()), 0.)

    def test_prequential_elo_learning_escapes_old_logit_and_expert_floor_limits(self):
        rng = random.Random(10293)
        stock = {"return_5m": 0., "return_15m": 0., "vwap_gap": 0.,
                 "relative_volume": 1., "realized_vol": .25}
        # Synthetic independent signs isolate recoverable ELO information.
        # Each receipt is issued before its label; this is not a market claim.
        for index in range(800):
            sign = 1. if rng.random() > .5 else -1.
            receipt = self.model.predict("QQQ", 30, stock,
                {"premium_elo_signal": .7 * sign, "premium_elo_confidence": 1.},
                1., 100., f"synthetic-elo-{index}", self.issued + index * 1800)
            self.learn(receipt, actual=.006 * sign, event=f"synthetic-label-{index}")
        before = self.model.export_state()
        future = self.issued + 800 * 1800
        up = self.model.predict("QQQ", 30, stock, {"premium_elo_signal": .7, "premium_elo_confidence": 1.},
                                1., 100., "elo-up-oos", future)
        down = self.model.predict("QQQ", 30, stock, {"premium_elo_signal": -.7, "premium_elo_confidence": 1.},
                                  1., 100., "elo-down-oos", future)
        self.assertEqual(before, self.model.export_state())
        self.assertGreater(up["probabilities_up"]["fused"], .65)
        self.assertLess(down["probabilities_up"]["fused"], .35)
        self.assertGreater(up["probability_up"] - down["probability_up"], .25)
        self.assertGreater(up["expert_weights"]["fused"], .60)
        self.assertTrue(all(math.isfinite(value) and value > 0. for value in up["expert_weights"].values()))
        self.assertAlmostEqual(sum(up["expert_weights"].values()), 1.)
        self.assertEqual(up["expert_weight_rule"]["hard_floor"], 0.)
        self.assertGreater(up["feature_attributions"]["option_and_context"]["option.premium_elo_signal"], 0.)
        self.assertLess(down["feature_attributions"]["option_and_context"]["option.premium_elo_signal"], 0.)

        terms = up["feature_attributions"]["option_and_context"]
        option_sum = sum(value for name, value in terms.items() if not name.startswith(("context.", "missing.context.")))
        self.assertAlmostEqual(up["option_logit_increment"], max(-4., min(4., option_sum)), places=12)
        stock_sum = sum(up["feature_attributions"]["stock"].values())
        self.assertAlmostEqual(up["stock_logit"], max(-4., min(4., stock_sum)), places=12)
        low_confidence = self.model.predict("QQQ", 30, stock,
            {"premium_elo_signal": .7, "premium_elo_confidence": .5}, 1., 100., "elo-low-confidence", future)
        low_term = low_confidence["feature_attributions"]["option_and_context"]["option.premium_elo_signal"]
        self.assertAlmostEqual(low_term, .5 * terms["option.premium_elo_signal"], places=12)
        rejected = self.model.predict("QQQ", 30, stock,
            {"premium_elo_signal": .7, "premium_elo_confidence": 1.}, 0., 100., "elo-low-quality", future)
        self.assertEqual(rejected["probabilities_up"]["fused"], rejected["probabilities_up"]["stock"])
        self.assertEqual(rejected["feature_attributions"]["option_and_context"]["option.premium_elo_signal"], 0.)

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
