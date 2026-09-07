import errno
from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import tempfile
from time import sleep
import unittest
from unittest.mock import patch

from option_wave.shadow_calibration import BASE_MODEL_VERSION, CALIBRATION_SCHEMA, ShadowCalibrator


@contextmanager
def temporary_directory():
    """Remove rapid atomic-write fixtures despite transient WinError 145."""

    directory = tempfile.mkdtemp()
    try:
        yield directory
    finally:
        for attempt in range(8):
            try:
                shutil.rmtree(directory)
                break
            except FileNotFoundError:
                break
            except OSError as error:
                retryable = error.errno == errno.ENOTEMPTY or getattr(error, "winerror", None) == 145
                if not retryable or attempt == 7:
                    raise
                sleep(min(0.25, 0.01 * (2 ** attempt)))


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

        with temporary_directory() as directory:
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
                    "base_model_version": BASE_MODEL_VERSION,
                    "event_id": "position-lock-retry",
                    "symbol": "SPY",
                    "option_type": "call",
                    "predicted_profit_probability": 0.65,
                    "observed_profitable": True,
                })

            self.assertEqual(result["status"], "updated")
            self.assertEqual(attempts, 2)
            pause.assert_called_once_with(0.01)
            persisted = json.loads(calibrator.path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["global"]["samples"], 1)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_feedback_is_bounded_persistent_and_idempotent(self) -> None:
        with temporary_directory() as directory:
            calibrator = ShadowCalibrator(Path(directory), learning_rate=0.025, minimum_samples=10)
            event = {
                "base_model_version": BASE_MODEL_VERSION,
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

    def test_calibration_is_bounded_and_two_valid_days_cannot_promote(self) -> None:
        with temporary_directory() as directory:
            calibrator = ShadowCalibrator(Path(directory), minimum_samples=10)
            for index in range(40):
                calibrator.apply_feedback({
                    "base_model_version": BASE_MODEL_VERSION,
                    "event_id": f"two-day-{index}",
                    "symbol": "SPY",
                    "predicted_profit_probability": 0.80,
                    "observed_profitable": True,
                    "session_date": "2026-08-27" if index % 2 == 0 else "2026-08-28",
                    "training_day_valid": True,
                })

            projection = calibrator.project("SPY", 0.80)
            self.assertGreaterEqual(projection["calibrated_profit_probability"], 0.50)
            self.assertLessEqual(projection["calibrated_profit_probability"], 1.0)
            self.assertEqual(projection["valid_training_days"], 2)
            self.assertFalse(projection["promotion_eligible"])
            self.assertEqual(projection["minimum_promotion_samples"], 500)
            self.assertEqual(projection["minimum_valid_days"], 40)

    def test_invalid_training_day_does_not_mutate_or_persist_calibration(self) -> None:
        with temporary_directory() as directory:
            calibrator = ShadowCalibrator(Path(directory), minimum_samples=10)
            before = json.dumps(calibrator.state, sort_keys=True)
            status = calibrator.apply_feedback({
                "base_model_version": BASE_MODEL_VERSION,
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

    def test_old_model_calibration_files_are_preserved_but_never_loaded(self) -> None:
        with temporary_directory() as directory:
            old_files = {}
            for version in (1, 2, 3):
                legacy = Path(directory) / f"shadow-calibration.v{version}.json"
                content = json.dumps({"schema_version": f"ocean-wave-shadow-calibration.v{version}",
                    "global": {"intercept": 1.5, "slope": 1.5, "samples": 900}})
                legacy.write_text(content, encoding="utf-8")
                old_files[legacy] = content
            calibrator = ShadowCalibrator(Path(directory))
            projection = calibrator.project("SPY", 0.6)
            self.assertEqual(projection["global_samples"], 0)
            self.assertAlmostEqual(projection["calibrated_profit_probability"], 0.6)
            self.assertEqual(projection["base_model_version"], BASE_MODEL_VERSION)
            self.assertEqual(calibrator.path.name, "shadow-calibration.v4.json")
            self.assertFalse(calibrator.path.exists())
            for filename, content in old_files.items():
                self.assertEqual(filename.read_text(encoding="utf-8"), content)

    def test_new_filename_does_not_authorize_an_old_or_unversioned_bucket(self) -> None:
        with temporary_directory() as directory:
            filename = Path(directory) / "shadow-calibration.v4.json"
            for version in (None, "ocean-wave.legacy-nine-factor.v1", "ocean-wave.group-budget.v3"):
                payload = {"schema_version": CALIBRATION_SCHEMA,
                    "global": {"intercept": 1.5, "slope": 1.5, "samples": 900}}
                if version is not None:
                    payload["base_model_version"] = version
                filename.write_text(json.dumps(payload), encoding="utf-8")
                before = filename.read_bytes()
                with self.assertRaisesRegex(ValueError, "base model version"):
                    ShadowCalibrator(Path(directory))
                self.assertEqual(filename.read_bytes(), before)

    def test_feedback_requires_the_base_model_version_frozen_at_entry(self) -> None:
        with temporary_directory() as directory:
            calibrator = ShadowCalibrator(Path(directory))
            event = {"event_id": "old-position-closes-after-upgrade", "symbol": "SPY",
                "predicted_profit_probability": 0.9, "observed_profitable": True}
            before = json.dumps(calibrator.state, sort_keys=True)
            for version in (None, "ocean-wave.legacy-nine-factor.v1", "ocean-wave.group-budget.v3"):
                feedback = event if version is None else {**event, "base_model_version": version}
                result = calibrator.apply_feedback(feedback)
                self.assertEqual(result["status"], "incompatible_base_model_ignored")
                self.assertEqual(json.dumps(calibrator.state, sort_keys=True), before)
                self.assertFalse(calibrator.path.exists())
            result = calibrator.apply_feedback({**event, "base_model_version": BASE_MODEL_VERSION})
            self.assertEqual(result["status"], "updated")
            persisted = json.loads(calibrator.path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["schema_version"], CALIBRATION_SCHEMA)
            self.assertEqual(persisted["base_model_version"], BASE_MODEL_VERSION)


if __name__ == "__main__":
    unittest.main()
