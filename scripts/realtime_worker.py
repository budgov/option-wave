"""Bounded JSON-lines worker for warm, C++-accelerated Schwab inference."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from option_wave.realtime import HAS_CPP_CORE, RealtimePredictor, validate_horizons
from option_wave.intraday_features import extract_intraday_price_features

MAX_REQUEST_BYTES = 256 * 1024


def safe_error(error: BaseException) -> str:
    message = " ".join(str(error).split())
    for marker in ("Bearer ", "access_token", "refresh_token"):
        position = message.lower().find(marker.lower())
        if position >= 0:
            message = f"{message[:position]}[redacted]"
    return message[:800]


def emit(value: dict[str, Any]) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    sys.stdout.write(f"{payload}\n")
    sys.stdout.flush()


def parse_horizons(value: Any, fallback: tuple[float, ...]) -> tuple[float, ...]:
    if value is None:
        return fallback
    if isinstance(value, str):
        values = tuple(float(item) for item in value.split(",") if item.strip())
    elif isinstance(value, list):
        values = tuple(float(item) for item in value)
    else:
        raise ValueError("invalid horizons")
    return validate_horizons(values)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir")
    parser.add_argument("--horizons", default="5,15,30,60")
    parser.add_argument("--strike-count", type=int, default=40)
    parser.add_argument("--max-symbols", type=int, default=32)
    parser.add_argument("--max-requests", type=int, default=100)
    parser.add_argument("--feedback-learning-rate", type=float, default=0.025)
    parser.add_argument("--feedback-minimum-samples", type=int, default=30)
    parser.add_argument("--feedback-minimum-promotion-samples", type=int, default=500)
    parser.add_argument("--feedback-minimum-valid-days", type=int, default=40)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    default_horizons = parse_horizons(args.horizons, (5.0, 15.0, 30.0, 60.0))
    if args.self_test:
        emit({"schema_version": "ocean-wave-worker.v1", "status": "ok", "native_core": HAS_CPP_CORE})
        return
    if not args.state_dir:
        parser.error("--state-dir is required unless --self-test is used")

    request_count = 0
    predictor = RealtimePredictor(
        Path(args.state_dir),
        max_symbols=max(1, args.max_symbols),
        async_checkpoints=True,
        require_native_core=True,
        feedback_learning_rate=args.feedback_learning_rate,
        feedback_minimum_samples=args.feedback_minimum_samples,
        feedback_minimum_promotion_samples=args.feedback_minimum_promotion_samples,
        feedback_minimum_valid_days=args.feedback_minimum_valid_days,
    )
    emit({"schema_version": "ocean-wave-worker.v1", "event": "ready", "native_core": HAS_CPP_CORE})
    try:
        for raw in sys.stdin.buffer:
            request_id = None
            try:
                if len(raw) > MAX_REQUEST_BYTES:
                    raise ValueError("worker request exceeds the size limit")
                request = json.loads(raw)
                if not isinstance(request, dict):
                    raise ValueError("worker request must be an object")
                request_id = request.get("id")
                command = request.get("command", "predict")
                if command == "shutdown":
                    emit({"id": request_id, "ok": True, "result": {"status": "stopping"}})
                    break
                if command == "feedback":
                    result = predictor.apply_feedback(request.get("feedback") or {})
                    emit({"id": request_id, "ok": True, "result": result})
                    request.clear()
                    continue
                if command == "intraday_features":
                    prices = request.get("prices")
                    if not isinstance(prices, list):
                        raise ValueError("intraday_features prices must be an array")
                    result = extract_intraday_price_features(
                        prices,
                        int(request.get("valid_length", len(prices))),
                        max_harmonics=int(request.get("max_harmonics", 64)),
                        sample_interval_minutes=float(request.get("sample_interval_minutes", 1.0)),
                        linear_detrend=True,
                        hann_taper=True,
                    )
                    emit({"id": request_id, "ok": True, "result": result})
                    request.clear()
                    continue
                if command not in {"predict", "quote"}:
                    raise ValueError("unsupported worker command")

                request_count += 1
                if command == "quote":
                    result = predictor.quote(
                        symbol=request.get("symbol", ""),
                        signal_published_at=request.get("signal_published_at", ""),
                        access_token=request.get("access_token", ""),
                    )
                else:
                    result = predictor.predict(
                        symbol=request.get("symbol", ""),
                        signal_published_at=request.get("signal_published_at", ""),
                        access_token=request.get("access_token", ""),
                        horizons=parse_horizons(request.get("horizons"), default_horizons),
                        strike_count=int(request.get("strike_count", args.strike_count)),
                        expiry=request.get("expiry"),
                        strike=request.get("strike"),
                        option_type=request.get("option_type"),
                        market_state_overrides=request.get("market_state_overrides"),
                        checkpoint_async=True,
                    )
                recycle = request_count >= max(1, args.max_requests)
                emit({"id": request_id, "ok": True, "result": result, "recycle_requested": recycle})
                request.clear()
            except Exception as error:
                emit({"id": request_id, "ok": False, "error": safe_error(error)})
    finally:
        predictor.close()


if __name__ == "__main__":
    main()
