"""Ocean Wave: C++ accelerated option-surface forecasting.

The model combines a symmetric premium-ELO surface with verified institutional
flow, dealer hedging, IV geometry, short pressure, OI changes, stock
confirmation, inverse instruments, and liquidity-adjusted energy.  Factor
priors are reweighted online by an EWMA covariance matrix before a continuous
PDE is integrated over each forecast horizon.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from math import erf, exp, sqrt
from typing import Sequence

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core
from .elo import EPS, EloConfig, build_elo_surface, energy_cost
from .factors import (
    ChainFactorSummary,
    FactorBlend,
    FactorConfig,
    FactorState,
    ShortData,
    adaptive_blend,
    extract_chain_factors,
    short_pressure,
    stock_confirmation,
)
from .flow import FlowConfig, FlowSummary, aggregate_large_flow
from .inverse import InverseMarketData


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
    symbol: str | None = None
    previous_close: float | None = None
    return_5m: float | None = None
    return_15m: float | None = None
    stock_volume: float | None = None
    stock_dollar_volume: float | None = None
    data_confidence: float = 1.0


@dataclass
class PDEConfig:
    """Coefficients for the semi-discrete advection-diffusion-reaction PDE."""

    distance_diffusion: float = 0.015
    expiry_diffusion: float = 0.010
    distance_drift: float = 0.0
    decay: float = 0.020
    source_strength: float = 0.080
    timestep_minutes: float = 1.0
    default_volatility: float = 0.25
    trading_minutes_per_year: float = 252.0 * 390.0
    negative_gamma_amplifier: float = 0.35
    positive_gamma_dampener: float = 0.20
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
    flow: FlowConfig = field(default_factory=FlowConfig)
    inverse: InverseConfig = field(default_factory=InverseConfig)
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
    diagnostics: dict[str, object]
    factor_table: pd.DataFrame
    factor_covariance: np.ndarray
    chain_factors: ChainFactorSummary
    flow_summary: FlowSummary | None
    expectations: dict[float, Expectation]
    elo_surface: pd.DataFrame
    distance_grid: np.ndarray
    expiry_grid: np.ndarray
    field_grid: np.ndarray

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


def _surface_grid(
    expiry_values: np.ndarray,
    distance_values: np.ndarray,
    pair_signal: np.ndarray,
    pair_weight: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    distances = np.unique(distance_values)
    expiries = np.unique(expiry_values)
    field_grid = np.zeros((len(expiries), len(distances)), dtype=float)
    weight_grid = np.zeros_like(field_grid)
    expiry_index = np.searchsorted(expiries, expiry_values)
    distance_index = np.searchsorted(distances, distance_values)
    field_grid[expiry_index, distance_index] = pair_signal
    weight_grid[expiry_index, distance_index] = pair_weight
    return distances, expiries, field_grid, weight_grid


def _gradient_and_laplacian(field_grid: np.ndarray, coordinates: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray]:
    if len(coordinates) < 2:
        zeros = np.zeros_like(field_grid)
        return zeros, zeros
    gradient = np.gradient(field_grid, coordinates, axis=axis, edge_order=1)
    return gradient, np.gradient(gradient, coordinates, axis=axis, edge_order=1)


def _advance_pde(
    field_grid: np.ndarray,
    observed: np.ndarray,
    distances: np.ndarray,
    expiries: np.ndarray,
    config: PDEConfig,
    timestep: float,
) -> np.ndarray:
    gradient_distance, laplacian_distance = _gradient_and_laplacian(field_grid, distances, axis=1)
    _, laplacian_expiry = _gradient_and_laplacian(field_grid, expiries, axis=0)
    derivative = (
        -config.distance_drift * gradient_distance
        + config.distance_diffusion * laplacian_distance
        + config.expiry_diffusion * laplacian_expiry
        - config.decay * field_grid
        + config.source_strength * (observed - field_grid)
    )
    return np.clip(field_grid + timestep * derivative, -1.0, 1.0)


def _normal_cdf(value: float) -> float:
    return 0.5 * (1.0 + erf(value / sqrt(2.0)))


class OceanWave:
    """Online Ocean Wave model with C++ numerical kernels."""

    def __init__(self, config: ModelConfig | None = None) -> None:
        self.config = config or ModelConfig()
        self._ratings: dict[tuple[str, float, float], float] = {}
        self._factor_state = FactorState.create(self.config.factors)

    def reset(self) -> None:
        self._ratings.clear()
        self._factor_state = FactorState.create(self.config.factors)

    def _inverse_observation(
        self,
        inverse_chain: pd.DataFrame | None,
        inverse_state: MarketState | None,
        inverse_beta: float,
    ) -> tuple[float, float, float]:
        if inverse_state is None or inverse_state.spot <= 0.0:
            return 0.0, 0.0, 0.0
        if inverse_chain is not None and not inverse_chain.empty:
            inverse_surface = build_elo_surface(inverse_chain, inverse_state.spot, self.config.elo, {})
            price_signal = 2.0 * inverse_surface["effective_score"].to_numpy(float) - 1.0
            confidence = inverse_surface["confidence"].to_numpy(float)
            pair_signal = confidence * inverse_surface["elo_signal"].to_numpy(float) + (1.0 - confidence) * price_signal
            native = _weighted_mean(pair_signal, inverse_surface["pair_weight"].to_numpy(float))
            quality = _weighted_mean(confidence, inverse_surface["pair_weight"].to_numpy(float))
        elif inverse_state.previous_close is not None and inverse_state.previous_close > 0.0:
            inverse_return = np.log(inverse_state.spot / inverse_state.previous_close)
            scale = max(inverse_state.realized_vol or self.config.pde.default_volatility, 1e-6)
            native = float(np.tanh(inverse_return / scale))
            quality = 0.5
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
        negative_gamma = max(-chain_summary.gex_balance, 0.0)
        positive_gamma = max(chain_summary.gex_balance, 0.0)
        gamma_multiplier = max(
            0.50,
            1.0 + base.negative_gamma_amplifier * negative_gamma - base.positive_gamma_dampener * positive_gamma,
        )
        illiquidity = 1.0 - float(np.clip(chain_summary.liquidity_quality, 0.0, 1.0))
        vrp_stress = min(abs(chain_summary.volatility_risk_premium), 0.50)
        return replace(
            base,
            distance_diffusion=base.distance_diffusion * (1.0 + base.liquidity_diffusion_penalty * illiquidity + vrp_stress),
            expiry_diffusion=base.expiry_diffusion * (1.0 + 0.50 * vrp_stress),
            decay=base.decay * (1.0 + 0.25 * positive_gamma - 0.20 * negative_gamma),
            source_strength=base.source_strength * gamma_multiplier,
        ), gamma_multiplier

    def _factor_observations(
        self,
        premium_signal: float,
        mean_pair_confidence: float,
        chain_summary: ChainFactorSummary,
        state: MarketState,
        short_data: ShortData | None,
        flow_summary: FlowSummary | None,
        inverse_target_signal: float,
        inverse_confidence: float,
    ) -> tuple[list[float], list[float], dict[str, float]]:
        liquidity = float(np.clip(chain_summary.liquidity_quality, 0.0, 1.0))
        premium_confidence = mean_pair_confidence * (0.40 + 0.60 * liquidity)

        if flow_summary is not None and flow_summary.gross_notional > 0.0:
            primary_flow = flow_summary.large_signal if flow_summary.large_gross_notional > 0.0 else flow_summary.signal
            flow_signal = float(np.tanh(0.75 * primary_flow + 0.25 * flow_summary.velocity))
            flow_confidence = flow_summary.confidence * (1.0 if flow_summary.large_gross_notional > 0.0 else 0.75)
        else:
            flow_signal = 0.0
            flow_confidence = 0.0

        dealer_values: list[float] = []
        dealer_confidences: list[float] = []
        if flow_summary is not None and flow_summary.greek_coverage > 0.0:
            dealer_values.append(flow_summary.hedge_signal)
            dealer_confidences.append(flow_summary.confidence * flow_summary.greek_coverage)
        if chain_summary.gex_confidence > 0.0:
            structural = chain_summary.energy_signal * (1.0 - 0.50 * chain_summary.gex_balance)
            dealer_values.append(float(np.clip(structural, -1.0, 1.0)))
            dealer_confidences.append(0.50 * chain_summary.gex_confidence * chain_summary.energy_confidence)
        dealer_signal, dealer_confidence = _combine_indicators(dealer_values, dealer_confidences)

        stock_signal, stock_confidence = stock_confirmation(state)
        short_factor = short_pressure(short_data, stock_signal)
        values = [
            premium_signal,
            flow_signal,
            dealer_signal,
            chain_summary.iv_surface_signal,
            short_factor.signal,
            chain_summary.oi_signal,
            stock_signal,
            inverse_target_signal,
            chain_summary.energy_signal,
        ]
        confidences = [
            premium_confidence,
            flow_confidence,
            dealer_confidence,
            chain_summary.iv_confidence,
            short_factor.confidence,
            chain_summary.oi_confidence,
            stock_confidence,
            inverse_confidence if inverse_confidence >= self.config.inverse.minimum_confidence else 0.0,
            chain_summary.energy_confidence,
        ]
        details = {
            "premium_signal": premium_signal,
            "premium_confidence": premium_confidence,
            "flow_signal": flow_signal,
            "flow_confidence": flow_confidence,
            "dealer_signal": dealer_signal,
            "dealer_confidence": dealer_confidence,
            "stock_signal": stock_signal,
            "stock_confidence": stock_confidence,
            "short_signal": short_factor.signal,
            "short_confidence": short_factor.confidence,
            "short_pressure": short_factor.pressure,
            "short_squeeze": short_factor.squeeze,
        }
        return values, confidences, details

    def predict(
        self,
        chain: pd.DataFrame,
        state: MarketState,
        *,
        horizons_minutes: tuple[float, ...] | None = None,
        previous_chain: pd.DataFrame | None = None,
        short_data: ShortData | None = None,
        flow: pd.DataFrame | None = None,
        flow_asof: pd.Timestamp | str | None = None,
        inverse_chain: pd.DataFrame | None = None,
        inverse_state: MarketState | None = None,
        inverse_beta: float | None = None,
        inverse_markets: Sequence[InverseMarketData] | None = None,
    ) -> ModelResult:
        """Calculate the Ocean Wave field and integrated price expectations."""

        if state.spot <= 0.0:
            raise ValueError("state.spot must be positive")
        chain_summary = extract_chain_factors(
            chain,
            state.spot,
            realized_vol=state.realized_vol,
            previous_chain=previous_chain,
        )
        elo_config = self.config.elo
        surface = build_elo_surface(chain, state.spot, elo_config, self._ratings)
        expiry_values = np.ascontiguousarray(surface["expiry_days"].to_numpy(float))
        distance_values = np.ascontiguousarray(surface["distance_pct"].to_numpy(float))
        effective_score = np.ascontiguousarray(surface["effective_score"].to_numpy(float))
        pair_confidence = np.ascontiguousarray(surface["confidence"].to_numpy(float))
        elo_signal = np.ascontiguousarray(surface["elo_signal"].to_numpy(float))
        pair_weight = np.ascontiguousarray(surface["pair_weight"].to_numpy(float))
        pair_variance = np.ascontiguousarray(surface["pair_variance"].to_numpy(float))
        if HAS_CPP_CORE and hasattr(cpp_core, "aggregate_surface_signals"):
            aggregate = cpp_core.aggregate_surface_signals(
                effective_score,
                pair_confidence,
                elo_signal,
                pair_weight,
            )
            pair_signal = np.asarray(aggregate["pair_signal"], dtype=float)
            premium_signal = float(aggregate["premium_signal"])
            mean_pair_confidence = float(aggregate["mean_pair_confidence"])
        else:
            price_signal = 2.0 * effective_score - 1.0
            pair_signal = pair_confidence * elo_signal + (1.0 - pair_confidence) * price_signal
            premium_signal = _weighted_mean(elo_signal, pair_weight)
            mean_pair_confidence = _weighted_mean(pair_confidence, pair_weight)
        pair_signal = np.ascontiguousarray(pair_signal)
        surface["pair_signal"] = pair_signal

        flow_summary = aggregate_large_flow(flow, self.config.flow, asof=flow_asof) if flow is not None else None
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
            short_data,
            flow_summary,
            inverse_target,
            inverse_confidence,
        )
        blend: FactorBlend = adaptive_blend(factor_values, factor_confidences, self._factor_state, self.config.factors)

        horizons = tuple(sorted(set(horizons_minutes or self.config.forecast_horizons_minutes)))
        if not horizons or horizons[0] <= 0.0:
            raise ValueError("horizons_minutes must contain positive values")
        pde_config, gamma_multiplier = self._dynamic_pde_config(chain_summary)
        timestep = max(float(pde_config.timestep_minutes), 1e-3)
        volatility = self._volatility(chain, state, chain_summary)
        expectations: dict[float, Expectation] = {}
        if HAS_CPP_CORE and hasattr(cpp_core, "forecast_surface"):
            forecast = cpp_core.forecast_surface(
                expiry_values,
                distance_values,
                pair_signal,
                pair_weight,
                pair_variance,
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
                expectations[float(horizon)] = Expectation(
                    float(horizon),
                    float(integrated),
                    float(average),
                    float(expected_return),
                    float(expected_price),
                    float(return_variance),
                    float(price_variance),
                    float(probability_up),
                )
            current_field_signal = float(forecast["current_field_signal"])
            trend_score = float(forecast["trend_score"])
            confidence = float(forecast["confidence"])
            median_distance = float(forecast["median_distance"])
        else:
            distances, expiries, observed, grid_weights = _surface_grid(
                expiry_values,
                distance_values,
                pair_signal,
                pair_weight,
            )
            current_field_signal = _weighted_mean(observed.ravel(), grid_weights.ravel())
            distance_basis = np.exp(-np.abs(distances) / 0.08)
            expiry_basis = np.exp(-expiries / 45.0)
            source_basis = expiry_basis[:, None] * distance_basis[None, :]
            basis_mean = _weighted_mean(source_basis.ravel(), grid_weights.ravel())
            source_basis /= max(basis_mean, EPS)
            observed = np.clip(observed + (blend.signal - current_field_signal) * source_basis, -1.0, 1.0)
            steps = int(np.ceil(max(horizons) / timestep))
            field_grid = observed.copy()
            scores = np.empty(steps + 1, dtype=float)
            scores[0] = _weighted_mean(field_grid.ravel(), grid_weights.ravel())
            for step in range(1, steps + 1):
                field_grid = _advance_pde(field_grid, observed, distances, expiries, pde_config, timestep)
                scores[step] = _weighted_mean(field_grid.ravel(), grid_weights.ravel())
            integrated_values = []
            average_values = []
            trapezoid = getattr(np, "trapezoid", np.trapz)
            for horizon in horizons:
                index = min(int(np.ceil(horizon / timestep)), steps)
                elapsed = np.arange(index + 1, dtype=float) * timestep
                integral = float(trapezoid(scores[: index + 1], elapsed))
                integrated_values.append(integral)
                average_values.append(integral / max(float(elapsed[-1]), EPS))
            integrated_values = np.asarray(integrated_values)
            average_values = np.asarray(average_values)
            mean_pair_variance = _weighted_mean(pair_variance, pair_weight)
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
                return_variance = volatility * volatility * max(year_fraction, 0.0) * risk_multiplier
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
                * (0.35 + 0.65 * chain_summary.liquidity_quality)
                * np.exp(-blend.projected_variance),
                0.0,
                1.0,
            ))
            median_distance = float(np.median(distances))

        longest = expectations[max(expectations)]
        diagnostics: dict[str, object] = {
            **factor_details,
            "model_name": "Ocean Wave",
            "cpp_core": HAS_CPP_CORE,
            "composite_signal": blend.signal,
            "composite_confidence": blend.confidence,
            "projected_factor_variance": blend.projected_variance,
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
            "flow_velocity": float(flow_summary.velocity if flow_summary is not None else 0.0),
            "large_flow_notional": float(flow_summary.large_net_notional if flow_summary is not None else 0.0),
            "large_flow_gross_notional": float(flow_summary.large_gross_notional if flow_summary is not None else 0.0),
            "large_flow_count": float(flow_summary.large_trade_count if flow_summary is not None else 0),
            "dealer_hedge_shares": float(flow_summary.delta_hedge_shares if flow_summary is not None else 0.0),
            "inverse_native_signal": inverse_native,
            "inverse_target_signal": inverse_target,
            "inverse_confidence": inverse_confidence,
            "inverse_count": float(len(inverse_symbols)),
            "inverse_symbols": ",".join(inverse_symbols),
            "energy_cost_at_median_distance": float(energy_cost(median_distance, elo_config)),
            "expected_return": longest.expected_return,
            "probability_up": longest.probability_up,
        }
        return ModelResult(
            trend_score=trend_score,
            direction=self._direction(trend_score),
            confidence=confidence,
            diagnostics=diagnostics,
            factor_table=blend.table,
            factor_covariance=self._factor_state.covariance.copy(),
            chain_factors=chain_summary,
            flow_summary=flow_summary,
            expectations=expectations,
            elo_surface=surface,
            distance_grid=distances,
            expiry_grid=expiries,
            field_grid=field_grid,
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
