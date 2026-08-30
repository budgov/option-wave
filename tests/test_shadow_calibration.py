import errno
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from option_wave.shadow_calibration import ShadowCalibrator


class ShadowCalibrationTests(unittest.TestCase):
    def test_feedback_state_retries_a_transient_atomic_replace_lock(self) -> None:
        real_replace = os.replace
        attempts = 0

        def flaky_replace(source: str, target: str | Path) -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError(errno.EACCES, "temporarily locked")
            real_replace(source, target)

        with tempfile.TemporaryDirectory() as directory:
            calibrator = ShadowCalibrator(
                Path(directory),
                learning_rate=0.025,
                minimum_samples=10,
                minimum_promotion_samples=10,
                minimum_valid_days=20,
            )
            with (
                patch("option_wave._atomic_io.os.replace", side_effect=flaky_replace),
                patch("option_wave._atomic_io.sleep") as pause,
            ):
                result = calibrator.apply_feedback({
                    "event_id": "position-lock-retry",
                    "symbol": "SPY",
                    "option_type": "call",
                    "predicted_profit_probability": 0.65,
                    "observed_profitable": True,
                })

            self.assertEqual(result["status"], "updated")
            self.assertEqual(attempts, 2)
            pause.assert_called_once_with(0.01)
            persisted = json.loads((Path(directory) / "shadow-calibration.v1.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["global"]["samples"], 1)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_feedback_is_bounded_persistent_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calibrator = ShadowCalibrator(Path(directory), learning_rate=0.025, minimum_samples=10)
            event = {
                "event_id": "position-1",
                "symbol": "SPY",
                "option_type": "call",
                "predicted_profit_probability": 0.65,
                "observed_profitable": True,
                "session_date": "2026-07-01",
            }
            updated = calibrator.apply_feedback(event)
            self.assertEqual(updated["status"], "updated")
            self.assertEqual(updated["global_samples"], 1)
            duplicate = calibrator.apply_feedback(event)
            self.assertEqual(duplicate["status"], "duplicate_ignored")
            self.assertEqual(duplicate["global_samples"], 1)

            reloaded = ShadowCalibrator(
                Path(directory),
                learning_rate=0.025,
                minimum_samples=10,
                minimum_promotion_samples=10,
                minimum_valid_days=20,
            )
            projection = reloaded.project("SPY", 0.65)
            self.assertEqual(projection["deployment_status"], "shadow_only")
            self.assertFalse(projection["promotion_eligible"])
            self.assertGreaterEqual(projection["calibrated_profit_probability"], 0.0)
            self.assertLessEqual(projection["calibrated_profit_probability"], 1.0)

            for index in range(2, 22):
                reloaded.apply_feedback({
                    **event,
                    "event_id": f"position-{index}",
                    "observed_profitable": index % 2 == 0,
                    "session_date": f"2026-07-{index:02d}",
                })
            state = reloaded.state
            self.assertGreaterEqual(state["global"]["intercept"], -1.5)
            self.assertLessEqual(state["global"]["intercept"], 1.5)
            self.assertGreaterEqual(state["global"]["slope"], 0.5)
            self.assertLessEqual(state["global"]["slope"], 1.5)
            self.assertTrue(reloaded.project("SPY", 0.65)["promotion_eligible"])

    def test_calibration_only_shrinks_and_two_valid_days_cannot_promote(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calibrator = ShadowCalibrator(Path(directory), minimum_samples=10)
            for index in range(40):
                calibrator.apply_feedback({
                    "event_id": f"two-day-{index}",
                    "symbol": "SPY",
                    "predicted_profit_probability": 0.80,
                    "observed_profitable": True,
                    "session_date": "2026-08-27" if index % 2 == 0 else "2026-08-28",
                    "training_day_valid": True,
                })

            projection = calibrator.project("SPY", 0.80)
            self.assertGreaterEqual(projection["calibrated_profit_probability"], 0.50)
            self.assertLess(projection["calibrated_profit_probability"], 0.80)
            self.assertEqual(projection["valid_training_days"], 2)
            self.assertFalse(projection["promotion_eligible"])
            self.assertEqual(projection["minimum_promotion_samples"], 500)
            self.assertEqual(projection["minimum_valid_days"], 40)

    def test_invalid_training_day_does_not_mutate_or_persist_calibration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            calibrator = ShadowCalibrator(Path(directory), minimum_samples=10)
            before = json.dumps(calibrator.state, sort_keys=True)
            status = calibrator.apply_feedback({
                "event_id": "invalid-session",
                "symbol": "QQQ",
                "predicted_profit_probability": 0.70,
                "observed_profitable": True,
                "session_date": "2026-08-29",
                "training_day_valid": False,
            })

            self.assertEqual(status["status"], "invalid_day_ignored")
            self.assertEqual(json.dumps(calibrator.state, sort_keys=True), before)
            self.assertFalse(calibrator.path.exists())


if __name__ == "__main__":
    unittest.main()
