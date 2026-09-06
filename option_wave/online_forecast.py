"""Causal, bounded C++ shadow forecasts and JSON checkpoint validation.

Numerical work lives in cpp/online_forecast.hpp. This boundary owns identifiers,
timestamps, immutable forecast receipts and replay protection. Callers must only
mark labels eligible after session/data-quality validation. Rebuild checkpoints
from the authoritative valid-session ledger after retroactive invalidation.
"""
from __future__ import annotations

from collections import deque
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
import hashlib
import json
import math
from threading import RLock
from typing import Any

from ._backend import cpp_core

VERSION = "online_forecast.v1"
SYMBOLS = frozenset({"QQQ", "SPY", "TSLA", "AAPL"})
STOCK_FEATURES = (
    "return_5m", "return_15m", "vwap_gap", "relative_volume",
    "market_return_5m", "sector_return_5m", "realized_vol", "day_return",
)
OPTION_FEATURES = ("iv_skew", "iv_level", "gamma_imbalance", "oi_imbalance", "delta_flow")
EXPERTS = ("stock", "fused", "trend", "reversion")
MAX_MODELS = 64
MAX_RECENT_EVENTS = 512
MAX_IDENTIFIER_LENGTH = 192
MAX_STATE_BYTES = 12 * 1024 * 1024
MIN_TRAINING_SAMPLES = 32
HAS_ONLINE_CORE = cpp_core is not None and hasattr(cpp_core, "online_forecast_predict")


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _timestamp(value: Any, name: str) -> float:
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError(f"{name} must be an ISO timestamp with a timezone") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError(f"{name} must include a timezone")
        result = parsed.astimezone(timezone.utc).timestamp()
    else:
        result = _finite(value, name)
    if result < 0.0 or result > 253402300799.0:
        raise ValueError(f"{name} must be epoch seconds or an ISO timestamp, not milliseconds")
    return result


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_IDENTIFIER_LENGTH:
        raise ValueError(f"{name} must be a nonempty string of at most {MAX_IDENTIFIER_LENGTH} characters")
    return value


def _key(symbol: Any, horizon: Any) -> tuple[str, int, str]:
    if not isinstance(symbol, str) or symbol.upper() not in SYMBOLS:
        raise ValueError("symbol must be QQQ, SPY, TSLA or AAPL")
    value = _finite(horizon, "horizon")
    if not value.is_integer() or value < 1.0 or value > 390.0:
        raise ValueError("horizon must be a whole number of minutes in [1, 390]")
    canonical = symbol.upper()
    integer = int(value)
    return canonical, integer, f"{canonical}:{integer}"


def _features(values: Any, names: tuple[str, ...], name: str) -> list[float | None]:
    if values is None:
        raw = [None] * len(names)
    elif isinstance(values, Mapping):
        unknown = set(values) - set(names)
        if unknown:
            raise ValueError(f"{name} includes unknown feature names")
        raw = [values.get(key) for key in names]
    elif isinstance(values, Sequence) and not isinstance(values, (str, bytes)):
        if len(values) != len(names):
            raise ValueError(f"{name} must contain {len(names)} values")
        raw = list(values)
    else:
        raise ValueError(f"{name} must be a feature mapping or fixed-length sequence")
    result: list[float | None] = []
    for value in raw:
        if value is None:
            result.append(None)
            continue
        if isinstance(value, bool):
            raise ValueError(f"{name} cannot contain booleans")
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"{name} must contain numbers or missing values") from exc
        result.append(number if math.isfinite(number) else None)
    return result


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
        ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()


