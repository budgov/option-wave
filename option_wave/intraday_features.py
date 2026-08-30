"""Causal price-to-native intraday Fourier adapter.

The adapter performs only the bounded price-to-log-return transform in NumPy;
all spectral work must run in the compiled core. Native unavailability produces
an explicit abstention and never falls back to a slow Python DFT.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

from ._backend import HAS_CPP_CORE, cpp_core


_MAX_NATIVE_JSON_DEPTH = 6
_MAX_NATIVE_JSON_ITEMS = 8_192


def _native_json_value(
    value: Any,
    *,
    _depth: int = 0,
    _remaining: list[int] | None = None,
    _path: str = "result",
) -> Any:
    """Convert the bounded native Fourier result to strict JSON values."""

    if _remaining is None:
        _remaining = [_MAX_NATIVE_JSON_ITEMS]
    if _depth > _MAX_NATIVE_JSON_DEPTH:
        raise ValueError("native Fourier output exceeds the JSON nesting limit")
    _remaining[0] -= 1
    if _remaining[0] < 0:
        raise ValueError("native Fourier output exceeds the JSON item limit")

    if isinstance(value, dict):
        if len(value) > _remaining[0]:
            raise ValueError("native Fourier output exceeds the JSON item limit")
        converted: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError(f"native Fourier output key at {_path} must be a string")
            converted[key] = _native_json_value(
                item,
                _depth=_depth + 1,
                _remaining=_remaining,
                _path=f"{_path}.{key}",
            )
        return converted
    if isinstance(value, np.ndarray):
        if value.ndim != 1:
            raise ValueError(f"native Fourier array at {_path} must be one-dimensional")
        if value.size > _remaining[0]:
            raise ValueError("native Fourier output exceeds the JSON item limit")
        return _native_json_value(
            value.tolist(),
            _depth=_depth + 1,
            _remaining=_remaining,
            _path=_path,
        )
    if isinstance(value, np.generic):
        return _native_json_value(
            value.item(),
            _depth=_depth + 1,
            _remaining=_remaining,
            _path=_path,
        )
    if isinstance(value, (list, tuple)):
        if len(value) > _remaining[0]:
            raise ValueError("native Fourier output exceeds the JSON item limit")
        return [
            _native_json_value(
                item,
                _depth=_depth + 1,
                _remaining=_remaining,
                _path=f"{_path}[{index}]",
            )
            for index, item in enumerate(value)
        ]
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not np.isfinite(value):
            raise ValueError(f"native Fourier output at {_path} must be finite")
        return value
    raise TypeError(f"unsupported native Fourier output at {_path}: {type(value).__name__}")


def _native_abstention(reason: str) -> dict[str, Any]:
    return {
        "schema_version": "intraday_price_features.v1",
        "status": "abstain",
        "reason": reason,
        "native_required": True,
        "python_spectral_fallback": False,
    }


def extract_intraday_price_features(
    prices: Sequence[float] | np.ndarray,
    valid_length: int,
    *,
    max_harmonics: int = 256,
    sample_interval_minutes: float = 1.0,
    linear_detrend: bool = True,
    hann_taper: bool = True,
) -> dict[str, Any]:
    """Transform a causal one-minute price prefix and call the native kernel.

    ``valid_length`` is the number of prices available at the forecast cut-off;
    values after it are never converted or validated. At least nine prices are
    required because the native feature kernel requires eight log returns. The
    default harmonic cap covers every resolvable 2-minute-or-longer cycle in a
    regular US trading session while retaining a fixed memory/work bound.
    """

    if not HAS_CPP_CORE or cpp_core is None:
        return _native_abstention("native_core_unavailable")
    native = getattr(cpp_core, "extract_intraday_fourier", None)
    if not callable(native):
        return _native_abstention("native_fourier_api_unavailable")
    if isinstance(valid_length, bool) or not isinstance(valid_length, int):
        raise TypeError("valid_length must be an integer causal cut-off")
    if isinstance(max_harmonics, bool) or not isinstance(max_harmonics, int):
        raise TypeError("max_harmonics must be an integer")
    if not isinstance(linear_detrend, bool) or not isinstance(hann_taper, bool):
        raise TypeError("preprocessing switches must be bool values")
    if isinstance(prices, (str, bytes)) or not hasattr(prices, "__len__") or not hasattr(prices, "__getitem__"):
        raise TypeError("prices must be a finite one-dimensional sized sequence")

    if isinstance(prices, np.ndarray):
        if prices.ndim != 1:
            raise ValueError("prices must be one-dimensional")
        available = int(prices.size)
    else:
        available = len(prices)
    maximum_prices = int(getattr(cpp_core, "FOURIER_MAX_SAMPLES", 4096)) + 1
    if valid_length < 9 or valid_length > available:
        raise ValueError("valid_length must select at least nine available prices")
    if valid_length > maximum_prices:
        raise ValueError("causal price prefix exceeds the fixed native safety bound")

    # Slice before conversion so a reusable buffer's future tail cannot affect
    # either the result or validation at the current forecast cut-off.
    prefix = np.ascontiguousarray(prices[:valid_length], dtype=np.float64)
    if prefix.ndim != 1 or prefix.size != valid_length:
        raise ValueError("prices must be one-dimensional")
    if not np.isfinite(prefix).all() or np.any(prefix <= 0.0):
        raise ValueError("causal prices must be finite and strictly positive")
    log_returns = np.ascontiguousarray(np.diff(np.log(prefix)), dtype=np.float64)
    if not np.isfinite(log_returns).all() or np.any(np.abs(log_returns) > 10.0):
        raise ValueError("causal log returns exceed the native safety range")

    native_result = dict(native(
        log_returns,
        int(log_returns.size),
        max_harmonics,
        float(sample_interval_minutes),
        linear_detrend,
        hann_taper,
    ))
    result = _native_json_value(native_result)
    native_schema_version = result.get("schema_version")
    result.update({
        "schema_version": "intraday_price_features.v1",
        "native_schema_version": native_schema_version,
        "status": "ok",
        "source": "ocean_wave_cpp",
        "native_required": True,
        "python_spectral_fallback": False,
        "input_transform": "causal_log_returns",
        "price_sample_count": valid_length,
        "return_sample_count": int(log_returns.size),
        "price_cutoff_index": valid_length - 1,
        "last_price": float(prefix[-1]),
    })
    return result


__all__ = ["extract_intraday_price_features"]
