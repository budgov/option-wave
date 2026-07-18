"""Vectorized symmetric Call/Put ELO surface for Option Wave v0.9.

The important unit is a *distance pair*, not a shared strike:

    spot=100, +5% Call (105) <-> -5% Put (95)

Each expiry is paired independently.  The pair update is variance-aware and
the same rating state can be passed back into the next observation so the
surface evolves instead of resetting on every quote.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import MutableMapping

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core

EPS = 1e-12
RatingState = MutableMapping[tuple[str, float, float], float]


@dataclass
class EloConfig:
    """Numerical controls for the pair engine.

    ``up_difficulty`` is intentionally positive and ``down_difficulty`` is
    negative.  Thus, for the same distance d, ``up_cost > down_cost`` and a
    downside premium has to overcome less modeled resistance.
    """

    base_rating: float = 1500.0
    rating_scale: float = 400.0
    k_factor: float = 32.0
    distance_exponent: float = 1.0
    up_difficulty: float = 0.35
    down_difficulty: float = -0.35
    min_distance: float = 0.0025
    variance_floor: float = 1e-4
    variance_scale: float = 0.05
    expiry_decay_days: float = 0.08


def _column(frame: pd.DataFrame, name: str, default: float = 0.0) -> np.ndarray:
    """Return a numeric column without allocating a pandas Series chain."""

    if name not in frame:
        return np.full(len(frame), default, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce").fillna(default).to_numpy(float)


def _mid_and_variance(frame: pd.DataFrame, side: str, cfg: EloConfig) -> tuple[np.ndarray, np.ndarray]:
    """Return mid prices and relative observation variance for one side."""

    bid = _column(frame, f"{side}_bid", np.nan)
    ask = _column(frame, f"{side}_ask", np.nan)
    last = _column(frame, f"{side}_last", np.nan)
    mid = _column(frame, f"{side}_mid", np.nan)

    quoted = np.isfinite(bid) & np.isfinite(ask) & (ask >= bid) & (ask > 0)
    mid = np.where(quoted, (bid + ask) / 2.0, mid)
    mid = np.where(np.isfinite(mid) & (mid > 0), mid, last)
    mid = np.maximum(np.nan_to_num(mid, nan=0.0), EPS)

    spread = np.where(quoted, ask - bid, 0.10 * mid)
    quote_var = (np.maximum(spread, 0.01 * mid) / 2.0) ** 2
    explicit = _column(frame, f"{side}_variance", np.nan)
    if np.isnan(explicit).all():
        explicit = _column(frame, f"{side}_var", 0.0)
    absolute_var = np.maximum(np.nan_to_num(explicit, nan=0.0), 0.0) + quote_var
    relative_var = absolute_var / np.maximum(mid * mid, EPS)
    return mid, np.maximum(relative_var, cfg.variance_floor)


def _expiry_column(frame: pd.DataFrame) -> np.ndarray:
    for name in ("expiry_days", "dte", "tau_days", "tau"):
        if name in frame:
            return np.maximum(_column(frame, name), 0.0)
    return np.zeros(len(frame), dtype=float)


def asymmetric_cost(distance: np.ndarray | float, direction: str, cfg: EloConfig | None = None) -> np.ndarray:
    """Return the modeled energy cost for an up or down move.

    The exponential term is the explicit asymmetry.  With equal premiums and
    distance, the up cost is larger than the down cost when using defaults.
    """

    cfg = cfg or EloConfig()
    d = np.maximum(np.asarray(distance, dtype=float), cfg.min_distance)
    difficulty = cfg.up_difficulty if direction == "up" else cfg.down_difficulty
    return np.power(d, cfg.distance_exponent) * np.exp(difficulty * d)


def energy_equalized_premium(
    price: np.ndarray | float,
    distance: np.ndarray | float,
    direction: str,
    cfg: EloConfig | None = None,
) -> np.ndarray:
    """Convert an option premium into price-per-modeled-energy."""

    cfg = cfg or EloConfig()
    return np.asarray(price, dtype=float) / (asymmetric_cost(distance, direction, cfg) + EPS)


def _interpolate(values: np.ndarray, strikes: np.ndarray, targets: np.ndarray) -> np.ndarray:
    order = np.argsort(strikes)
    return np.interp(targets, strikes[order], values[order])


def _side_values(frame: pd.DataFrame, side: str, cfg: EloConfig) -> dict[str, np.ndarray]:
    price, variance = _mid_and_variance(frame, side, cfg)
    return {
        "price": price,
        "variance": variance,
        "volume": np.maximum(_column(frame, f"{side}_volume"), 0.0),
        "oi": np.maximum(_column(frame, f"{side}_oi"), 0.0),
        "delta": np.abs(_column(frame, f"{side}_delta")),
    }


def _build_symmetric_pairs_python(
    chain: pd.DataFrame,
    spot: float,
    cfg: EloConfig | None = None,
) -> pd.DataFrame:
    """Build ``+d Call <-> -d Put`` rows with vectorized interpolation.

    The input is the compact wide format used by the project.  A separate
    interpolation is performed for every expiry, so same-day and future
    expiries remain comparable without incorrectly mixing maturities.
    """

    cfg = cfg or EloConfig()
    if spot <= 0:
        raise ValueError("spot must be positive")
    if "strike" not in chain or chain.empty:
        raise ValueError("chain must contain at least one strike row")

    frame = chain.copy()
    frame["strike"] = pd.to_numeric(frame["strike"], errors="coerce")
    frame = frame.dropna(subset=["strike"])
    expiry = _expiry_column(frame)
    frame["_expiry_days"] = expiry
    rows: list[pd.DataFrame] = []

    for expiry_days, group in frame.groupby("_expiry_days", sort=True):
        group = group.sort_values("strike")
        strikes = group["strike"].to_numpy(float)
        if len(strikes) < 2 or strikes.min() > spot or strikes.max() < spot:
            continue

        side_call = _side_values(group, "call", cfg)
        side_put = _side_values(group, "put", cfg)
        up_dist = (strikes[strikes >= spot] - spot) / spot
        down_dist = (spot - strikes[strikes <= spot]) / spot
        max_distance = min(float(up_dist.max(initial=0.0)), float(down_dist.max(initial=0.0)))
        if max_distance <= 0:
            continue

        candidates = np.concatenate((up_dist[up_dist <= max_distance], down_dist[down_dist <= max_distance]))
        distances = np.unique(np.round(candidates, 10))
        distances = distances[(distances >= 0.0) & (distances <= max_distance + EPS)]
        if not len(distances):
            continue

        call_strike = spot * (1.0 + distances)
        put_strike = spot * (1.0 - distances)
        call_price = _interpolate(side_call["price"], strikes, call_strike)
        put_price = _interpolate(side_put["price"], strikes, put_strike)
        call_var = _interpolate(side_call["variance"], strikes, call_strike)
        put_var = _interpolate(side_put["variance"], strikes, put_strike)
        call_volume = _interpolate(side_call["volume"], strikes, call_strike)
        put_volume = _interpolate(side_put["volume"], strikes, put_strike)
        call_oi = _interpolate(side_call["oi"], strikes, call_strike)
        put_oi = _interpolate(side_put["oi"], strikes, put_strike)
        call_delta = _interpolate(side_call["delta"], strikes, call_strike)
        put_delta = _interpolate(side_put["delta"], strikes, put_strike)

        call_force = energy_equalized_premium(call_price, distances, "up", cfg)
        put_force = energy_equalized_premium(put_price, distances, "down", cfg)
        raw_score = call_force / (call_force + put_force + EPS)
        pair_variance = np.maximum(call_var + put_var, cfg.variance_floor)
        confidence = 1.0 / (1.0 + pair_variance / max(cfg.variance_scale, EPS))
        effective_score = 0.5 + (raw_score - 0.5) * confidence
        activity = 1.0 + np.log1p(call_volume + put_volume)
        liquidity = activity / (1.0 + np.log1p(call_oi + put_oi + EPS))
        expiry_weight = np.exp(-cfg.expiry_decay_days * float(expiry_days))
        pair_weight = confidence * expiry_weight * np.maximum(liquidity, 0.1)

        rows.append(pd.DataFrame({
            "expiry_days": float(expiry_days),
            "distance_pct": distances,
            "call_strike": call_strike,
            "put_strike": put_strike,
            "call_price": call_price,
            "put_price": put_price,
            "call_force": call_force,
            "put_force": put_force,
            "call_variance": call_var,
            "put_variance": put_var,
            "pair_variance": pair_variance,
            "confidence": confidence,
            "raw_score": raw_score,
            "effective_score": effective_score,
            "pair_weight": pair_weight,
            "call_volume": call_volume,
            "put_volume": put_volume,
            "call_oi": call_oi,
            "put_oi": put_oi,
            "call_delta": call_delta,
            "put_delta": put_delta,
        }))

    if not rows:
        raise ValueError("chain must contain strikes on both sides of spot for at least one expiry")
    return pd.concat(rows, ignore_index=True)


_PAIR_COLUMNS = (
    "expiry_days", "distance_pct", "call_strike", "put_strike", "call_price", "put_price",
    "call_force", "put_force", "call_variance", "put_variance", "pair_variance", "confidence",
    "raw_score", "effective_score", "pair_weight", "call_volume", "put_volume", "call_oi",
    "put_oi", "call_delta", "put_delta",
)


def _build_symmetric_pairs_cpp(chain: pd.DataFrame, spot: float, cfg: EloConfig) -> pd.DataFrame:
    frame = chain.copy()
    frame["strike"] = pd.to_numeric(frame["strike"], errors="coerce")
    frame = frame.dropna(subset=["strike"])
    expiry = _expiry_column(frame)
    call = _side_values(frame, "call", cfg)
    put = _side_values(frame, "put", cfg)
    arrays = [
        np.ascontiguousarray(frame["strike"].to_numpy(float)),
        np.ascontiguousarray(expiry),
        np.ascontiguousarray(call["price"]),
        np.ascontiguousarray(put["price"]),
        np.ascontiguousarray(call["variance"]),
        np.ascontiguousarray(put["variance"]),
        np.ascontiguousarray(call["volume"]),
        np.ascontiguousarray(put["volume"]),
        np.ascontiguousarray(call["oi"]),
        np.ascontiguousarray(put["oi"]),
        np.ascontiguousarray(call["delta"]),
        np.ascontiguousarray(put["delta"]),
    ]
    result = cpp_core.build_pairs(
        *arrays,
        float(spot),
        float(cfg.min_distance),
        float(cfg.distance_exponent),
        float(cfg.up_difficulty),
        float(cfg.down_difficulty),
        float(cfg.variance_floor),
        float(cfg.variance_scale),
        float(cfg.expiry_decay_days),
    )
    return pd.DataFrame({column: np.asarray(result[column], dtype=float) for column in _PAIR_COLUMNS})


def build_symmetric_pairs(
    chain: pd.DataFrame,
    spot: float,
    cfg: EloConfig | None = None,
) -> pd.DataFrame:
    """Build the pair surface, using C++ when the extension is installed."""

    cfg = cfg or EloConfig()
    if spot <= 0:
        raise ValueError("spot must be positive")
    if "strike" not in chain or chain.empty:
        raise ValueError("chain must contain at least one strike row")
    if HAS_CPP_CORE:
        return _build_symmetric_pairs_cpp(chain, spot, cfg)
    return _build_symmetric_pairs_python(chain, spot, cfg)


def _expected_rating(call_rating: np.ndarray, put_rating: np.ndarray, scale: float) -> np.ndarray:
    exponent = np.clip((put_rating - call_rating) / max(scale, EPS), -50.0, 50.0)
    return 1.0 / (1.0 + np.power(10.0, exponent))


def build_elo_surface(
    chain: pd.DataFrame,
    spot: float,
    cfg: EloConfig | None = None,
    ratings: RatingState | None = None,
) -> pd.DataFrame:
    """Update and return the variance-aware symmetric ELO surface.

    ``ratings`` is an optional mutable state store.  Passing the same store
    into subsequent calls gives the model an online ELO memory; omitting it
    yields a deterministic single-snapshot calculation.
    """

    cfg = cfg or EloConfig()
    surface = build_symmetric_pairs(chain, spot, cfg)
    keys = list(zip(
        surface["expiry_days"].round(8),
        surface["distance_pct"].round(8),
    ))
    call_rating = np.empty(len(surface), dtype=float)
    put_rating = np.empty(len(surface), dtype=float)
    expected = np.empty(len(surface), dtype=float)
    delta_rating = np.empty(len(surface), dtype=float)

    if HAS_CPP_CORE:
        prior_call = np.full(len(surface), np.nan, dtype=float)
        prior_put = np.full(len(surface), np.nan, dtype=float)
        if ratings is not None:
            for i, (expiry_days, distance) in enumerate(keys):
                key_call = ("call", float(expiry_days), float(distance))
                key_put = ("put", float(expiry_days), float(distance))
                if key_call in ratings and key_put in ratings:
                    prior_call[i] = ratings[key_call]
                    prior_put[i] = ratings[key_put]
        update = cpp_core.update_elo(
            np.ascontiguousarray(surface["call_force"].to_numpy(float)),
            np.ascontiguousarray(surface["put_force"].to_numpy(float)),
            np.ascontiguousarray(surface["effective_score"].to_numpy(float)),
            np.ascontiguousarray(surface["confidence"].to_numpy(float)),
            prior_call,
            prior_put,
            float(cfg.base_rating),
            float(cfg.rating_scale),
            float(cfg.k_factor),
        )
        call_rating[:] = np.asarray(update["call_elo"], dtype=float)
        put_rating[:] = np.asarray(update["put_elo"], dtype=float)
        expected[:] = np.asarray(update["expected_call_score"], dtype=float)
        delta_rating[:] = np.asarray(update["elo_delta"], dtype=float)
        if ratings is not None:
            for i, (expiry_days, distance) in enumerate(keys):
                ratings[("call", float(expiry_days), float(distance))] = call_rating[i]
                ratings[("put", float(expiry_days), float(distance))] = put_rating[i]
    else:
        for i, (expiry_days, distance) in enumerate(keys):
            key_call = ("call", float(expiry_days), float(distance))
            key_put = ("put", float(expiry_days), float(distance))
            force_ratio = max(float(surface.at[i, "call_force"]), EPS) / max(float(surface.at[i, "put_force"]), EPS)
            confidence = float(surface.at[i, "confidence"])
            if ratings is None or key_call not in ratings:
                prior_gap = cfg.rating_scale * np.log10(force_ratio) * confidence
                c_rating = cfg.base_rating + 0.5 * prior_gap
                p_rating = cfg.base_rating - 0.5 * prior_gap
            else:
                c_rating = float(ratings[key_call])
                p_rating = float(ratings[key_put])

            exp_call = float(_expected_rating(np.array([c_rating]), np.array([p_rating]), cfg.rating_scale)[0])
            actual = float(surface.at[i, "effective_score"])
            delta = cfg.k_factor * confidence * (actual - exp_call)
            c_rating += delta
            p_rating -= delta
            call_rating[i] = c_rating
            put_rating[i] = p_rating
            expected[i] = exp_call
            delta_rating[i] = delta
            if ratings is not None:
                ratings[key_call] = c_rating
                ratings[key_put] = p_rating

    surface["expected_call_score"] = expected
    surface["elo_delta"] = delta_rating
    surface["call_elo"] = call_rating
    surface["put_elo"] = put_rating
    surface["elo_gap"] = call_rating - put_rating
    surface["elo_signal"] = np.tanh(surface["elo_gap"].to_numpy(float) / max(cfg.rating_scale, EPS))
    return surface


def premium_sentiment_elo(surface: pd.DataFrame) -> float:
    """Aggregate the paired ELO surface across distance and expiry."""

    if surface.empty:
        return 0.0
    weights = surface["pair_weight"].to_numpy(float)
    signals = surface["elo_signal"].to_numpy(float)
    return float(np.average(signals, weights=np.maximum(weights, EPS)))