def _hash_identifier(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _receipt_digest(forecast: Mapping[str, Any]) -> str:
    return _digest({key: value for key, value in forecast.items() if key != "receipt_digest"})


def _empty_model() -> dict[str, Any]:
    return {"native_state": list(cpp_core.online_forecast_initial_state()),
        "watermark": -1.0, "evicted_through": -1.0, "recent": deque(),
        "forecast_ids": set(), "event_ids": set()}


class OnlineForecastChallenger:
    """Issue shadow receipts, then learn once from eligible mature outcomes.

    Returns/price gaps are decimal fractions; volatility is annualized decimal;
    relative_volume is a ratio. Gamma/OI/Delta flow inputs are bounded normalized
    features. Delta flow must be None unless supported by reliable trade evidence.
    The quality gate must describe the option evidence, not stock direction.

    predict() is read-only, including normalizers and conditioning regressions.
    A caller checkpoint rollback must precede rebuilding invalidated history.
    """

    def __init__(self) -> None:
        if not HAS_ONLINE_CORE:
            raise RuntimeError("online forecast requires the upgraded C++ core")
        self._models: dict[str, dict[str, Any]] = {}
        self._lock = RLock()

    def predict(self, symbol: str, horizon: int, stock_features: Any,
                option_features: Any, quality: float, origin_price: float,
                forecast_id: str, issued_at: Any) -> dict[str, Any]:
        symbol, horizon, key = _key(symbol, horizon)
        forecast_id = _identifier(forecast_id, "forecast_id")
        issued = _timestamp(issued_at, "issued_at")
        spot = _finite(origin_price, "origin_price")
        gate = _finite(quality, "quality")
        if spot <= 0.0 or spot > 1e7 or gate < 0.0 or gate > 1.0:
            raise ValueError("origin_price or option quality is outside supported bounds")
        stock = _features(stock_features, STOCK_FEATURES, "stock_features")
        options = _features(option_features, OPTION_FEATURES, "option_features")
        with self._lock:
            model = self._models.get(key)
            if model is None:
                if len(self._models) >= MAX_MODELS:
                    raise ValueError("online forecast model capacity reached")
                model = _empty_model()
            if issued < model["watermark"]:
                raise ValueError("prediction precedes the mature training watermark")
            native = dict(cpp_core.online_forecast_predict(model["native_state"],
                [math.nan if item is None else item for item in stock],
                [math.nan if item is None else item for item in options], gate, horizon))
            receipt: dict[str, Any] = {
                "model_version": VERSION,
                "feature_version": 1,
                "shadow_only": True,
                "symbol": symbol,
                "horizon": horizon,
                "forecast_id": forecast_id,
                "issued_at": issued,
                "matures_at": issued + horizon * 60.0,
                "origin_price": spot,
                "stock_features": dict(zip(STOCK_FEATURES, stock)),
                "option_features": dict(zip(OPTION_FEATURES, options)),
                "input_quality": gate,
                "training_watermark": model["watermark"],
                "training_state_digest": _digest(model["native_state"]),
                "probabilities_up": dict(zip(EXPERTS, native.pop("expert_probabilities"))),
                "expert_weights": dict(zip(EXPERTS, native.pop("expert_weights"))),
                "readiness": "trained" if native["trained_samples"] >= MIN_TRAINING_SAMPLES else "warmup",
                "interval_method": "rolling_scaled_error_adaptive_alpha",
                "interval_target_coverage": 0.90,
                **native,
            }
            receipt["trained_samples"] = int(receipt["trained_samples"])
            receipt["receipt_digest"] = _receipt_digest(receipt)
            return receipt

    def learn(self, frozen_forecast: Mapping[str, Any], actual_return: float,
              event_id: str, eligible: bool = True, matured_at: Any = None) -> dict[str, Any]:
        return self._learn(frozen_forecast, actual_return, event_id, eligible, matured_at, False)

    def learn_replay(self, frozen_forecast: Mapping[str, Any], actual_return: float,
                     event_id: str, eligible: bool = True, matured_at: Any = None) -> dict[str, Any]:
        """Rebuild from valid mature labels, retaining original frozen scoring.

        Native re-encoding uses the current replay checkpoint only for gradient
        training. Hedge/Brier/coverage keep the original issue-time predictions.
        This method does not reissue or overwrite any historical forecast.
        """
        return self._learn(frozen_forecast, actual_return, event_id, eligible, matured_at, True)

    def _learn(self, frozen_forecast: Mapping[str, Any], actual_return: float,
               event_id: str, eligible: bool, matured_at: Any, replay: bool) -> dict[str, Any]:
        if eligible is not True:
            return {"updated": False, "reason": "ineligible"}
        if matured_at is None:
            return {"updated": False, "reason": "maturity_required"}
        if not isinstance(frozen_forecast, Mapping):
            raise ValueError("frozen_forecast must be a forecast receipt")
        # Copy bounded payload before hashing; reject externally edited issue-time
        # probabilities/features rather than evaluating the latest prediction.
        if len(frozen_forecast) > 48:
            raise ValueError("forecast receipt is oversized")
        forecast = dict(frozen_forecast)
        event_id = _identifier(event_id, "event_id")
        forecast_id = _identifier(forecast.get("forecast_id"), "forecast_id")
        symbol, horizon, key = _key(forecast.get("symbol"), forecast.get("horizon"))
        if forecast.get("model_version") != VERSION or forecast.get("shadow_only") is not True:
            raise ValueError("forecast receipt has an incompatible model version")
        frozen_values = forecast.get("frozen_native")
        if not isinstance(frozen_values, list) or len(frozen_values) != cpp_core.ONLINE_FORECAST_FROZEN_SIZE:
            raise ValueError("frozen forecast dimensions are invalid")
        if forecast.get("receipt_digest") != _receipt_digest(forecast):
            raise ValueError("frozen forecast receipt was modified")
        issued = _timestamp(forecast.get("issued_at"), "issued_at")
        maturity = _timestamp(forecast.get("matures_at"), "matures_at")
        observed = _timestamp(matured_at, "matured_at")
        if maturity != issued + horizon * 60.0 or forecast.get("training_watermark", math.inf) > issued:
            raise ValueError("forecast receipt has inconsistent causal timestamps")
        if observed < maturity:
            return {"updated": False, "reason": "not_mature"}
        actual = _finite(actual_return, "actual_return")
        if actual < -1.0 or actual > 2.0:
            raise ValueError("actual_return must be a decimal fraction in [-1, 2]")
        forecast_hash, event_hash = _hash_identifier(forecast_id), _hash_identifier(event_id)
        with self._lock:
            model = self._models.get(key)
            if model is None:
                if len(self._models) >= MAX_MODELS:
                    raise ValueError("online forecast model capacity reached")
                model = _empty_model()
            if forecast_hash in model["forecast_ids"] or event_hash in model["event_ids"]:
                return {"updated": False, "reason": "duplicate"}
            if maturity <= model["evicted_through"] or maturity < model["watermark"]:
                return {"updated": False, "reason": "stale_or_out_of_order"}
            learned = dict(cpp_core.online_forecast_learn(
                model["native_state"], frozen_values, actual, replay, horizon))
            # Commit only after the native operation succeeded. The GIL is released
            # by C++ while this object lock protects concurrent prediction/checkpoint.
            model["native_state"] = list(learned.pop("native_state"))
            model["watermark"] = maturity
            model["recent"].append((forecast_hash, event_hash, maturity))
            model["forecast_ids"].add(forecast_hash)
            model["event_ids"].add(event_hash)
            while len(model["recent"]) > MAX_RECENT_EVENTS:
                old_forecast, old_event, old_maturity = model["recent"].popleft()
                model["forecast_ids"].discard(old_forecast)
                model["event_ids"].discard(old_event)
                model["evicted_through"] = max(model["evicted_through"], old_maturity)
            self._models[key] = model
            learned["trained_samples"] = int(learned["trained_samples"])
            learned["brier_sums"] = dict(zip(EXPERTS, learned["brier_sums"]))
            return {"updated": True, "reason": "mature_eligible_label", "symbol": symbol,
                "horizon": horizon, "shadow_only": True, "replay_reencoded": replay,
                "scoring_source": "original_frozen_forecast", **learned}

    def export_state(self) -> dict[str, Any]:
        with self._lock:
            return {"model_version": VERSION, "shadow_only": True, "models": {
                key: {"native_state": list(model["native_state"]),
                    "watermark": model["watermark"], "evicted_through": model["evicted_through"],
                    "recent": [list(item) for item in model["recent"]]}
                for key, model in sorted(self._models.items())}}

    @classmethod
    def from_state(cls, state: Mapping[str, Any]) -> "OnlineForecastChallenger":
        instance = cls()
        if not isinstance(state, Mapping) or state.get("model_version") != VERSION or state.get("shadow_only") is not True:
            raise ValueError("checkpoint has an incompatible model version")
        models = state.get("models")
        if not isinstance(models, Mapping) or len(models) > MAX_MODELS:
            raise ValueError("checkpoint model count is invalid")
        # Length checks occur before serialization/native parsing to bound allocations.
        for key, model in models.items():
            if not isinstance(key, str) or len(key) > 16 or not isinstance(model, Mapping):
                raise ValueError("checkpoint model key is invalid")
            parts = key.split(":")
            if len(parts) != 2 or _key(parts[0], parts[1])[2] != key:
                raise ValueError("checkpoint model key is invalid")
            native = model.get("native_state")
            recent = model.get("recent")
            if not isinstance(native, list) or len(native) != cpp_core.ONLINE_FORECAST_STATE_SIZE:
                raise ValueError("checkpoint native state dimensions are invalid")
            if not isinstance(recent, list) or len(recent) > MAX_RECENT_EVENTS:
                raise ValueError("checkpoint duplicate window is invalid")
            watermark = _finite(model.get("watermark"), "watermark")
            evicted = _finite(model.get("evicted_through"), "evicted_through")
            if watermark < -1.0 or watermark > 253402300799.0 or evicted < -1.0 or evicted > watermark:
                raise ValueError("checkpoint timestamp watermark is invalid")
            validated: deque[tuple[str, str, float]] = deque()
            forecast_ids: set[str] = set()
            event_ids: set[str] = set()
            last = -1.0
            for row in recent:
                if not isinstance(row, (list, tuple)) or len(row) != 3:
                    raise ValueError("checkpoint duplicate entry is invalid")
                fid, eid, timestamp = row
                if any(not isinstance(item, str) or len(item) != 64
                       or any(char not in "0123456789abcdef" for char in item) for item in (fid, eid)):
                    raise ValueError("checkpoint duplicate hash is invalid")
                value = _finite(timestamp, "event timestamp")
                if value < 0.0 or value < last or value > watermark or fid in forecast_ids or eid in event_ids:
                    raise ValueError("checkpoint duplicate sequence is invalid")
                last = value
                forecast_ids.add(fid)
                event_ids.add(eid)
                validated.append((fid, eid, value))
            packed = list(cpp_core.online_forecast_validate_state(native))
            if len(recent) > packed[0] or (packed[0] > 0.0 and (not recent or last != watermark)):
                raise ValueError("checkpoint counters disagree with duplicate history")
            instance._models[key] = {"native_state": packed, "watermark": watermark,
                "evicted_through": evicted, "recent": validated,
                "forecast_ids": forecast_ids, "event_ids": event_ids}
        if len(json.dumps(instance.export_state(), allow_nan=False)) > MAX_STATE_BYTES:
            raise ValueError("checkpoint serialized size exceeds the fixed limit")
        return instance
