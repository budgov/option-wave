"""Verified large-option-flow aggregation.

The model accepts trade-level flow only when the direction can be observed or
reconstructed from bid/ask. Unknown direction is assigned zero signal rather
than guessed from the underlying price.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core


@dataclass
class FlowConfig:
    """Controls for notional, decay, and conservative trade classification."""

    large_notional_threshold: float = 1_000_000.0
    half_life_minutes: float = 60.0
    default_multiplier: float = 100.0
    unknown_aggressor_confidence: float = 0.0
    unknown_opening_confidence: float = 0.5


@dataclass(frozen=True)
class FlowSummary:
    """Time-decayed directional flow summary in target-underlying units."""

    net_notional: float
    gross_notional: float
    large_net_notional: float
    large_gross_notional: float
    large_trade_count: int
    signal: float
    large_signal: float
    velocity: float
    confidence: float


def _numeric(frame: pd.DataFrame, names: tuple[str, ...], default: float = np.nan) -> np.ndarray:
    for name in names:
        if name in frame:
            return pd.to_numeric(frame[name], errors="coerce").to_numpy(float)
    return np.full(len(frame), default, dtype=float)


def _normalise_side(values: pd.Series) -> np.ndarray:
    normalised = values.astype("string").str.lower().str.strip()
    result = np.zeros(len(values), dtype=float)
    buy = (normalised.isin(("buy", "b", "lift", "ask")) | normalised.str.startswith("buy_")).fillna(False).to_numpy(bool)
    sell = (normalised.isin(("sell", "s", "bid", "offer", "hit")) | normalised.str.startswith("sell_")).fillna(False).to_numpy(bool)
    result[buy] = 1.0
    result[sell] = -1.0
    return result


def _aggressor(frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Return aggressor sign and confidence, preferring explicit side."""

    for name in ("aggressor", "trade_side", "side"):
        if name in frame:
            side = _normalise_side(frame[name])
            return side, np.where(side != 0.0, 1.0, 0.0)

    trade = _numeric(frame, ("trade_price", "price", "premium", "last"), 0.0)
    bid = _numeric(frame, ("bid", "trade_bid"), np.nan)
    ask = _numeric(frame, ("ask", "trade_ask"), np.nan)
    valid = np.isfinite(trade) & np.isfinite(bid) & np.isfinite(ask) & (ask >= bid)
    at_ask = valid & (np.abs(trade - ask) <= np.abs(trade - bid)) & (trade >= (bid + ask) / 2.0)
    at_bid = valid & ~at_ask & (trade <= (bid + ask) / 2.0)
    sign = np.where(at_ask, 1.0, np.where(at_bid, -1.0, 0.0))
    confidence = np.where(sign != 0.0, 0.6, 0.0)
    return sign, confidence


