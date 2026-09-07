"""Ocean Wave: C++ accelerated option-surface forecasting.

The model combines budget-limited premium ELO, IV geometry, stock and inverse
confirmation, and verified macro signals. Missing evidence remains neutral;
liquidity, unsigned option inventory, and macro stress inform risk rather than
inventing institutional trading direction.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from math import erf, exp, sqrt
from typing import Mapping, Sequence

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core
from .elo import EPS, EloConfig, build_elo_surface, energy_cost, premium_sentiment_elo
from .factors import (
    FACTOR_NAMES,
    ChainFactorSummary,
    FactorBlend,
    FactorConfig,
    FactorState,
    adaptive_blend,
    extract_chain_factors,
    stock_confirmation,
)
from .inverse import InverseMarketData


@dataclass
class MarketState:
    spot: float
    high: float | None = None
    low: float | None = None
    vwap: float | None = None
    rvol: float | None = None
    realized_vol: float | None = None
    minutes_from_open: float | None = 0.0
    minutes_to_close_total: float = 390.0
    symbol: str | None = None
    previous_close: float | None = None
    return_5m: float | None = None
    return_15m: float | None = None
    stock_volume: float | None = None
    stock_dollar_volume: float | None = None
    data_confidence: float = 1.0


@dataclass(frozen=True)
class EventContext:
    """Timestamped event context that modifies risk, not direction."""

    minutes_to_earnings: float | None = None
    minutes_to_macro: float | None = None
    event_surprise_z: float | None = None
    headline_intensity: float | None = None
    confidence: float = 0.0
    as_of: pd.Timestamp | str | None = None


@dataclass
class PDEConfig:
    """Signed-score PDE; these coefficients are not probability-density terms.

    Time is minutes, distance is a return fraction, expiry is days. Diffusion
    uses coordinate squared/minute, drift distance/minute, reaction 1/minute.
    Zero normal gradient is imposed on both ends of both spatial axes.
    """

    distance_diffusion: float = 0.015
    expiry_diffusion: float = 0.010
    distance_drift: float = 0.0
    decay: float = 0.020
    source_strength: float = 0.080
    timestep_minutes: float = 1.0
    default_volatility: float = 0.25
    trading_minutes_per_year: float = 252.0 * 390.0
    liquidity_diffusion_penalty: float = 0.50
    vrp_variance_scale: float = 1.50


@dataclass
class InverseConfig:
    beta: float = -1.0
    minimum_confidence: float = 0.25


@dataclass
class ModelConfig:
    elo: EloConfig = field(default_factory=EloConfig)
    factors: FactorConfig = field(default_factory=FactorConfig)
    pde: PDEConfig = field(default_factory=PDEConfig)
    inverse: InverseConfig = field(default_factory=InverseConfig)
    forecast_horizons_minutes: tuple[float, ...] = (5.0, 15.0, 30.0, 60.0)
    minimum_actionable_edge: float = 0.10
    minimum_evidence_quality: float = 0.25
    minimum_market_data_quality: float = 0.50


@dataclass(frozen=True)
class Expectation:
    horizon_minutes: float
    integrated_signal: float
    average_signal: float
    expected_return: float
    expected_price: float
    return_variance: float
    price_variance: float
    probability_up: float


@dataclass
class ModelResult:
    trend_score: float
    direction: str
    confidence: float
    evidence_quality: float
    directional_edge: float
    confidence_semantics: str
    diagnostics: dict[str, object]
    factor_table: pd.DataFrame
    factor_covariance: np.ndarray
    chain_factors: ChainFactorSummary
    expectations: dict[float, Expectation]
    elo_surface: pd.DataFrame
    distance_grid: np.ndarray
    expiry_grid: np.ndarray
    field_grid: np.ndarray
    raw_probability: float = 0.5
    calibrated_probability: float = 0.5
    actionability: str = "abstain"
    abstain_reason: str | None = "unspecified"

    @property
    def expected_price(self) -> float:
        return self.expectations[max(self.expectations)].expected_price


def _numeric_column(frame: pd.DataFrame, name: str, default: float = 0.0) -> np.ndarray:
    if name not in frame:
        return np.full(len(frame), default, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce").fillna(default).to_numpy(float)


def _weighted_mean(values: np.ndarray, weights: np.ndarray) -> float:
    positive = np.maximum(np.asarray(weights, dtype=float), EPS)
    return float(np.sum(np.asarray(values, dtype=float) * positive) / np.sum(positive))


def _combine_indicators(values: Sequence[float], confidences: Sequence[float]) -> tuple[float, float]:
    value_array = np.asarray(values, dtype=float)
    confidence_array = np.clip(np.asarray(confidences, dtype=float), 0.0, 1.0)
    valid = np.isfinite(value_array) & np.isfinite(confidence_array) & (confidence_array > 0.0)
    if not np.any(valid):
        return 0.0, 0.0
    weights = confidence_array[valid]
    return (
        float(np.clip(np.average(value_array[valid], weights=weights), -1.0, 1.0)),
        float(np.clip(weights.mean(), 0.0, 1.0)),
    )


def _market_data_quality(state: MarketState) -> tuple[float, tuple[str, ...]]:
    """Return causal intraday-feature completeness without inventing values."""

    checks = {
        "vwap": state.vwap is not None and np.isfinite(state.vwap) and state.vwap > 0.0,
        "rvol": state.rvol is not None and np.isfinite(state.rvol) and state.rvol > 0.0,
        "return_5m": state.return_5m is not None and np.isfinite(state.return_5m),
        "return_15m": state.return_15m is not None and np.isfinite(state.return_15m),
        "realized_vol": (
            state.realized_vol is not None
            and np.isfinite(state.realized_vol)
            and state.realized_vol > 0.0
        ),
        "minutes_from_open": (
            state.minutes_from_open is not None
            and np.isfinite(state.minutes_from_open)
            and state.minutes_from_open >= 0.0
        ),
    }
    missing = tuple(name for name, present in checks.items() if not present)
    completeness = sum(checks.values()) / len(checks)
    source_value = state.data_confidence
    source_confidence = (
        float(np.clip(source_value, 0.0, 1.0))
        if source_value is not None and np.isfinite(source_value)
        else 0.0
    )
    return float(completeness * source_confidence), missing


_PUBLIC_DECIMALS = 12


def _canonical_float(value: float) -> float:
    """Remove backend-only floating noise at the public result boundary."""

    number = float(value)
    return float(round(number, _PUBLIC_DECIMALS)) if np.isfinite(number) else number


def _canonical_array(values: np.ndarray) -> np.ndarray:
    return np.round(np.asarray(values, dtype=float), decimals=_PUBLIC_DECIMALS)


def _canonical_expectation(value: Expectation) -> Expectation:
    return Expectation(*(_canonical_float(item) for item in (
        value.horizon_minutes,
        value.integrated_signal,
        value.average_signal,
        value.expected_return,
        value.expected_price,
        value.return_variance,
        value.price_variance,
        value.probability_up,
    )))


def _surface_grid(surface: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    distances = np.sort(surface["distance_pct"].unique().astype(float))
    expiries = np.sort(surface["expiry_days"].unique().astype(float))
    field_grid = np.zeros((len(expiries), len(distances)), dtype=float)
    weight_grid = np.zeros_like(field_grid)
    expiry_index = np.searchsorted(expiries, surface["expiry_days"].to_numpy(float))
    distance_index = np.searchsorted(distances, surface["distance_pct"].to_numpy(float))
    field_grid[expiry_index, distance_index] = surface["pair_signal"].to_numpy(float)
    weight_grid[expiry_index, distance_index] = surface["pair_weight"].to_numpy(float)
    return distances, expiries, field_grid, weight_grid


class _ImplicitPDEStepper:
    """Python reference for the allocation-bounded C++ implicit score solver."""

    def __init__(self, observed: np.ndarray, distances: np.ndarray, expiries: np.ndarray, config: PDEConfig):
        self.observed = np.asarray(observed, dtype=float)
        self.config = config
        self.axes = []
        if (self.observed.shape != (len(expiries), len(distances)) or not self.observed.size
                or self.observed.size > 1_000_000 or not np.all(np.isfinite(self.observed))
                or np.any(np.abs(self.observed) > 1.0)):
            raise ValueError("PDE field dimensions or values are invalid")
        if (not np.isfinite(config.decay) or config.decay < 0.0
                or not np.isfinite(config.source_strength) or config.source_strength < 0.0):
            raise ValueError("PDE reaction coefficients must be finite and nonnegative")
        for coordinates, diffusion, drift, axis in (
            (distances, config.distance_diffusion, config.distance_drift, 1),
            (expiries, config.expiry_diffusion, 0.0, 0),
        ):
            coordinates = np.asarray(coordinates, dtype=float)
            spacing = np.diff(coordinates)
            if (coordinates.ndim != 1 or not np.all(np.isfinite(coordinates))
                    or not np.all(np.isfinite(spacing)) or np.any(spacing <= 0.0)
                    or not np.isfinite(diffusion) or diffusion < 0.0 or not np.isfinite(drift)):
                raise ValueError("PDE coordinates must be strictly increasing and coefficients finite")
            left = np.zeros(len(coordinates))
            right = np.zeros(len(coordinates))
            for index in range(len(coordinates)):
                before = spacing[index - 1] if index > 0 else 0.0
                after = spacing[index] if index + 1 < len(coordinates) else 0.0
                width = 0.5 * before + 0.5 * after
                if index > 0:
                    left[index] = (diffusion / width + max(drift, 0.0)) / before
                if index + 1 < len(coordinates):
                    right[index] = (diffusion / width + max(-drift, 0.0)) / after
            if not np.all(np.isfinite(left)) or not np.all(np.isfinite(right)):
                raise ValueError("PDE grid spacing exceeds the finite numerical range")
            self.axes.append((axis, left, right, np.empty_like(left), np.empty_like(left), np.empty_like(left)))
        self.factored_dt = None

    def advance(self, field_grid: np.ndarray, timestep: float) -> np.ndarray:
        if not np.isfinite(timestep) or timestep <= 0.0:
            raise ValueError("PDE timestep must be finite and positive")
        if field_grid.shape != self.observed.shape or not np.all(np.isfinite(field_grid)):
            raise ValueError("PDE field dimensions or values are invalid")
        if timestep != self.factored_dt:
            for _, left, right, inverse, lower, upper in self.axes:
                previous_gap = 1.0
                for index in range(len(left)):
                    scaled_left = timestep * left[index]
                    scaled_right = timestep * right[index]
                    remainder = 1.0 + scaled_left * previous_gap
                    pivot = remainder + scaled_right
                    if not np.isfinite(pivot) or pivot <= 0.0:
                        raise ValueError("PDE timestep and grid exceed the finite numerical range")
                    inverse[index] = 1.0 / pivot
                    lower[index] = scaled_left / pivot
                    upper[index] = scaled_right / pivot
                    previous_gap = remainder / pivot
            self.factored_dt = timestep
        denominator = 1.0 + timestep * self.config.decay + timestep * self.config.source_strength
        if not np.isfinite(denominator):
            raise ValueError("PDE reaction exceeds the finite numerical range")
        result = (1.0 / denominator) * field_grid + (
            (timestep * self.config.source_strength) / denominator
        ) * self.observed
        for axis, _, _, inverse, lower, upper in self.axes:
            lines = result.T if axis == 1 else result
            lines[0] *= inverse[0]
            for index in range(1, len(inverse)):
                lines[index] = lines[index] * inverse[index] + lower[index] * lines[index - 1]
            for index in range(len(inverse) - 2, -1, -1):
                lines[index] += upper[index] * lines[index + 1]
        if not np.all(np.isfinite(result)):
            raise ValueError("PDE produced a non-finite score field")
        return result


def _advance_pde(
    field_grid: np.ndarray,
    observed: np.ndarray,
    distances: np.ndarray,
    expiries: np.ndarray,
    config: PDEConfig,
    timestep: float,
) -> np.ndarray:
    return _ImplicitPDEStepper(observed, distances, expiries, config).advance(field_grid, timestep)


def _evolve_pde(
    observed: np.ndarray,
    weights: np.ndarray,
    distances: np.ndarray,
    expiries: np.ndarray,
    config: PDEConfig,
    horizons: Sequence[float],
    retain_scores: bool = False,
) -> dict[str, np.ndarray]:
    """Integrate exactly to the final horizon; interpolate fractional integrals.

    Only requested output and one score field are retained by default. Returned
    scores, when requested, use regular time steps plus a shorter final step.
    """
    requested = np.asarray(horizons, dtype=float)
    dt = float(config.timestep_minutes)
    if (requested.ndim != 1 or not len(requested) or len(requested) > 10_000
            or not np.all(np.isfinite(requested)) or np.any(requested <= 0.0)
            or not np.isfinite(dt) or dt <= 0.0):
        raise ValueError("forecast horizons or timestep are invalid")
    raw_steps = np.ceil(np.max(requested) / dt)
    if not np.isfinite(raw_steps) or raw_steps < 1 or raw_steps > 1_000_000:
        raise ValueError("forecast step count exceeds the safety limit")
    steps = int(raw_steps)
    stepper = _ImplicitPDEStepper(observed, distances, expiries, config)
    field_grid = stepper.observed.copy()
    if field_grid.size * steps > 100_000_000:
        raise ValueError("forecast workload exceeds the safety limit")
    weights = np.asarray(weights, dtype=float)
    if weights.shape != field_grid.shape or not np.all(np.isfinite(weights)) or np.any(weights < 0.0):
        raise ValueError("PDE weights must be finite, nonnegative, and match the field")
    normalized_weights = np.maximum(weights, EPS)
    normalized_weights /= np.max(normalized_weights)
    normalized_weights /= np.sum(normalized_weights)
    order = np.argsort(requested, kind="stable")
    next_horizon = 0
    previous_score = float(np.sum(field_grid * normalized_weights))
    scores = [previous_score] if retain_scores else []
    integrals = np.empty(len(requested))
    averages = np.empty(len(requested))
    integrated = 0.0
    previous_time = 0.0
    final_time = float(np.max(requested))
    for step in range(1, steps + 1):
        time = final_time if step == steps else min(step * dt, final_time)
        step_dt = time - previous_time
        if step_dt <= 0.0:
            continue
        field_grid = stepper.advance(field_grid, step_dt)
        score = float(np.sum(field_grid * normalized_weights))
        if retain_scores:
            scores.append(score)
        while next_horizon < len(order) and requested[order[next_horizon]] <= time:
            index = order[next_horizon]
            horizon = requested[index]
            partial = horizon - previous_time
            partial_score = previous_score + (score - previous_score) * (partial / step_dt)
            integrals[index] = integrated + 0.5 * (previous_score + partial_score) * partial
            averages[index] = integrals[index] / horizon
            next_horizon += 1
        integrated += 0.5 * (previous_score + score) * step_dt
        previous_score = score
        previous_time = time
    return {"field": field_grid, "scores": np.asarray(scores), "integrals": integrals, "averages": averages}


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + erf(value / sqrt(2.0)))


class OceanWave:
    """Online Ocean Wave model with C++ numerical kernels."""

    def __init__(self, config: ModelConfig | None = None) -> None:
        self.config = config or ModelConfig()
        if self.config.factors.names != FACTOR_NAMES:
            raise ValueError("Ocean Wave requires the named eight-factor budget schema")
        self._ratings: dict[tuple[str, float, float], float] = {}
        self._factor_state = FactorState.create(self.config.factors)
        self._state_migration: str | None = None

    def reset(self) -> None:
        self._ratings.clear()
        self._factor_state = FactorState.create(self.config.factors)
        self._state_migration = None

    def state_dict(self) -> dict[str, object]:
        """Return a JSON-serializable online state for one underlying symbol."""

        ratings = [
            {
                "right": str(key[0]),
                "expiry_days": float(key[1]),
                "distance_pct": float(key[2]),
                "rating": float(value),
            }
            for key, value in sorted(self._ratings.items(), key=lambda item: item[0])
        ]
        return {
            "schema_version": "ocean-wave-state.v3",
            "weighting_scheme": "bounded-correlation-budget.v2",
            "factor_names": list(self.config.factors.names),
            "factor_budgets": list(self.config.factors.priors),
            "state_migration": self._state_migration,
            "ratings": ratings,
            "factor_state": {
                "mean": self._factor_state.mean.tolist(),
                "covariance": self._factor_state.covariance.tolist(),
                "count": float(self._factor_state.count),
            },
        }

    def load_state_dict(self, payload: dict[str, object]) -> None:
        """Restore validated online state without using executable pickle data."""

        schema = payload.get("schema_version")
        if schema not in {"ocean-wave-state.v1", "ocean-wave-state.v2", "ocean-wave-state.v3"}:
            raise ValueError("unsupported Ocean Wave state schema")
        restored_ratings: dict[tuple[str, float, float], float] = {}
        rating_entries = payload.get("ratings", [])
        if not isinstance(rating_entries, list) or len(rating_entries) > 20000:
            raise ValueError("invalid or excessive ELO rating state")
        for item in rating_entries:
            if not isinstance(item, dict):
                raise ValueError("invalid rating state entry")
            key = (
                str(item["right"]),
                float(item["expiry_days"]),
                float(item["distance_pct"]),
            )
            value = float(item["rating"])
            if (key[0] not in {"call", "put"} or not np.isfinite(key[1]) or not np.isfinite(key[2])
                    or key[1] < 0.0 or key[2] < 0.0 or not np.isfinite(value)):
                raise ValueError("rating state must be finite")
            restored_ratings[key] = value

        if schema == "ocean-wave-state.v1":
            # V1's unnamed nine-dimensional covariance encoded deleted factors
            # and normalized-away missing budgets. Never import those weights.
            self._ratings = restored_ratings
            self._factor_state = FactorState.create(self.config.factors)
            self._state_migration = "v1_factor_covariance_reset_preserved_elo_ratings"
            return
        expected_scheme = ("bounded-correlation-budget.v1" if schema == "ocean-wave-state.v2"
                           else "bounded-correlation-budget.v2")
        if (payload.get("weighting_scheme") != expected_scheme
                or payload.get("factor_names") != list(self.config.factors.names)
                or payload.get("factor_budgets") != list(self.config.factors.priors)):
            raise ValueError("incompatible named factor budget state")

        factor = payload.get("factor_state")
        if not isinstance(factor, dict):
            raise ValueError("missing factor state")
        mean = np.asarray(factor.get("mean"), dtype=float)
        covariance = np.asarray(factor.get("covariance"), dtype=float)
        dimension = len(self.config.factors.names)
        if mean.shape != (dimension,) or covariance.shape != (dimension, dimension):
            raise ValueError("factor state has incompatible dimensions")
        if not np.all(np.isfinite(mean)) or not np.all(np.isfinite(covariance)):
            raise ValueError("factor state must be finite")
        if (not np.allclose(covariance, covariance.T, atol=1e-12, rtol=1e-12)
                or float(np.min(np.linalg.eigvalsh(covariance))) < -1e-10):
            raise ValueError("factor covariance must be symmetric positive semidefinite")
        count = float(factor.get("count", 0.0))
        if not np.isfinite(count) or count < 0.0:
            raise ValueError("factor state count is invalid")

        if schema == "ocean-wave-state.v2":
            # Old quality/self-correlation penalties define a different base.
            # Preserve validated ELO observations, but not old blend state.
            self._ratings = restored_ratings
            self._factor_state = FactorState.create(self.config.factors)
            self._state_migration = "v2_factor_covariance_reset_preserved_elo_ratings"
            return

        self._ratings = restored_ratings
        self._factor_state = FactorState(mean=mean, covariance=covariance, count=count)
        migration = payload.get("state_migration")
        self._state_migration = migration if isinstance(migration, str) else None

    def _inverse_observation(
        self,
        inverse_chain: pd.DataFrame | None,
        inverse_state: MarketState | None,
        inverse_beta: float,
    ) -> tuple[float, float, float]:
        if inverse_state is None or not np.isfinite(inverse_state.spot) or inverse_state.spot <= 0.0:
            return 0.0, 0.0, 0.0
        if not np.isfinite(inverse_state.data_confidence):
            return 0.0, 0.0, 0.0
        if not np.isfinite(inverse_beta) or inverse_beta >= 0.0:
            return 0.0, 0.0, 0.0
        for name, minutes in (("return_5m", 5.0), ("return_15m", 15.0)):
            observed_return = getattr(inverse_state, name, None)
            if observed_return is None or not np.isfinite(observed_return) or observed_return <= -1.0:
                continue
            inverse_log_return = float(np.log1p(observed_return))
            native_volatility = float(inverse_state.realized_vol or (self.config.pde.default_volatility * abs(inverse_beta)))
            if not np.isfinite(native_volatility) or native_volatility <= 0.0:
                return 0.0, 0.0, 0.0
            target_volatility = max(native_volatility / abs(inverse_beta), 1e-6)
            target_return = inverse_log_return / inverse_beta
            scale = target_volatility * sqrt(minutes / self.config.pde.trading_minutes_per_year)
            target = float(np.tanh(target_return / max(scale, EPS)))
            quality = float(np.clip(inverse_state.data_confidence, 0.0, 1.0))
            return -target, target, quality
        if inverse_chain is not None and not inverse_chain.empty:
            inverse_surface = build_elo_surface(inverse_chain, inverse_state.spot, self.config.elo, {})
            price_signal = 2.0 * inverse_surface["effective_score"].to_numpy(float) - 1.0
            confidence = inverse_surface["confidence"].to_numpy(float)
            pair_signal = confidence * inverse_surface["elo_signal"].to_numpy(float) + (1.0 - confidence) * price_signal
            native = _weighted_mean(pair_signal, inverse_surface["pair_weight"].to_numpy(float))
            quality = _weighted_mean(confidence, inverse_surface["pair_weight"].to_numpy(float))
        elif inverse_state.previous_close is not None and inverse_state.previous_close > 0.0:
            inverse_return = np.log(inverse_state.spot / inverse_state.previous_close)
            native_volatility = inverse_state.realized_vol or self.config.pde.default_volatility * abs(inverse_beta)
            if not np.isfinite(native_volatility) or native_volatility <= 0.0:
                return 0.0, 0.0, 0.0
            elapsed = float(inverse_state.minutes_from_open or 390.0)
            elapsed = float(np.clip(elapsed, 1.0, 390.0))
            scale = max(native_volatility * sqrt(elapsed / self.config.pde.trading_minutes_per_year), 1e-6)
            native = float(np.tanh(inverse_return / scale))
            quality = 0.25 * float(np.clip(inverse_state.data_confidence, 0.0, 1.0))
            return native, -native, quality
        else:
            return 0.0, 0.0, 0.0
        if inverse_beta != 0.0:
            bounded = float(np.clip(native, -0.999999, 0.999999))
            target = float(np.sign(inverse_beta) * np.tanh(np.arctanh(bounded) / max(abs(inverse_beta), 1.0)))
        else:
            target = 0.0
        return float(np.clip(native, -1.0, 1.0)), float(np.clip(target, -1.0, 1.0)), float(quality)

    def _inverse_observations(
        self,
        markets: Sequence[InverseMarketData],
    ) -> tuple[float, float, float, tuple[str, ...]]:
        native_values: list[float] = []
        target_values: list[float] = []
        confidences: list[float] = []
        symbols: list[str] = []
        for market in markets:
            if market.state is None or not isinstance(market.state, MarketState):
                continue
            try:
                native, target, confidence = self._inverse_observation(
                    market.chain if isinstance(market.chain, pd.DataFrame) else None,
                    market.state,
                    market.beta,
                )
            except (ValueError, RuntimeError):
                continue
            confidence = float(np.clip(confidence * market.confidence, 0.0, 1.0))
            if confidence <= 0.0:
                continue
            native_values.append(native)
            target_values.append(target)
            confidences.append(confidence)
            symbols.append(market.symbol.upper())
        if not confidences:
            return 0.0, 0.0, 0.0, tuple()
        native_signal, _ = _combine_indicators(native_values, confidences)
        target_signal, confidence = _combine_indicators(target_values, confidences)
        return native_signal, target_signal, confidence, tuple(symbols)

    def _dynamic_pde_config(self, chain_summary: ChainFactorSummary) -> tuple[PDEConfig, float]:
        base = self.config.pde
        illiquidity = 1.0 - float(np.clip(chain_summary.liquidity_quality, 0.0, 1.0))
        vrp_stress = min(abs(chain_summary.volatility_risk_premium), 0.50)
        # Call-minus-put OI*Gamma does not identify dealer inventory. Retain
        # those observables for audit, not an assumed signed hedge multiplier.
        return replace(
            base,
            distance_diffusion=base.distance_diffusion * (1.0 + base.liquidity_diffusion_penalty * illiquidity + vrp_stress),
            expiry_diffusion=base.expiry_diffusion * (1.0 + 0.50 * vrp_stress),
        ), 1.0

    def _factor_observations(
        self,
        premium_signal: float,
        mean_pair_confidence: float,
        chain_summary: ChainFactorSummary,
        state: MarketState,
        inverse_target_signal: float,
        inverse_confidence: float,
        market_context: Mapping[str, object] | None,
    ) -> tuple[list[float], list[float], dict[str, object]]:
        liquidity = float(np.clip(chain_summary.liquidity_quality, 0.0, 1.0))
        premium_confidence = mean_pair_confidence * (0.40 + 0.60 * liquidity)
        stock_signal, stock_confidence = stock_confirmation(state)
        context = market_context or {}
        if not isinstance(context, Mapping):
            raise ValueError("market_context must be a mapping")

        def observed(value: object, confidence: object) -> tuple[float, float]:
            if value is None:
                return 0.0, 0.0
            try:
                signal_value, quality = float(value), float(confidence)
            except (TypeError, ValueError):
                return 0.0, 0.0
            if not np.isfinite(signal_value) or not np.isfinite(quality):
                return 0.0, 0.0
            return float(np.clip(signal_value, -1.0, 1.0)), float(np.clip(quality, 0.0, 1.0))

        if "inverse_signal" in context:
            inverse_target_signal, inverse_confidence = observed(
                context.get("inverse_signal"), context.get("inverse_confidence", 0.0)
            )
        macro_signals = context.get("macro_signals") or {}
        macro_confidences = context.get("macro_confidences") or {}
        if not isinstance(macro_signals, Mapping) or not isinstance(macro_confidences, Mapping):
            raise ValueError("macro signals and confidences must be mappings")
        macro = [observed(macro_signals.get(name), macro_confidences.get(name, 0.0))
                 for name in ("gold", "treasury_10y", "dollar_index", "vix")]
        values = [premium_signal, chain_summary.iv_surface_signal, stock_signal, inverse_target_signal,
                  *(item[0] for item in macro)]
        confidences = [premium_confidence, chain_summary.iv_confidence, stock_confidence,
                       inverse_confidence if inverse_confidence >= self.config.inverse.minimum_confidence else 0.0,
                       *(item[1] for item in macro)]
        details: dict[str, object] = {
            "premium_signal": premium_signal,
            "premium_confidence": premium_confidence,
            "stock_signal": stock_signal,
            "stock_confidence": stock_confidence,
            "macro_directional_observations": sum(item[1] > 0.0 for item in macro),
            "weighting_scheme": "bounded-correlation-budget.v2",
            "deleted_directional_factors": ["institutional_flow", "dealer_hedge",
                                            "short_pressure", "oi_positioning", "liquidity_energy"],
        }
        return values, confidences, details

    @staticmethod
    def _event_risk(context: EventContext | None) -> tuple[float, float, dict[str, float]]:
        """Return variance/confidence multipliers without fabricating direction."""
        if context is None or context.confidence <= 0.0:
            return 1.0, 1.0, {"event_risk_multiplier": 1.0, "event_confidence_multiplier": 1.0}
        confidence = float(np.clip(context.confidence, 0.0, 1.0))

        def proximity(minutes: float | None, half_life: float) -> float:
            if minutes is None or not np.isfinite(minutes) or minutes < 0.0:
                return 0.0
            return float(np.exp(-float(minutes) / half_life))

        earnings = proximity(context.minutes_to_earnings, 390.0)
        macro = proximity(context.minutes_to_macro, 180.0)
        surprise = min(abs(float(context.event_surprise_z or 0.0)), 3.0) / 3.0
        headlines = float(np.clip(context.headline_intensity or 0.0, 0.0, 1.0))
        raw = 0.75 * max(earnings, macro) + 0.20 * surprise + 0.15 * headlines
        variance_multiplier = float(1.0 + confidence * raw)
        confidence_multiplier = float(1.0 / variance_multiplier)
        return variance_multiplier, confidence_multiplier, {
            "event_risk_multiplier": variance_multiplier,
            "event_confidence_multiplier": confidence_multiplier,
            "event_earnings_proximity": earnings,
            "event_macro_proximity": macro,
            "event_surprise_magnitude": surprise,
            "event_headline_intensity": headlines,
        }

    def predict(
        self,
        chain: pd.DataFrame,
        state: MarketState,
        *,
        horizons_minutes: tuple[float, ...] | None = None,
        previous_chain: pd.DataFrame | None = None,
        inverse_chain: pd.DataFrame | None = None,
        inverse_state: MarketState | None = None,
        inverse_beta: float | None = None,
        inverse_markets: Sequence[InverseMarketData] | None = None,
        event_context: EventContext | None = None,
        market_context: Mapping[str, object] | None = None,
        training_day_valid: bool = True,
    ) -> ModelResult:
        """Calculate the Ocean Wave field and integrated price expectations.

        An invalid training day is still scored for diagnosis, but all online
        ELO and covariance updates are applied to disposable copies.  Existing
        callers retain the original learning behavior because the new keyword
        defaults to ``True``.
        """

        if state.spot <= 0.0:
            raise ValueError("state.spot must be positive")
        if not isinstance(training_day_valid, bool):
            raise TypeError("training_day_valid must be bool")
        if market_context is not None and not isinstance(market_context, Mapping):
            raise ValueError("market_context must be a mapping")
        context = market_context or {}
        for name in ("macro_signals", "macro_confidences"):
            if context.get(name) is not None and not isinstance(context[name], Mapping):
                raise ValueError(f"{name} must be a mapping")
        macro_risk_multiplier = float(context.get("risk_multiplier", 1.0))
        if not np.isfinite(macro_risk_multiplier) or macro_risk_multiplier < 1.0:
            raise ValueError("market context risk_multiplier must be finite and at least one")
        ratings = self._ratings if training_day_valid else dict(self._ratings)
        factor_state = self._factor_state if training_day_valid else FactorState(
            mean=self._factor_state.mean.copy(),
            covariance=self._factor_state.covariance.copy(),
            count=float(self._factor_state.count),
        )
        chain_summary = extract_chain_factors(
            chain,
            state.spot,
            realized_vol=state.realized_vol,
            previous_chain=previous_chain,
        )
        elo_config = self.config.elo
        surface = build_elo_surface(chain, state.spot, elo_config, ratings)
        if HAS_CPP_CORE and hasattr(cpp_core, "aggregate_surface_signals"):
            aggregate = cpp_core.aggregate_surface_signals(
                np.ascontiguousarray(surface["effective_score"].to_numpy(float)),
                np.ascontiguousarray(surface["confidence"].to_numpy(float)),
                np.ascontiguousarray(surface["elo_signal"].to_numpy(float)),
                np.ascontiguousarray(surface["pair_weight"].to_numpy(float)),
            )
            surface["pair_signal"] = np.asarray(aggregate["pair_signal"], dtype=float)
            premium_signal = float(aggregate["premium_signal"])
            mean_pair_confidence = float(aggregate["mean_pair_confidence"])
        else:
            price_signal = 2.0 * surface["effective_score"].to_numpy(float) - 1.0
            pair_confidence = surface["confidence"].to_numpy(float)
            surface["pair_signal"] = pair_confidence * surface["elo_signal"].to_numpy(float) + (1.0 - pair_confidence) * price_signal
            premium_signal = premium_sentiment_elo(surface)
            mean_pair_confidence = _weighted_mean(
                surface["confidence"].to_numpy(float),
                surface["pair_weight"].to_numpy(float),
            )

        inverse_inputs: list[InverseMarketData] = list(inverse_markets or ())
        if inverse_chain is not None or inverse_state is not None:
            inverse_inputs.insert(0, InverseMarketData(
                symbol=(inverse_state.symbol if inverse_state is not None and inverse_state.symbol else "INVERSE"),
                chain=inverse_chain,
                state=inverse_state,
                beta=self.config.inverse.beta if inverse_beta is None else float(inverse_beta),
            ))
        inverse_native, inverse_target, inverse_confidence, inverse_symbols = self._inverse_observations(inverse_inputs)
        factor_values, factor_confidences, factor_details = self._factor_observations(
            premium_signal,
            mean_pair_confidence,
            chain_summary,
            state,
            inverse_target,
            inverse_confidence,
            market_context,
        )
        blend: FactorBlend = adaptive_blend(factor_values, factor_confidences, factor_state, self.config.factors)
        inverse_target, inverse_confidence = factor_values[3], factor_confidences[3]
        if "inverse_signal" in context:
            # The live context replaces the optional legacy chain path; do not
            # display a zero source count or a made-up native-space signal.
            inverse_native = None
            context_symbol = context.get("inverse_symbol")
            inverse_symbols = ([context_symbol] if inverse_confidence > 0.0
                               and isinstance(context_symbol, str) and 0 < len(context_symbol) <= 16 else [])
        event_variance_multiplier, event_confidence_multiplier, event_details = self._event_risk(event_context)
        event_variance_multiplier *= macro_risk_multiplier
        # The ELO curve shape is also evidence: leaving its raw amplitude in
        # the PDE would bypass the explicit factor budget through a back door.
        elo_weight = float(blend.weights[self.config.factors.names.index("premium_elo")])
        budgeted_pair_signal = surface["pair_signal"].to_numpy(float) * elo_weight

        horizons = tuple(sorted(set(horizons_minutes or self.config.forecast_horizons_minutes)))
        if not horizons or horizons[0] <= 0.0:
            raise ValueError("horizons_minutes must contain positive values")
        pde_config, gamma_multiplier = self._dynamic_pde_config(chain_summary)
        timestep = float(pde_config.timestep_minutes)
        volatility = self._volatility(chain, state, chain_summary)
        expectations: dict[float, Expectation] = {}
        if HAS_CPP_CORE and hasattr(cpp_core, "forecast_surface"):
            forecast = cpp_core.forecast_surface(
                np.ascontiguousarray(surface["expiry_days"].to_numpy(float)),
                np.ascontiguousarray(surface["distance_pct"].to_numpy(float)),
                np.ascontiguousarray(budgeted_pair_signal),
                np.ascontiguousarray(surface["pair_weight"].to_numpy(float)),
                np.ascontiguousarray(surface["pair_variance"].to_numpy(float)),
                float(blend.signal),
                float(blend.confidence),
                float(blend.projected_variance),
                float(state.spot),
                float(volatility),
                float(chain_summary.liquidity_quality),
                float(chain_summary.volatility_risk_premium),
                float(pde_config.vrp_variance_scale),
                float(gamma_multiplier),
                float(pde_config.trading_minutes_per_year),
                float(pde_config.distance_diffusion),
                float(pde_config.expiry_diffusion),
                float(pde_config.distance_drift),
                float(pde_config.decay),
                float(pde_config.source_strength),
                float(timestep),
                list(horizons),
            )
            distances = np.asarray(forecast["distances"], dtype=float)
            expiries = np.asarray(forecast["expiries"], dtype=float)
            field_grid = np.asarray(forecast["field"], dtype=float).reshape(len(expiries), len(distances))
            integrated_values = np.asarray(forecast["integrals"], dtype=float)
            average_values = np.asarray(forecast["averages"], dtype=float)
            expected_returns = np.asarray(forecast["expected_returns"], dtype=float)
            expected_prices = np.asarray(forecast["expected_prices"], dtype=float)
            return_variances = np.asarray(forecast["return_variances"], dtype=float)
            price_variances = np.asarray(forecast["price_variances"], dtype=float)
            probabilities_up = np.asarray(forecast["probabilities_up"], dtype=float)
            for values in zip(
                horizons,
                integrated_values,
                average_values,
                expected_returns,
                expected_prices,
                return_variances,
                price_variances,
                probabilities_up,
            ):
                horizon, integrated, average, expected_return, expected_price, return_variance, price_variance, probability_up = values
                adjusted_variance = float(return_variance) * event_variance_multiplier
                expected_log_return = np.log1p(float(expected_return)) - 0.5 * float(return_variance)
                probability_up = _normal_cdf(expected_log_return / max(sqrt(adjusted_variance), EPS))
                if event_variance_multiplier != 1.0:
                    expected_return = float(np.expm1(expected_log_return + 0.5 * adjusted_variance))
                    expected_price = state.spot * exp(expected_log_return + 0.5 * adjusted_variance)
                    price_variance = expected_price * expected_price * np.expm1(adjusted_variance)
                expectations[float(horizon)] = Expectation(
                    float(horizon),
                    float(integrated),
                    float(average),
                    float(expected_return),
                    float(expected_price),
                    adjusted_variance,
                    float(price_variance),
                    float(probability_up),
                )
            current_field_signal = float(forecast["current_field_signal"])
            trend_score = float(forecast["trend_score"])
            confidence = float(forecast["confidence"])
            median_distance = float(forecast["median_distance"])
        else:
            budgeted_surface = surface.assign(pair_signal=budgeted_pair_signal)
            distances, expiries, observed, grid_weights = _surface_grid(budgeted_surface)
            current_field_signal = _weighted_mean(observed.ravel(), grid_weights.ravel())
            distance_basis = np.exp(-np.abs(distances) / 0.08)
            expiry_basis = np.exp(-expiries / 45.0)
            source_basis = expiry_basis[:, None] * distance_basis[None, :]
            basis_mean = _weighted_mean(source_basis.ravel(), grid_weights.ravel())
            source_basis /= max(basis_mean, EPS)
            observed = np.clip(observed + (blend.signal - current_field_signal) * source_basis, -1.0, 1.0)
            evolution = _evolve_pde(observed, grid_weights, distances, expiries, pde_config, horizons)
            field_grid = evolution["field"]
            integrated_values = evolution["integrals"]
            average_values = evolution["averages"]
            mean_pair_variance = _weighted_mean(surface["pair_variance"].to_numpy(float), surface["pair_weight"].to_numpy(float))
            liquidity_risk = 1.0 - float(np.clip(chain_summary.liquidity_quality, 0.0, 1.0))
            for horizon, integrated, average in zip(horizons, integrated_values, average_values):
                integrated_value = float(integrated)
                average_value = float(average)
                year_fraction = float(horizon) / pde_config.trading_minutes_per_year
                expected_log_return = average_value * volatility * sqrt(max(year_fraction, 0.0)) * gamma_multiplier
                risk_multiplier = (
                    1.0
                    + mean_pair_variance
                    + blend.projected_variance
                    + liquidity_risk
                    + pde_config.vrp_variance_scale * abs(chain_summary.volatility_risk_premium)
                )
                return_variance = volatility * volatility * max(year_fraction, 0.0) * risk_multiplier * event_variance_multiplier
                expected_price = state.spot * exp(expected_log_return + 0.5 * return_variance)
                price_variance = expected_price * expected_price * np.expm1(return_variance)
                z_score = expected_log_return / max(sqrt(return_variance), EPS)
                expectations[float(horizon)] = Expectation(
                    float(horizon),
                    integrated_value,
                    average_value,
                    float(np.expm1(expected_log_return + 0.5 * return_variance)),
                    float(expected_price),
                    float(return_variance),
                    float(max(price_variance, 0.0)),
                    float(_normal_cdf(z_score)),
                )
            longest = expectations[max(expectations)]
            trend_score = float(np.tanh(longest.average_signal))
            confidence = float(np.clip(
                blend.confidence
                * np.exp(-blend.projected_variance),
                0.0,
                1.0,
            ))
            median_distance = float(np.median(distances))

        # Native and reference kernels intentionally implement the same
        # equations, but different instruction order can leave a few ulps of
        # noise. Canonicalize only once, at the public output boundary.
        expectations = {
            _canonical_float(horizon): _canonical_expectation(value)
            for horizon, value in expectations.items()
        }
        distances = _canonical_array(distances)
        expiries = _canonical_array(expiries)
        field_grid = _canonical_array(field_grid)
        surface = surface.round(_PUBLIC_DECIMALS)
        trend_score = _canonical_float(trend_score)
        confidence = _canonical_float(
            np.clip(confidence * event_confidence_multiplier, 0.0, 1.0)
        )
        current_field_signal = _canonical_float(current_field_signal)
        longest = expectations[max(expectations)]
        evidence_quality = confidence
        raw_probability = float(np.clip(longest.probability_up, 0.0, 1.0))
        directional_edge = _canonical_float(np.clip(2.0 * abs(raw_probability - 0.5), 0.0, 1.0))
        market_data_quality, missing_market_features = _market_data_quality(state)
        calibration_strength = float(np.clip(evidence_quality * market_data_quality, 0.0, 1.0))
        calibrated_probability = _canonical_float(0.5 + (raw_probability - 0.5) * calibration_strength)
        calibrated_directional_edge = _canonical_float(
            np.clip(2.0 * abs(calibrated_probability - 0.5), 0.0, 1.0)
        )
        abstain_reasons: list[str] = []
        if not training_day_valid:
            abstain_reasons.append("invalid_training_day")
        if market_data_quality < float(np.clip(self.config.minimum_market_data_quality, 0.0, 1.0)):
            abstain_reasons.append("insufficient_market_data")
        if evidence_quality < float(np.clip(self.config.minimum_evidence_quality, 0.0, 1.0)):
            abstain_reasons.append("insufficient_evidence_quality")
        if calibrated_directional_edge < float(np.clip(self.config.minimum_actionable_edge, 0.0, 1.0)):
            abstain_reasons.append("weak_directional_edge")
        actionability = "abstain" if abstain_reasons else "actionable"
        abstain_reason = abstain_reasons[0] if abstain_reasons else None
        raw_direction = self._direction(trend_score)
        direction = "Abstain" if abstain_reasons else raw_direction
        confidence_semantics = "evidence_reliability_not_direction_probability"
        diagnostics: dict[str, object] = {
            **factor_details,
            "model_name": "Ocean Wave",
            "cpp_core": HAS_CPP_CORE,
            "composite_signal": blend.signal,
            "composite_confidence": blend.confidence,
            "projected_factor_variance": blend.projected_variance,
            "neutral_factor_weight": _canonical_float(blend.neutral_weight),
            "factor_kkt_residual": _canonical_float(blend.kkt_residual),
            "elo_field_weight": _canonical_float(elo_weight),
            "factor_state_migration": self._state_migration,
            "macro_risk_multiplier": macro_risk_multiplier,
            "current_field_signal": current_field_signal,
            "energy_signal": chain_summary.energy_signal,
            "iv_skew": chain_summary.iv_skew,
            "iv_term_slope": chain_summary.iv_term_slope,
            "iv_curvature": chain_summary.iv_curvature,
            "volatility_risk_premium": chain_summary.volatility_risk_premium,
            "oi_signal": chain_summary.oi_signal,
            "gex_balance": chain_summary.gex_balance,
            "gex_net": chain_summary.gex_net,
            "gamma_multiplier": gamma_multiplier,
            "liquidity_quality": chain_summary.liquidity_quality,
            "inverse_native_signal": inverse_native,
            "inverse_target_signal": inverse_target,
            "inverse_confidence": inverse_confidence,
            **event_details,
            "inverse_count": float(len(inverse_symbols)),
            "inverse_symbols": ",".join(inverse_symbols),
            "energy_cost_at_median_distance": float(energy_cost(median_distance, elo_config)),
            "expected_return": longest.expected_return,
            "probability_up": raw_probability,
            "raw_probability": raw_probability,
            "calibrated_probability": calibrated_probability,
            "calibration_strength": calibration_strength,
            "evidence_quality": evidence_quality,
            "market_data_quality": market_data_quality,
            "missing_market_features": list(missing_market_features),
            "directional_edge": directional_edge,
            "calibrated_directional_edge": calibrated_directional_edge,
            "raw_direction": raw_direction,
            "actionability": actionability,
            "abstain_reason": abstain_reason,
            "abstain_reasons": list(abstain_reasons),
            "training_day_valid": training_day_valid,
            "confidence_semantics": confidence_semantics,
        }
        return ModelResult(
            trend_score=trend_score,
            direction=direction,
            confidence=confidence,
            evidence_quality=evidence_quality,
            directional_edge=directional_edge,
            confidence_semantics=confidence_semantics,
            diagnostics=diagnostics,
            factor_table=blend.table.round(_PUBLIC_DECIMALS),
            factor_covariance=_canonical_array(factor_state.covariance.copy()),
            chain_factors=chain_summary,
            expectations=expectations,
            elo_surface=surface,
            distance_grid=distances,
            expiry_grid=expiries,
            field_grid=field_grid,
            raw_probability=raw_probability,
            calibrated_probability=calibrated_probability,
            actionability=actionability,
            abstain_reason=abstain_reason,
        )

    def _volatility(self, chain: pd.DataFrame, state: MarketState, summary: ChainFactorSummary) -> float:
        if state.realized_vol is not None and state.realized_vol > 0.0:
            return float(state.realized_vol)
        if summary.iv_level > 0.0:
            return float(summary.iv_level)
        iv_values: list[float] = []
        for column in ("call_iv", "put_iv", "iv"):
            if column in chain:
                values = _numeric_column(chain, column, np.nan)
                iv_values.extend(values[np.isfinite(values) & (values > 0.0)].tolist())
        return float(np.median(iv_values)) if iv_values else float(self.config.pde.default_volatility)

    @staticmethod
    def _direction(score: float) -> str:
        if score >= 0.70:
            return "Strong Bullish"
        if score >= 0.30:
            return "Bullish"
        if score > 0.10:
            return "Mild Bullish"
        if score <= -0.70:
            return "Strong Bearish"
        if score <= -0.30:
            return "Bearish"
        if score < -0.10:
            return "Mild Bearish"
        return "Neutral"


# Backward-compatible import for existing users of the v0.9 package API.
OptionWaveV09 = OceanWave
