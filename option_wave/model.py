"""Option Wave v0.9: symmetric ELO + variance-aware continuous field.

The model deliberately has one path from quotes to output:

    paired premiums -> variance-aware ELO surface -> PDE evolution
    -> time integral -> expected return/price distribution

There are no independent hand-tuned factor weights in this version.  Quote
activity and expiry enter as integration weights; uncertainty contracts the
pair signal before it reaches the field.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import erf, exp, sqrt

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core
from .elo import (
    EPS,
    EloConfig,
    asymmetric_cost,
    build_elo_surface,
    premium_sentiment_elo,
)


@dataclass
class MarketState:
    spot: float
    high: float | None = None
    low: float | None = None
    vwap: float | None = None
    rvol: float | None = None
    realized_vol: float | None = None
    minutes_from_open: float = 0.0
    minutes_to_close_total: float = 390.0


@dataclass
class PDEConfig:
    """Stable, intentionally small coefficients for the semi-discrete PDE."""

    distance_diffusion: float = 0.015
    expiry_diffusion: float = 0.010
    distance_drift: float = 0.0
    decay: float = 0.020
    source_strength: float = 0.080
    timestep_minutes: float = 1.0
    default_volatility: float = 0.25
    trading_minutes_per_year: float = 252.0 * 390.0


@dataclass
class ModelConfig:
    elo: EloConfig = field(default_factory=EloConfig)
    pde: PDEConfig = field(default_factory=PDEConfig)
    forecast_horizons_minutes: tuple[float, ...] = (5.0, 15.0, 30.0, 60.0)


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
    diagnostics: dict[str, float]
    expectations: dict[float, Expectation]
    elo_surface: pd.DataFrame
    distance_grid: np.ndarray
    expiry_grid: np.ndarray
    field_grid: np.ndarray

    @property
    def expected_price(self) -> float:
        """Return the longest configured horizon's expected price."""

        horizon = max(self.expectations)
        return self.expectations[horizon].expected_price


