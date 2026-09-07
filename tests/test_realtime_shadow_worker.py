"""Offline protocol checks against the real persistent worker process."""
from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
from queue import Empty, Queue
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import unittest

from option_wave.online_forecast import HAS_ONLINE_CORE, OPTION_FEATURES, VERSION


ROOT = Path(__file__).resolve().parents[1]
MAX_REQUEST_BYTES = 256 * 1024


class WorkerProtocol:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self.lines: Queue[str | None] = Queue()
        self.identifier = 0
        self.reader = Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def response(self) -> dict:
        try:
            line = self.lines.get(timeout=15)
        except Empty as exc:
            raise AssertionError("worker did not respond within 15 seconds") from exc
        if line is None:
            raise AssertionError("worker exited before returning the expected response")
        return json.loads(line)

    def request(self, command: str, **payload) -> dict:
        self.identifier += 1
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps({"id": self.identifier, "command": command, **payload}, allow_nan=False) + "\n")
        self.process.stdin.flush()
        response = self.response()
        if response.get("id") != self.identifier or response.get("ok") is not True:
            raise AssertionError(f"unexpected worker response: {response}")
        return response["result"]


@contextmanager
def offline_worker():
    with TemporaryDirectory(prefix="ocean-wave-shadow-protocol-") as state_dir:
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "scripts" / "realtime_worker.py"),
             "--state-dir", state_dir, "--max-requests", "10"],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        worker = WorkerProtocol(process)
        try:
            ready = worker.response()
            if ready.get("event") != "ready" or ready.get("native_core") is not True:
                raise AssertionError(f"worker did not initialize the native core: {ready}")
            yield worker
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            worker.reader.join(timeout=5)
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()


@unittest.skipUnless(HAS_ONLINE_CORE, "upgraded C++ shadow core is not installed")
class RealtimeShadowWorkerTests(unittest.TestCase):
    def test_v3_measured_option_structure_and_old_state_rejection(self):
        values = (.4, .9, .03, .3, .02, .1, .04, -.2, .3, .8, 9.)
        option_features = dict(zip(OPTION_FEATURES, values))
        with offline_worker() as worker:
            receipt = worker.request("shadow_forecast", symbol="AAPL", horizon=30,
                stock_features={"return_5m": .002}, option_features=option_features,
                quality=.8, origin_price=200., forecast_id="structure-v3", issued_at=1_788_800_000.)
            self.assertEqual(receipt["model_version"], VERSION)
            self.assertEqual(receipt["feature_version"], 3)
            self.assertEqual(receipt["option_features"], option_features)
            self.assertEqual(receipt["option_feature_coverage"], 1.)
            self.assertEqual(receipt["option_quality"], .8)
            self.assertIn("option.premium_elo_signal", receipt["feature_attributions"]["option_and_context"])
            checkpoint = worker.request("shadow_export")
            self.assertEqual(checkpoint["models"], {})
            with self.assertRaisesRegex(AssertionError, "incompatible model version"):
                worker.request("shadow_forecast", state={"model_version": "online_forecast.v2", "shadow_only": True, "models": {}},
                    symbol="AAPL", horizon=30, stock_features=None, option_features=None,
                    quality=0., origin_price=200., forecast_id="old-state-v2", issued_at=1_788_800_000.)
            self.assertEqual(worker.request("shadow_export"), checkpoint)
            worker.request("shutdown")
            self.assertEqual(worker.process.wait(timeout=5), 0)

    def test_raw_context_is_revalidated_before_shadow_learning_features(self):
        with offline_worker() as worker:
            receipt = worker.request("shadow_forecast", symbol="QQQ", horizon=30,
                stock_features={"return_5m": 0.002}, option_features={}, quality=0.7, origin_price=200.0,
                forecast_id="invalid-context", issued_at="2026-09-08T14:00:00Z",
                market_context={"schema_version": "wrong-version", "instruments": {}},
                context_features={"gold_return_5m": 0.99, "vix_level": 80})
            self.assertTrue(all(value is None for value in receipt["context_features"].values()))
            worker.request("shutdown")
            self.assertEqual(worker.process.wait(timeout=5), 0)

    def test_real_worker_predict_replay_checkpoint_restore_and_shutdown(self):
        issued = 1_788_800_000.0
        with offline_worker() as worker:
            receipts = {}
            for symbol in ("QQQ", "SPY", "TSLA", "AAPL"):
                receipts[symbol] = worker.request("shadow_forecast", symbol=symbol, horizon=30,
                    stock_features={"return_5m": 0.002, "realized_vol": 0.4},
                    option_features={"iv_level": 0.4}, quality=0.7, origin_price=200.0,
                    forecast_id=f"{symbol}-offline-1", issued_at=issued)
                self.assertEqual(receipts[symbol]["symbol"], symbol)
                self.assertEqual(receipts[symbol]["trained_samples"], 0)
                self.assertTrue(receipts[symbol]["shadow_only"])
            receipt = receipts["TSLA"]
            learned = worker.request("shadow_feedback", frozen_forecast=receipt,
                actual_return=0.01, event_id="offline-tsla-mature", eligible=True,
                matured_at=receipt["matures_at"], replay=True)
            self.assertTrue(learned["updated"])
            self.assertTrue(learned["replay_reencoded"])
            self.assertEqual(learned["trained_samples"], 1)
            checkpoint = worker.request("shadow_export")
            self.assertEqual(set(checkpoint["models"]), {"TSLA:30"})
            worker.request("shadow_reset")
            self.assertEqual(worker.request("shadow_export")["models"], {})
            restored = worker.request("shadow_forecast", state=checkpoint,
                symbol="TSLA", horizon=30, stock_features={"return_5m": 0.002},
                option_features=None, quality=0.0, origin_price=202.0,
                forecast_id="TSLA-offline-restored", issued_at=receipt["matures_at"])
            self.assertEqual(restored["trained_samples"], 1)
            duplicate = worker.request("shadow_feedback", frozen_forecast=receipt,
                actual_return=0.01, event_id="offline-tsla-mature", eligible=True,
                matured_at=receipt["matures_at"], replay=True)
            self.assertEqual(duplicate["reason"], "duplicate")
            self.assertEqual(worker.request("shutdown")["status"], "stopping")
            self.assertEqual(worker.process.wait(timeout=10), 0)

    def test_unterminated_oversized_request_is_rejected_and_process_exits(self):
        with offline_worker() as worker:
            assert worker.process.stdin is not None
            # No newline or EOF is required to trigger the bounded read limit.
            worker.process.stdin.write("x" * (MAX_REQUEST_BYTES + 1))
            worker.process.stdin.flush()
            response = worker.response()
            self.assertFalse(response["ok"])
            self.assertIn("size limit", response["error"])
            self.assertEqual(worker.process.wait(timeout=10), 0)


if __name__ == "__main__":
    unittest.main()
