"""Bounded, auditable online calibration for the Ocean Wave shadow challenger."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any

from ._atomic_io import replace_with_retry


def _clip(value: float, lower: float, upper: float) -> float:
    return min(upper, max(lower, float(value)))


def _sigmoid(value: float) -> float:
    if value >= 0.0:
        inverse = math.exp(-value)
        return 1.0 / (1.0 + inverse)
    exponent = math.exp(value)
    return exponent / (1.0 + exponent)


def _logit(probability: float) -> float:
    bounded = _clip(probability, 1e-6, 1.0 - 1e-6)
    return math.log(bounded / (1.0 - bounded))


def _new_bucket() -> dict[str, Any]:
    return {"intercept": 0.0, "slope": 1.0, "samples": 0}


class ShadowCalibrator:
    """Updates a challenger only; it never changes production model weights."""

    def __init__(
        self,
        state_dir: Path,
        *,
        learning_rate: float = 0.025,
        minimum_samples: int = 30,
        minimum_promotion_samples: int = 500,
        minimum_valid_days: int = 40,
    ) -> None:
        self.path = Path(state_dir).resolve() / "shadow-calibration.v1.json"
        self.learning_rate = _clip(learning_rate, 0.001, 0.1)
        self.minimum_samples = max(10, int(minimum_samples))
        self.minimum_promotion_samples = max(
            self.minimum_samples,
            int(minimum_promotion_samples),
        )
        self.minimum_valid_days = max(20, int(minimum_valid_days))
        self.state = self._read()

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {
                "schema_version": "ocean-wave-shadow-calibration.v1",
                "updated_at": None,
                "global": _new_bucket(),
                "symbols": {},
                "recent_event_ids": [],
                "valid_training_days": [],
            }
        payload = json.loads(self.path.read_text(encoding="utf-8"))
        if payload.get("schema_version") != "ocean-wave-shadow-calibration.v1":
            raise ValueError("invalid shadow calibration state")
        return payload

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".shadow-calibration.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                json.dump(self.state, stream, ensure_ascii=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            replace_with_retry(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _update_bucket(self, bucket: dict[str, Any], probability: float, outcome: float) -> dict[str, Any]:
        samples = int(bucket.get("samples", 0))
        intercept = float(bucket.get("intercept", 0.0))
        slope = float(bucket.get("slope", 1.0))
        log_odds = _logit(probability)
        calibrated = _sigmoid(intercept + slope * log_odds)
        error = outcome - calibrated
        rate = self.learning_rate / math.sqrt(1.0 + samples / 25.0)
        bucket["intercept"] = _clip(intercept + rate * error, -1.5, 1.5)
        bucket["slope"] = _clip(slope + rate * error * log_odds, 0.5, 1.5)
        bucket["samples"] = samples + 1
        bucket["last_brier"] = (probability - outcome) ** 2
        return bucket

    def apply_feedback(self, event: dict[str, Any]) -> dict[str, Any]:
        event_id = str(event.get("event_id", "")).strip()
        symbol = str(event.get("symbol", "")).strip().upper()
        probability = float(event.get("predicted_profit_probability"))
        observed = event.get("observed_profitable")
        if not event_id or not symbol or not math.isfinite(probability) or not 0.0 <= probability <= 1.0:
            raise ValueError("invalid calibration event")
        if not isinstance(observed, bool):
            raise ValueError("calibration outcome must be boolean")
        training_day_valid = event.get("training_day_valid", True)
        if not isinstance(training_day_valid, bool):
            raise ValueError("training_day_valid must be boolean")
        if not training_day_valid:
            return self.status(symbol, duplicate=False, status="invalid_day_ignored")
        session_date = str(event.get("session_date", "")).strip()
        if session_date:
            try:
                datetime.strptime(session_date, "%Y-%m-%d")
            except ValueError as error:
                raise ValueError("session_date must use YYYY-MM-DD") from error
        recent = [str(value) for value in self.state.get("recent_event_ids", [])]
        if event_id in recent:
            return self.status(symbol, duplicate=True)
        outcome = 1.0 if observed else 0.0
        self._update_bucket(self.state.setdefault("global", _new_bucket()), probability, outcome)
        symbols = self.state.setdefault("symbols", {})
        self._update_bucket(symbols.setdefault(symbol, _new_bucket()), probability, outcome)
        recent.append(event_id)
        self.state["recent_event_ids"] = recent[-2048:]
        if session_date:
            valid_days = [str(value) for value in self.state.get("valid_training_days", [])]
            if session_date not in valid_days:
                valid_days.append(session_date)
            self.state["valid_training_days"] = sorted(valid_days)[-512:]
        self.state["updated_at"] = datetime.now(timezone.utc).isoformat()
        self._write()
        return self.status(symbol, duplicate=False)

    def _project_bucket(self, bucket: dict[str, Any], probability: float) -> float:
        return _sigmoid(float(bucket.get("intercept", 0.0)) + float(bucket.get("slope", 1.0)) * _logit(probability))

    def project(self, symbol: str, probability: float) -> dict[str, Any]:
        raw = _clip(probability, 0.0, 1.0)
        global_bucket = self.state.get("global", _new_bucket())
        symbol_bucket = self.state.get("symbols", {}).get(symbol.upper(), _new_bucket())
        global_value = self._project_bucket(global_bucket, raw)
        symbol_samples = int(symbol_bucket.get("samples", 0))
        symbol_weight = min(0.75, symbol_samples / 40.0)
        projected = (1.0 - symbol_weight) * global_value + symbol_weight * self._project_bucket(symbol_bucket, raw)
        total_samples = int(global_bucket.get("samples", 0))
        readiness = min(1.0, total_samples / float(self.minimum_samples))
        # A shadow fit is never allowed to manufacture stronger conviction.
        # Even after the sample gate is met, retain a 5% shrink toward neutral.
        shrink_strength = 0.25 + 0.70 * readiness
        conservative = 0.5 + (projected - 0.5) * shrink_strength
        conservative_boundary = 0.5 + (raw - 0.5) * 0.95
        if raw >= 0.5:
            calibrated = _clip(conservative, 0.5, conservative_boundary)
        else:
            calibrated = _clip(conservative, conservative_boundary, 0.5)
        valid_days = len({str(value) for value in self.state.get("valid_training_days", [])})
        promotion_eligible = (
            total_samples >= self.minimum_promotion_samples
            and valid_days >= self.minimum_valid_days
        )
        return {
            "raw_profit_probability": raw,
            "calibrated_profit_probability": _clip(calibrated, 0.0, 1.0),
            "global_samples": total_samples,
            "symbol_samples": symbol_samples,
            "valid_training_days": valid_days,
            "minimum_promotion_samples": self.minimum_promotion_samples,
            "minimum_valid_days": self.minimum_valid_days,
            "deployment_status": "shadow_only",
            "promotion_eligible": promotion_eligible,
        }

    def status(self, symbol: str, *, duplicate: bool, status: str | None = None) -> dict[str, Any]:
        global_bucket = self.state.get("global", _new_bucket())
        symbol_bucket = self.state.get("symbols", {}).get(symbol.upper(), _new_bucket())
        valid_days = len({str(value) for value in self.state.get("valid_training_days", [])})
        return {
            "schema_version": "ocean-wave-shadow-calibration.v1",
            "status": status or ("duplicate_ignored" if duplicate else "updated"),
            "deployment_status": "shadow_only",
            "global_samples": int(global_bucket.get("samples", 0)),
            "symbol_samples": int(symbol_bucket.get("samples", 0)),
            "valid_training_days": valid_days,
            "minimum_promotion_samples": self.minimum_promotion_samples,
            "minimum_valid_days": self.minimum_valid_days,
            "promotion_eligible": (
                int(global_bucket.get("samples", 0)) >= self.minimum_promotion_samples
                and valid_days >= self.minimum_valid_days
            ),
        }


__all__ = ["ShadowCalibrator"]
