"""Offline regression checks for upgrade state isolation and target semantics."""
from __future__ import annotations

from pathlib import Path
from datetime import datetime, timezone
import tempfile
import unittest
from unittest.mock import patch

from option_wave import MarketState
from option_wave.realtime import RealtimePredictor, audit_option_chain
from option_wave.schwab_api import SchwabHTTPClient
from option_wave.shadow_calibration import BASE_MODEL_VERSION, ShadowCalibrator
from benchmarks.benchmark_ocean_wave import make_chain


class UpgradeRuntimeTests(unittest.TestCase):
    def test_missing_broker_timestamp_never_becomes_collection_time(self):
        with tempfile.TemporaryDirectory() as directory:
            predictor = RealtimePredictor(Path(directory), async_checkpoints=False)
            try:
                chain = make_chain(3, 21)
                with patch("option_wave.realtime.SchwabHTTPClient") as client, patch(
                    "option_wave.realtime.latest_quote_timestamp", return_value=None
                ):
                    client.return_value.fetch_market_snapshot.return_value = (chain, MarketState(spot=100.))
                    result = predictor.predict(symbol="AAPL", signal_published_at="2026-09-08T13:30:00Z",
                        access_token="offline-test", horizons=(30.,), strike_count=21,
                        maximum_snapshot_age_seconds=15)
                self.assertTrue(result["quarantined"])
                self.assertIn("snapshot_timestamp_unavailable", result["quarantine_reasons"])
                self.assertIsNone(result["observed_at"])
                self.assertIsNone(result["as_of"])
                self.assertIsInstance(result["captured_at"], str)
                self.assertFalse(result["runtime"]["state_updated"])
            finally:
                predictor.close()

    def test_observed_schwab_holiday_sentinels_never_train_or_retimestamp_old_quotes(self):
        # Observed in the read-only QQQ chain preflight on Labor Day,
        # 2026-09-07: positive prices, -999 Greeks/IV, quoteTime=0 and
        # a last-trade timestamp from the preceding Friday. No account data.
        collected_at = "2026-09-07T21:44:16.326Z"
        prior_trade_ms = 1788552896966
        prior_trade_at = datetime.fromtimestamp(prior_trade_ms / 1000, tz=timezone.utc)
        payload = {"symbol": "QQQ", "status": "SUCCESS", "isDelayed": False,
                   "collection_time": collected_at}
        for side, map_name in (("CALL", "callExpDateMap"), ("PUT", "putExpDateMap")):
            payload[map_name] = {"2026-09-08:1": {"718.0": [{
                "symbol": f"QQQ   260908{side[0]}00718000", "putCall": side,
                "strikePrice": 718.0, "bid": 2.73, "ask": 2.75, "last": 2.74,
                "openInterest": 100, "totalVolume": 10,
                "volatility": -999, "delta": -999, "gamma": -999, "theta": -999,
                "vega": -999, "rho": -999, "quoteTimeInLong": 0,
                "tradeTimeInLong": prior_trade_ms, "collection_time": collected_at,
            }]}}
        chain = SchwabHTTPClient.normalize_option_chain(payload, as_of=collected_at)
        audit = audit_option_chain(chain, 718.0)
        self.assertFalse(audit.accepted)
        for side in ("call", "put"):
            self.assertLess(chain.iloc[0][f"{side}_iv"], 0.0)
            self.assertEqual(chain.iloc[0][f"{side}_delta"], -999.0)
            self.assertEqual(chain.iloc[0][f"{side}_gamma"], -999.0)
            self.assertEqual(chain.iloc[0][f"{side}_theta"], -999.0)
            self.assertEqual(datetime.fromisoformat(chain.iloc[0][f"{side}_trade_timestamp"]), prior_trade_at)
            # Zero may remain an epoch sentinel or become missing, but neither
            # collection time nor the last-trade time may become a quote time.
            quote_at = chain.iloc[0][f"{side}_quote_timestamp"]
            self.assertNotEqual(quote_at, collected_at)
            self.assertNotEqual(quote_at, chain.iloc[0][f"{side}_trade_timestamp"])
            if quote_at is not None:
                self.assertLess(datetime.fromisoformat(quote_at), prior_trade_at)
            for invalid in ("iv", "delta", "gamma", "vega"):
                self.assertIn(f"{side}_invalid_{invalid}", audit.reasons)

        # Test both callers requiring current-time alignment and legacy callers:
        # explicit invalid broker evidence must quarantine in either case.
        for max_age in (None, 15):
            with self.subTest(maximum_snapshot_age_seconds=max_age), tempfile.TemporaryDirectory() as directory:
                state_dir = Path(directory)
                predictor = RealtimePredictor(state_dir, async_checkpoints=False)
                runtime = predictor._load("QQQ")
                predictor._checkpoint("QQQ", runtime, asynchronous=False)
                before_model = runtime.model.state_dict()
                before_history = (runtime.gex_history, runtime.oi_history)
                before_files = {file.name: file.read_bytes() for file in state_dir.iterdir() if file.is_file()}
                try:
                    with patch("option_wave.realtime.SchwabHTTPClient") as client, patch.object(
                        runtime.model, "predict", side_effect=AssertionError("Quarantined chain reached model")
                    ) as model_predict:
                        client.return_value.fetch_market_snapshot.return_value = (chain, MarketState(spot=718.0))
                        result = predictor.predict(symbol="QQQ", signal_published_at=collected_at,
                            access_token="offline-test", horizons=(30.0,), strike_count=2,
                            expiry="2026-09-08", strike=718.0, option_type="call",
                            maximum_snapshot_age_seconds=max_age)
                        model_predict.assert_not_called()
                    self.assertTrue(result["quarantined"])
                    self.assertFalse(result["execution_eligible"])
                    self.assertFalse(result["runtime"]["prediction_ran"])
                    self.assertFalse(result["runtime"]["state_updated"])
                    self.assertEqual(result["runtime"]["checkpoint"], "none")
                    self.assertIsNone(result["ocean_wave"])
                    self.assertIn("call_invalid_iv", result["quarantine_reasons"])
                    if max_age is not None:
                        self.assertTrue({"snapshot_outside_requested_time_window", "snapshot_timestamp_unavailable"}
                            .intersection(result["quarantine_reasons"]))
                    self.assertNotEqual(result["observed_at"], result["captured_at"])
                    self.assertNotEqual(result["observed_at"], collected_at)
                    self.assertEqual(runtime.model.state_dict(), before_model)
                    self.assertEqual((runtime.gex_history, runtime.oi_history), before_history)
                    self.assertIsNone(runtime.previous_chain)
                    self.assertFalse(runtime.dirty)
                finally:
                    predictor.close()
                after_files = {file.name: file.read_bytes() for file in state_dir.iterdir() if file.is_file()}
                self.assertEqual(before_files, after_files)

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
                    "base_model_version": BASE_MODEL_VERSION,
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