def _target_direction(frame: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Map Call/Put aggressor flow to the underlying direction."""

    if "target_direction" in frame:
        direction = pd.to_numeric(frame["target_direction"], errors="coerce").fillna(0.0).to_numpy(float)
        return np.clip(direction, -1.0, 1.0), np.where(direction != 0.0, 1.0, 0.0)

    aggressor, confidence = _aggressor(frame)
    if "right" not in frame and "option_type" not in frame:
        return np.zeros(len(frame), dtype=float), np.zeros(len(frame), dtype=float)
    rights = frame["right"] if "right" in frame else frame["option_type"]
    right = rights.astype("string").str.lower().str.strip()
    call = right.isin(("c", "call")).to_numpy()
    put = right.isin(("p", "put")).to_numpy()
    option_direction = np.where(call, 1.0, np.where(put, -1.0, 0.0))
    return option_direction * aggressor, confidence * (option_direction != 0.0)


def _ages(frame: pd.DataFrame, asof: pd.Timestamp | str | None) -> np.ndarray:
    if "age_minutes" in frame:
        return np.maximum(_numeric(frame, ("age_minutes",), 0.0), 0.0)
    if "timestamp" not in frame and "time" not in frame:
        raise ValueError("flow requires timestamp/time or age_minutes")
    name = "timestamp" if "timestamp" in frame else "time"
    timestamps = pd.to_datetime(frame[name], errors="coerce", utc=True)
    reference = pd.Timestamp.now(tz="UTC") if asof is None else pd.Timestamp(asof)
    if reference.tzinfo is None:
        reference = reference.tz_localize("UTC")
    else:
        reference = reference.tz_convert("UTC")
    ages = (reference - timestamps).dt.total_seconds().to_numpy(float) / 60.0
    return np.maximum(np.nan_to_num(ages, nan=np.inf, posinf=np.inf, neginf=0.0), 0.0)


def _python_aggregate(
    notional: np.ndarray,
    direction: np.ndarray,
    confidence: np.ndarray,
    age_minutes: np.ndarray,
    large_mask: np.ndarray,
    half_life_minutes: float,
) -> dict[str, float]:
    half_life = max(float(half_life_minutes), 1e-6)
    decay = np.exp(-np.log(2.0) * age_minutes / half_life)
    weight = np.clip(confidence, 0.0, 1.0) * decay
    signed = notional * direction
    gross_weighted = notional * weight
    net_weighted = signed * weight
    large_weighted = gross_weighted * large_mask
    large_net_weighted = net_weighted * large_mask
    recent = age_minutes <= half_life
    prior = (age_minutes > half_life) & (age_minutes <= 2.0 * half_life)
    recent_ratio = float(net_weighted[recent].sum() / max(gross_weighted[recent].sum(), 1e-12))
    prior_ratio = float(net_weighted[prior].sum() / max(gross_weighted[prior].sum(), 1e-12))
    large_gross = float(large_weighted.sum())
    gross = float(gross_weighted.sum())
    return {
        "net_notional": float(net_weighted.sum()),
        "gross_notional": gross,
        "large_net_notional": float(large_net_weighted.sum()),
        "large_gross_notional": large_gross,
        "large_trade_count": float(np.sum(large_mask > 0.0)),
        "signal": float(np.tanh(net_weighted.sum() / max(gross, 1e-12))),
        "large_signal": float(np.tanh(large_net_weighted.sum() / max(large_gross, 1e-12))),
        "velocity": float(np.tanh(recent_ratio - prior_ratio)),
        "confidence": float(np.sum(gross_weighted * np.clip(confidence, 0.0, 1.0)) / max(gross, 1e-12)),
    }


def aggregate_large_flow(
    flow: pd.DataFrame,
    config: FlowConfig | None = None,
    *,
    asof: pd.Timestamp | str | None = None,
) -> FlowSummary:
    """Aggregate verified trade-level flow without inferring missing direction.

    Required columns are ``right``, ``contracts`` and a price field. Direction
    comes from ``aggressor``/``trade_side``/``side`` or from bid/ask placement.
    ``is_opening`` and ``oi_change`` are optional confidence modifiers.
    """

    cfg = config or FlowConfig()
    if flow is None or flow.empty:
        return FlowSummary(0.0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)
    frame = flow.copy()
    contracts = np.maximum(_numeric(frame, ("contracts", "quantity", "size"), 0.0), 0.0)
    price = np.maximum(_numeric(frame, ("trade_price", "price", "premium", "last"), 0.0), 0.0)
    multiplier = _numeric(frame, ("multiplier",), cfg.default_multiplier)
    multiplier = np.where(np.isfinite(multiplier) & (multiplier > 0), multiplier, cfg.default_multiplier)
    notional = contracts * price * multiplier
    direction, aggressor_confidence = _target_direction(frame)
    confidence = aggressor_confidence.copy()
    if "confidence" in frame:
        confidence *= np.clip(pd.to_numeric(frame["confidence"], errors="coerce").fillna(0.0).to_numpy(float), 0.0, 1.0)
    if "is_opening" in frame:
        opening = frame["is_opening"].astype("string").str.lower().str.strip().isin(("true", "1", "yes", "open")).to_numpy()
        confidence *= np.where(opening, 1.0, cfg.unknown_opening_confidence)
    else:
        confidence *= cfg.unknown_opening_confidence
    if "oi_change" in frame:
        oi_change = np.abs(_numeric(frame, ("oi_change",), 0.0))
        confidence *= 0.5 + 0.5 * np.clip(oi_change / np.maximum(contracts, 1.0), 0.0, 1.0)
    confidence = np.maximum(confidence, cfg.unknown_aggressor_confidence)
    ages = _ages(frame, asof)
    finite = np.isfinite(notional) & np.isfinite(direction) & np.isfinite(confidence) & np.isfinite(ages)
    notional, direction, confidence, ages = notional[finite], direction[finite], confidence[finite], ages[finite]
    if not len(notional):
        return FlowSummary(0.0, 0.0, 0.0, 0.0, 0, 0.0, 0.0, 0.0, 0.0)
    large_mask = (notional >= max(float(cfg.large_notional_threshold), 0.0)).astype(float)
    if HAS_CPP_CORE:
        result = cpp_core.aggregate_flow(
            np.ascontiguousarray(notional),
            np.ascontiguousarray(direction),
            np.ascontiguousarray(confidence),
            np.ascontiguousarray(ages),
            np.ascontiguousarray(large_mask),
            float(cfg.half_life_minutes),
        )
        values = {key: float(result[key]) for key in result}
    else:
        values = _python_aggregate(notional, direction, confidence, ages, large_mask, cfg.half_life_minutes)
    return FlowSummary(
        net_notional=values["net_notional"],
        gross_notional=values["gross_notional"],
        large_net_notional=values["large_net_notional"],
        large_gross_notional=values["large_gross_notional"],
        large_trade_count=int(round(values["large_trade_count"])),
        signal=values["signal"],
        large_signal=values["large_signal"],
        velocity=values["velocity"],
        confidence=values["confidence"],
    )