def _numeric_column(frame: pd.DataFrame, name: str, default: float = 0.0) -> np.ndarray:
    if name not in frame:
        return np.full(len(frame), default, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce").fillna(default).to_numpy(float)


def _weighted_mean(values: np.ndarray, weights: np.ndarray) -> float:
    denominator = float(np.sum(np.maximum(weights, EPS)))
    return float(np.sum(values * np.maximum(weights, EPS)) / denominator)


def _surface_grid(surface: pd.DataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Pack a pair table into a compact expiry x distance tensor."""

    distances = np.sort(surface["distance_pct"].unique().astype(float))
    expiries = np.sort(surface["expiry_days"].unique().astype(float))
    field = np.zeros((len(expiries), len(distances)), dtype=float)
    weights = np.zeros_like(field)
    expiry_index = np.searchsorted(expiries, surface["expiry_days"].to_numpy(float))
    distance_index = np.searchsorted(distances, surface["distance_pct"].to_numpy(float))
    field[expiry_index, distance_index] = surface["pair_signal"].to_numpy(float)
    weights[expiry_index, distance_index] = surface["pair_weight"].to_numpy(float)
    return distances, expiries, field, weights


def _gradient_and_laplacian(field: np.ndarray, coordinates: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
    if len(coordinates) < 2:
        zeros = np.zeros_like(field)
        return zeros, zeros
    gradient = np.gradient(field, coordinates, axis=axis, edge_order=1)
    laplacian = np.gradient(gradient, coordinates, axis=axis, edge_order=1)
    return gradient, laplacian


def _advance_pde(
    field: np.ndarray,
    observed: np.ndarray,
    distances: np.ndarray,
    expiries: np.ndarray,
    cfg: PDEConfig,
    dt_minutes: float,
) -> np.ndarray:
    """One explicit, vectorized PDE step with source, diffusion, and decay."""

    grad_d, lap_d = _gradient_and_laplacian(field, distances, axis=1)
    _, lap_tau = _gradient_and_laplacian(field, expiries, axis=0)
    derivative = (
        -cfg.distance_drift * grad_d
        + cfg.distance_diffusion * lap_d
        + cfg.expiry_diffusion * lap_tau
        - cfg.decay * field
        + cfg.source_strength * (observed - field)
    )
    return np.clip(field + dt_minutes * derivative, -1.0, 1.0)


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + erf(value / sqrt(2.0)))


class OptionWaveV09:
    """Fast online implementation of the Option Wave v0.9 model."""

    def __init__(self, config: ModelConfig | None = None) -> None:
        self.config = config or ModelConfig()
        self._ratings: dict[tuple[str, float, float], float] = {}

    def reset(self) -> None:
        """Clear online ELO memory while keeping numerical configuration."""

        self._ratings.clear()

    def predict(
        self,
        chain: pd.DataFrame,
        state: MarketState,
        *,
        horizons_minutes: tuple[float, ...] | None = None,
    ) -> ModelResult:
        """Update the ELO surface and return integrated expectations.

        ``chain`` is expected in the wide format used by ``build_elo_surface``:
        one row per strike/expiry, with ``call_*`` and ``put_*`` quote fields.
        """

        if state.spot <= 0:
            raise ValueError("state.spot must be positive")
        surface = build_elo_surface(chain, state.spot, self.config.elo, self._ratings)

        # Variance makes the current quote useful without allowing noisy pairs
        # to dominate the online ELO state.
        price_signal = 2.0 * surface["effective_score"].to_numpy(float) - 1.0
        elo_signal = surface["elo_signal"].to_numpy(float)
        confidence = surface["confidence"].to_numpy(float)
        surface["pair_signal"] = confidence * elo_signal + (1.0 - confidence) * price_signal

        distances, expiries, observed, grid_weights = _surface_grid(surface)
        current_signal = _weighted_mean(observed.ravel(), grid_weights.ravel())
        premium_signal = premium_sentiment_elo(surface)

        call_notional = surface["call_price"].to_numpy(float) * surface["call_volume"].to_numpy(float)
        put_notional = surface["put_price"].to_numpy(float) * surface["put_volume"].to_numpy(float)
        energy_signal = float((call_notional.sum() - put_notional.sum()) / (call_notional.sum() + put_notional.sum() + EPS))
        mean_variance = _weighted_mean(surface["pair_variance"].to_numpy(float), surface["pair_weight"].to_numpy(float))
        mean_confidence = _weighted_mean(confidence, surface["pair_weight"].to_numpy(float))
        median_distance = float(np.median(distances))
        up_cost = float(asymmetric_cost(median_distance, "up", self.config.elo))
        down_cost = float(asymmetric_cost(median_distance, "down", self.config.elo))

        horizons = tuple(sorted(set(horizons_minutes or self.config.forecast_horizons_minutes)))
        if not horizons or horizons[0] <= 0:
            raise ValueError("horizons_minutes must contain positive values")
        max_horizon = max(horizons)
        dt = max(float(self.config.pde.timestep_minutes), 1e-3)
        if HAS_CPP_CORE:
            evolution = cpp_core.evolve_field(
                np.ascontiguousarray(observed.ravel()),
                np.ascontiguousarray(grid_weights.ravel()),
                np.ascontiguousarray(distances),
                np.ascontiguousarray(expiries),
                float(self.config.pde.distance_diffusion),
                float(self.config.pde.expiry_diffusion),
                float(self.config.pde.distance_drift),
                float(self.config.pde.decay),
                float(self.config.pde.source_strength),
                float(dt),
                list(horizons),
            )
            fields = np.asarray(evolution["field"], dtype=float).reshape(observed.shape)
            integrated_values = np.asarray(evolution["integrals"], dtype=float)
            average_values = np.asarray(evolution["averages"], dtype=float)
        else:
            steps = int(np.ceil(max_horizon / dt))
            times = np.arange(steps + 1, dtype=float) * dt
            fields = observed.copy()
            scores = np.empty(steps + 1, dtype=float)
            scores[0] = current_signal
            for step in range(1, steps + 1):
                fields = _advance_pde(fields, observed, distances, expiries, self.config.pde, dt)
                scores[step] = _weighted_mean(fields.ravel(), grid_weights.ravel())
            integrated_values = []
            average_values = []
            trapezoid = getattr(np, "trapezoid", np.trapz)
            for horizon in horizons:
                index = min(int(np.ceil(horizon / dt)), steps)
                local_times = times[: index + 1]
                local_scores = scores[: index + 1]
                integrated = float(trapezoid(local_scores, local_times))
                integrated_values.append(integrated)
                average_values.append(integrated / max(float(local_times[-1]), EPS))
            integrated_values = np.asarray(integrated_values, dtype=float)
            average_values = np.asarray(average_values, dtype=float)

        volatility = self._volatility(chain, state)
        expectations: dict[float, Expectation] = {}
        for horizon, integrated, average in zip(horizons, integrated_values, average_values):
            integrated = float(integrated)
            average = float(average)
            # The same signal magnitude produces a larger downside move than
            # upside move because the latter is modeled as harder to achieve.
            asymmetry = self.config.elo.up_difficulty - self.config.elo.down_difficulty
            direction_scale = 1.0 - asymmetry * 0.25 if average >= 0 else 1.0 + asymmetry * 0.25
            year_fraction = float(horizon) / self.config.pde.trading_minutes_per_year
            expected_log_return = average * volatility * sqrt(max(year_fraction, 0.0)) * direction_scale
            return_variance = volatility * volatility * max(year_fraction, 0.0) * (1.0 + mean_variance)
            expected_price = state.spot * exp(expected_log_return)
            price_variance = expected_price * expected_price * np.expm1(return_variance)
            z = expected_log_return / max(sqrt(return_variance), EPS)
            expectations[float(horizon)] = Expectation(
                horizon_minutes=float(horizon),
                integrated_signal=integrated,
                average_signal=average,
                expected_return=float(np.expm1(expected_log_return)),
                expected_price=float(expected_price),
                return_variance=float(return_variance),
                price_variance=float(max(price_variance, 0.0)),
                probability_up=float(_normal_cdf(z)),
            )

        longest = expectations[max(expectations)]
        trend_score = float(np.tanh(longest.average_signal))
        confidence_score = float(np.clip(0.5 * mean_confidence + 0.5 * abs(trend_score), 0.0, 1.0))
        diagnostics = {
            "premium_elo": float(premium_signal),
            "current_field_signal": float(current_signal),
            "energy_signal": energy_signal,
            "mean_pair_variance": float(mean_variance),
            "mean_pair_confidence": float(mean_confidence),
            "upward_cost_at_median_distance": up_cost,
            "downward_cost_at_median_distance": down_cost,
            "integrated_signal": float(longest.integrated_signal),
            "expected_return": float(longest.expected_return),
            "probability_up": float(longest.probability_up),
        }
        return ModelResult(
            trend_score=trend_score,
            direction=self._direction(trend_score),
            confidence=confidence_score,
            diagnostics=diagnostics,
            expectations=expectations,
            elo_surface=surface,
            distance_grid=distances,
            expiry_grid=expiries,
            field_grid=fields,
        )

    def _volatility(self, chain: pd.DataFrame, state: MarketState) -> float:
        if state.realized_vol is not None and state.realized_vol > 0:
            return float(state.realized_vol)
        iv_values = []
        for column in ("call_iv", "put_iv", "iv"):
            if column in chain:
                values = _numeric_column(chain, column, np.nan)
                iv_values.extend(values[np.isfinite(values) & (values > 0)].tolist())
        if iv_values:
            return float(np.median(iv_values))
        return float(self.config.pde.default_volatility)

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
