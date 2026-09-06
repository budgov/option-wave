"""Offline regression checks for upgrade state isolation and target semantics."""
from __future__ import annotations

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from option_wave import MarketState
from option_wave.realtime import RealtimePredictor
from option_wave.shadow_calibration import ShadowCalibrator
from benchmarks.benchmark_ocean_wave import make_chain


class UpgradeRuntimeTests(unittest.TestCase):
    def test_stale_chain_is_rejected_before_online_state_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            predictor = RealtimePredictor(Path(directory), async_checkpoints=False)
            runtime = predictor._load("AAPL")
            before = runtime.model.state_dict()
            with patch("option_wave.realtime.SchwabHTTPClient") as client, patch(
                "option_wave.realtime.latest_quote_timestamp", return_value="2026-09-04T13:58:00Z"
            ):
                client.return_value.fetch_market_snapshot.return_value = (make_chain(3, 21), MarketState(spot=100.0))
                result = predictor.predict(symbol="AAPL", signal_published_at="2026-09-04T14:00:00Z",
                    access_token="offline-test", horizons=(30.0,), strike_count=21, maximum_snapshot_age_seconds=15)
            self.assertTrue(result["quarantined"])
            self.assertIn("snapshot_outside_requested_time_window", result["quarantine_reasons"])
            self.assertEqual(runtime.model.state_dict(), before)
            self.assertIsNone(runtime.previous_chain)
            predictor.close()

    def test_invalid_day_prediction_leaves_model_chain_and_checkpoint_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            predictor = RealtimePredictor(Path(directory), async_checkpoints=False)
            runtime = predictor._load("TSLA")
            before = runtime.model.state_dict()
            chain = make_chain(expiries=3, strikes=21)
            with patch("option_wave.realtime.SchwabHTTPClient") as client:
                client.return_value.fetch_market_snapshot.return_value = (chain, MarketState(spot=100.0))
                result = predictor.predict(symbol="TSLA", signal_published_at="2026-09-04T14:00:00Z",
                    access_token="offline-test", horizons=(30.0,), strike_count=21, training_day_valid=False)
            self.assertTrue(result["runtime"]["prediction_ran"])
            self.assertFalse(result["runtime"]["state_updated"])
            self.assertEqual(before, runtime.model.state_dict())
            self.assertIsNone(runtime.previous_chain)
            self.assertFalse(runtime.dirty)
            predictor.close()

    def test_negative_outcomes_can_correct_probability_across_half(self):
        with tempfile.TemporaryDirectory() as directory:
            calibrator = ShadowCalibrator(Path(directory), learning_rate=0.1, minimum_samples=10)
            for index in range(300):
                calibrator.apply_feedback({"event_id": str(index), "symbol": "AAPL",
                    "predicted_profit_probability": 0.7, "observed_profitable": False})
            self.assertLess(calibrator.project("AAPL", 0.7)["calibrated_profit_probability"], 0.5)

    def test_legacy_mixed_target_calibration_is_not_loaded(self):
        with tempfile.TemporaryDirectory() as directory:
            legacy = Path(directory) / "shadow-calibration.v1.json"
            # Use the application's atomic writer to create a deliberately
            # incompatible v1 audit file without importing its weights.
            from option_wave.realtime import write_json_atomic
            write_json_atomic(legacy, {"schema_version": "ocean-wave-shadow-calibration.v1", "global": {"samples": 900}})
            calibrator = ShadowCalibrator(Path(directory))
            self.assertEqual(calibrator.project("SPY", 0.6)["global_samples"], 0)
            self.assertTrue(legacy.exists())


if __name__ == "__main__":
    unittest.main()
