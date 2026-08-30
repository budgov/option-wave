"""Financial-engineering factor layer for Ocean Wave.

The Python boundary only normalizes tabular inputs.  Chain aggregation,
short-pressure nonlinearity, and covariance-aware matrix weighting are routed
to the C++ extension whenever it is present.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from ._backend import HAS_CPP_CORE, cpp_core

EPS = 1e-12

FACTOR_NAMES: tuple[str, ...] = (
    "premium_elo",
    "institutional_flow",
    "dealer_hedge",
    "iv_surface",
    "short_pressure",
    "oi_positioning",
    "stock_confirmation",
    "inverse_confirmation",
    "liquidity_energy",
)

# These are structural priors, not permanent output weights.  The online
# covariance matrix and each observation's confidence reallocate them.
DEFAULT_FACTOR_PRIORS: tuple[float, ...] = (
    0.22,
    0.16,
    0.14,
    0.12,
    0.10,
    0.09,
    0.08,
    0.05,
    0.04,
)


@dataclass(frozen=True)
class ShortData:
    """Normalized short-market observation.

    Ratios and fees use decimal units: 18% is ``0.18``.  Missing fields should
    remain ``None``; they are not imputed or guessed.
    """

    short_interest_ratio: float | None = None
    short_interest_change: float | None = None
    short_volume_ratio: float | None = None
    borrow_fee: float | None = None
    utilization: float | None = None
    days_to_cover: float | None = None
    confidence: float = 1.0
    as_of: pd.Timestamp | str | None = None


@dataclass
class FactorConfig:
    names: tuple[str, ...] = FACTOR_NAMES
    priors: tuple[float, ...] = DEFAULT_FACTOR_PRIORS
    ewma_alpha: float = 0.08
    covariance_ridge: float = 0.05
    initial_variance: float = 0.25
    minimum_confidence: float = 0.02

    def __post_init__(self) -> None:
        if len(self.names) != len(self.priors) or not self.names:
            raise ValueError("factor names and priors must have equal non-zero length")
        if len(set(self.names)) != len(self.names):
            raise ValueError("factor names must be unique")
        priors = np.asarray(self.priors, dtype=float)
        if np.any(~np.isfinite(priors)) or np.any(priors < 0.0) or priors.sum() <= 0.0:
            raise ValueError("factor priors must be finite, non-negative, and non-zero")
        self.priors = tuple((priors / priors.sum()).tolist())


@dataclass
class FactorState:
    mean: np.ndarray
    covariance: np.ndarray
    count: float = 0.0

    @classmethod
    def create(cls, config: FactorConfig) -> "FactorState":
        dimension = len(config.names)
        return cls(
            mean=np.zeros(dimension, dtype=float),
            covariance=np.eye(dimension, dtype=float) * float(config.initial_variance),
            count=0.0,
        )


@dataclass(frozen=True)
class ChainFactorSummary:
    energy_signal: float = 0.0
    energy_confidence: float = 0.0
    call_energy: float = 0.0
    put_energy: float = 0.0
    oi_signal: float = 0.0
    oi_confidence: float = 0.0
    iv_surface_signal: float = 0.0
    iv_confidence: float = 0.0
    iv_skew: float = 0.0
    iv_level: float = 0.0
    iv_term_slope: float = 0.0
    iv_curvature: float = 0.0
    iv_moneyness_slope: float = 0.0
    iv_time_slope: float = 0.0
    volatility_risk_premium: float = 0.0
    gex_balance: float = 0.0
    gex_net: float = 0.0
    gex_gross: float = 0.0
    gex_confidence: float = 0.0
    liquidity_quality: float = 0.0
    iv_coverage: float = 0.0
    gamma_coverage: float = 0.0
    delta_coverage: float = 0.0
    vega_coverage: float = 0.0


@dataclass(frozen=True)
class ShortFactor:
    signal: float
    confidence: float
    pressure: float
    squeeze: float


@dataclass(frozen=True)
class FactorBlend:
    signal: float
    confidence: float
    projected_variance: float
    weights: np.ndarray
    table: pd.DataFrame


def _numeric(frame: pd.DataFrame, name: str, default: float = np.nan) -> np.ndarray:
    if name not in frame:
        return np.full(len(frame), default, dtype=float)
    return pd.to_numeric(frame[name], errors="coerce").to_numpy(float)


def _expiry(frame: pd.DataFrame) -> np.ndarray:
    for name in ("expiry_days", "dte", "tau_days", "tau"):
        if name in frame:
            return np.maximum(np.nan_to_num(_numeric(frame, name), nan=0.0), 0.0)
    return np.zeros(len(frame), dtype=float)


def _mid(frame: pd.DataFrame, side: str) -> np.ndarray:
    bid = _numeric(frame, f"{side}_bid")
    ask = _numeric(frame, f"{side}_ask")
    explicit = _numeric(frame, f"{side}_mid")
    last = _numeric(frame, f"{side}_last")
    valid = np.isfinite(bid) & np.isfinite(ask) & (ask >= bid) & (ask > 0.0)
    result = np.where(valid, 0.5 * (bid + ask), explicit)
    result = np.where(np.isfinite(result) & (result > 0.0), result, last)
    return np.maximum(np.nan_to_num(result, nan=0.0), 0.0)


def _oi_change(chain: pd.DataFrame, previous_chain: pd.DataFrame | None, side: str) -> np.ndarray:
    explicit = _numeric(chain, f"{side}_oi_change")
    if np.isfinite(explicit).any() or previous_chain is None or previous_chain.empty:
        return explicit
    required = {"strike", f"{side}_oi"}
    if not required.issubset(previous_chain.columns) or "strike" not in chain:
        return explicit

    # DTE is not a contract identity: it decreases every calendar day and made
    # an unchanged contract look new at the next session. Match provider/OCC
    # symbols first, then the stable expiry-date + strike + side tuple. The
    # second pass also migrates checkpoints written before symbols were kept.
    prior = np.full(len(chain), np.nan, dtype=float)
    previous_oi = _numeric(previous_chain, f"{side}_oi")
    current_symbol_column = f"{side}_symbol" if f"{side}_symbol" in chain else "contract_symbol"
    previous_symbol_column = (
        f"{side}_symbol" if f"{side}_symbol" in previous_chain else "contract_symbol"
    )
    if current_symbol_column in chain and previous_symbol_column in previous_chain:
        previous_symbols = previous_chain[previous_symbol_column].astype("string").str.strip().str.upper()
        current_symbols = chain[current_symbol_column].astype("string").str.strip().str.upper()
        valid_previous = previous_symbols.notna() & previous_symbols.ne("") & np.isfinite(previous_oi)
        if valid_previous.any():
            symbol_lookup = pd.Series(
                previous_oi[valid_previous.to_numpy()],
                index=previous_symbols[valid_previous],
            ).groupby(level=0, sort=False).last()
            valid_current = current_symbols.notna() & current_symbols.ne("")
            if valid_current.any():
                positions = np.flatnonzero(valid_current.to_numpy())
                prior[positions] = symbol_lookup.reindex(current_symbols.iloc[positions]).to_numpy(float)

    unmatched = ~np.isfinite(prior)
    if np.any(unmatched) and "expiry_date" in chain and "expiry_date" in previous_chain:
        previous_strike = _numeric(previous_chain, "strike")
        current_strike = _numeric(chain, "strike")
        previous_expiry = pd.to_datetime(previous_chain["expiry_date"], errors="coerce").dt.strftime("%Y-%m-%d")
        current_expiry = pd.to_datetime(chain["expiry_date"], errors="coerce").dt.strftime("%Y-%m-%d")
        previous_keys = pd.MultiIndex.from_arrays([
            previous_expiry,
            previous_strike,
            np.full(len(previous_chain), side, dtype=object),
        ])
        valid_previous = previous_expiry.notna().to_numpy() & np.isfinite(previous_strike) & np.isfinite(previous_oi)
        if np.any(valid_previous):
            fallback_lookup = pd.Series(
                previous_oi[valid_previous],
                index=previous_keys[valid_previous],
            ).groupby(level=[0, 1, 2], sort=False).last()
            current_keys = pd.MultiIndex.from_arrays([
                current_expiry,
                current_strike,
                np.full(len(chain), side, dtype=object),
            ])
            positions = np.flatnonzero(
                unmatched & current_expiry.notna().to_numpy() & np.isfinite(current_strike)
            )
            if positions.size:
                prior[positions] = fallback_lookup.reindex(current_keys[positions]).to_numpy(float)

    current = _numeric(chain, f"{side}_oi")
    return current - prior


def _chain_arrays(chain: pd.DataFrame, previous_chain: pd.DataFrame | None) -> list[np.ndarray]:
    return [
        np.ascontiguousarray(_numeric(chain, "strike")),
        np.ascontiguousarray(_expiry(chain)),
        np.ascontiguousarray(_mid(chain, "call")),
        np.ascontiguousarray(_mid(chain, "put")),
        np.ascontiguousarray(_numeric(chain, "call_bid")),
        np.ascontiguousarray(_numeric(chain, "call_ask")),
        np.ascontiguousarray(_numeric(chain, "put_bid")),
        np.ascontiguousarray(_numeric(chain, "put_ask")),
        np.ascontiguousarray(np.maximum(np.nan_to_num(_numeric(chain, "call_volume"), nan=0.0), 0.0)),
        np.ascontiguousarray(np.maximum(np.nan_to_num(_numeric(chain, "put_volume"), nan=0.0), 0.0)),
        np.ascontiguousarray(np.maximum(np.nan_to_num(_numeric(chain, "call_oi"), nan=0.0), 0.0)),
        np.ascontiguousarray(np.maximum(np.nan_to_num(_numeric(chain, "put_oi"), nan=0.0), 0.0)),
        np.ascontiguousarray(_oi_change(chain, previous_chain, "call")),
        np.ascontiguousarray(_oi_change(chain, previous_chain, "put")),
        np.ascontiguousarray(_numeric(chain, "call_iv")),
        np.ascontiguousarray(_numeric(chain, "put_iv")),
        np.ascontiguousarray(_numeric(chain, "call_delta")),
        np.ascontiguousarray(_numeric(chain, "put_delta")),
        np.ascontiguousarray(_numeric(chain, "call_gamma")),
        np.ascontiguousarray(_numeric(chain, "put_gamma")),
        np.ascontiguousarray(_numeric(chain, "call_vega")),
        np.ascontiguousarray(_numeric(chain, "put_vega")),
    ]


def _extract_chain_python(chain: pd.DataFrame, spot: float, realized_vol: float, previous_chain: pd.DataFrame | None) -> Mapping[str, float]:
    arrays = _chain_arrays(chain, previous_chain)
    (
        strike, expiry, call_price, put_price, call_bid, call_ask, put_bid, put_ask,
        call_volume, put_volume, call_oi, put_oi, call_oi_change, put_oi_change,
        call_iv, put_iv, call_delta, put_delta, call_gamma, put_gamma, _call_vega, _put_vega,
    ) = arrays
    log_moneyness = np.log(np.maximum(strike, EPS) / spot)
    base_weight = np.exp(-np.abs(log_moneyness) / 0.08) * np.exp(-expiry / 45.0)
    call_delta_abs = np.where(np.isfinite(call_delta), np.abs(call_delta), 0.5)
    put_delta_abs = np.where(np.isfinite(put_delta), np.abs(put_delta), 0.5)
    call_energy = float(np.sum(call_price * call_volume * 100.0 * call_delta_abs * base_weight))
    put_energy = float(np.sum(put_price * put_volume * 100.0 * put_delta_abs * base_weight))
    energy_signal = float(np.tanh((call_energy - put_energy) / max(call_energy + put_energy, EPS)))
    valid_call_quote = np.isfinite(call_bid) & np.isfinite(call_ask) & (call_ask >= call_bid) & (call_ask > 0.0)
    valid_put_quote = np.isfinite(put_bid) & np.isfinite(put_ask) & (put_ask >= put_bid) & (put_ask > 0.0)
    call_quality = np.where(valid_call_quote, np.exp(-4.0 * np.maximum(call_ask - call_bid, 0.0) / np.maximum(call_price, EPS)), 0.0)
    put_quality = np.where(valid_put_quote, np.exp(-4.0 * np.maximum(put_ask - put_bid, 0.0) / np.maximum(put_price, EPS)), 0.0)
    activity = 1.0 + np.log1p(call_volume + put_volume)
    liquidity = float(np.average(0.5 * (call_quality + put_quality), weights=activity)) if len(activity) else 0.0
    change_observed = np.isfinite(call_oi_change).any() or np.isfinite(put_oi_change).any()
    if change_observed:
        call_change = np.nan_to_num(call_oi_change) * call_delta_abs * base_weight
        put_change = np.nan_to_num(put_oi_change) * put_delta_abs * base_weight
        oi_change_gross = float(np.abs(call_change).sum() + np.abs(put_change).sum())
        directional_oi_change = oi_change_gross > EPS
        oi_signal = (
            float(np.tanh((call_change.sum() - put_change.sum()) / oi_change_gross))
            if directional_oi_change else 0.0
        )
    else:
        # Static OI is useful context, but without a source update it is not a
        # timestamped directional observation. Keep it out of online weights.
        directional_oi_change = False
        oi_signal = 0.0
    call_otm = (strike >= spot) & np.isfinite(call_iv) & (call_iv > 0.0)
    put_otm = (strike <= spot) & np.isfinite(put_iv) & (put_iv > 0.0)
    iv_weight = base_weight * activity
    call_otm_iv = float(np.average(call_iv[call_otm], weights=iv_weight[call_otm])) if np.any(call_otm) else 0.0
    put_otm_iv = float(np.average(put_iv[put_otm], weights=iv_weight[put_otm])) if np.any(put_otm) else 0.0
    has_two_sided_iv = np.any(call_otm) and np.any(put_otm)
    iv_skew = put_otm_iv - call_otm_iv if has_two_sided_iv else 0.0
    iv_signal = float(np.tanh(-iv_skew / 0.05)) if has_two_sided_iv else 0.0
    mid_iv = np.nanmean(np.stack((call_iv, put_iv)), axis=0)
    valid_iv = np.isfinite(mid_iv) & (mid_iv > 0.0)
    coefficients = np.zeros(4, dtype=float)
    if np.count_nonzero(valid_iv) >= 4:
        design = np.column_stack((
            np.ones(np.count_nonzero(valid_iv)),
            log_moneyness[valid_iv],
            log_moneyness[valid_iv] ** 2,
            np.sqrt((expiry[valid_iv] + 1.0) / 365.0),
        ))
        root_weight = np.sqrt(iv_weight[valid_iv])
        coefficients = np.linalg.lstsq(design * root_weight[:, None], mid_iv[valid_iv] * root_weight, rcond=None)[0]
    atm_weight = np.exp(-np.abs(log_moneyness) / 0.025) * np.exp(-expiry / 45.0) * activity
    atm_valid = valid_iv & (atm_weight > 0.0)
    atm_iv = float(np.average(mid_iv[atm_valid], weights=atm_weight[atm_valid])) if np.any(atm_valid) else 0.0
    near = valid_iv & (expiry <= 7.0)
    far = valid_iv & (expiry > 7.0)
    near_iv = float(np.average(mid_iv[near], weights=iv_weight[near])) if np.any(near) else 0.0
    far_iv = float(np.average(mid_iv[far], weights=iv_weight[far])) if np.any(far) else 0.0
    call_gex = call_oi * np.nan_to_num(np.abs(call_gamma)) * 100.0 * spot * spot * base_weight
    put_gex = put_oi * np.nan_to_num(np.abs(put_gamma)) * 100.0 * spot * spot * base_weight
    gross_gex = float(call_gex.sum() + put_gex.sum())
    rows = max(len(chain), 1)
    oi_change_coverage = float(np.count_nonzero(
        np.isfinite(call_oi_change) | np.isfinite(put_oi_change)
    ) / rows)
    return {
        "energy_signal": energy_signal,
        "energy_confidence": float(np.clip(0.75 * np.log1p((call_volume + put_volume).sum()) / np.log(10001.0) * (0.35 + 0.65 * liquidity), 0.0, 1.0)),
        "call_energy": call_energy,
        "put_energy": put_energy,
        "oi_signal": oi_signal,
        "oi_confidence": float(np.clip(
            (0.55 + 0.45 * oi_change_coverage) * (0.4 + 0.6 * liquidity)
            if directional_oi_change else 0.0,
            0.0,
            1.0,
        )),
        "iv_surface_signal": iv_signal,
        "iv_confidence": float(np.clip(np.count_nonzero(valid_iv) / rows * (0.4 + 0.6 * liquidity), 0.0, 1.0)),
        "iv_skew": iv_skew,
        "iv_level": atm_iv,
        "iv_term_slope": near_iv - far_iv if np.any(near) and np.any(far) else 0.0,
        "iv_curvature": float(coefficients[2]),
        "iv_moneyness_slope": float(coefficients[1]),
        "iv_time_slope": float(coefficients[3]),
        "volatility_risk_premium": atm_iv - realized_vol if realized_vol > 0.0 and atm_iv > 0.0 else 0.0,
        "gex_balance": float(np.tanh((call_gex.sum() - put_gex.sum()) / max(gross_gex, EPS))),
        "gex_net": float(call_gex.sum() - put_gex.sum()),
        "gex_gross": gross_gex,
        "gex_confidence": float(np.clip(0.6 * np.count_nonzero(np.isfinite(call_gamma) | np.isfinite(put_gamma)) / rows, 0.0, 0.6)),
        "liquidity_quality": liquidity,
        "iv_coverage": float(np.count_nonzero(valid_iv) / rows),
        "gamma_coverage": float(np.count_nonzero(np.isfinite(call_gamma) | np.isfinite(put_gamma)) / rows),
        "delta_coverage": float(np.count_nonzero(np.isfinite(call_delta) | np.isfinite(put_delta)) / rows),
        "vega_coverage": 0.0,
    }


def extract_chain_factors(
    chain: pd.DataFrame,
    spot: float,
    *,
    realized_vol: float | None = None,
    previous_chain: pd.DataFrame | None = None,
) -> ChainFactorSummary:
    """Extract option-energy, IV-surface, OI, GEX, and liquidity statistics."""

    if chain.empty or "strike" not in chain:
        raise ValueError("chain must contain strike rows")
    if spot <= 0.0:
        raise ValueError("spot must be positive")
    rv = float(realized_vol) if realized_vol is not None and realized_vol > 0.0 else np.nan
    if HAS_CPP_CORE and hasattr(cpp_core, "extract_chain_factors"):
        result = cpp_core.extract_chain_factors(*_chain_arrays(chain, previous_chain), float(spot), rv)
        values = {name: float(result[name]) for name in result}
    else:
        values = dict(_extract_chain_python(chain, float(spot), rv, previous_chain))
    fields = ChainFactorSummary.__dataclass_fields__
    return ChainFactorSummary(**{name: float(values.get(name, 0.0)) for name in fields})


def stock_confirmation(state: Any) -> tuple[float, float]:
    """Continuous stock-price confirmation from momentum, VWAP, and RVOL."""

    if HAS_CPP_CORE and hasattr(cpp_core, "compute_stock_confirmation"):
        def number(name: str) -> float:
            value = getattr(state, name, None)
            return float(value) if value is not None else np.nan

        result = cpp_core.compute_stock_confirmation(
            number("spot"),
            number("previous_close"),
            number("vwap"),
            number("return_5m"),
            number("return_15m"),
            number("rvol"),
            number("realized_vol"),
            number("data_confidence"),
        )
        return float(result["signal"]), float(result["confidence"])

    components: list[float] = []
    weights: list[float] = []
    spot = float(getattr(state, "spot", 0.0))
    realized_vol = float(getattr(state, "realized_vol", 0.0) or 0.0)
    previous_close = getattr(state, "previous_close", None)
    if previous_close is not None and previous_close > 0.0 and spot > 0.0:
        daily_scale = max(realized_vol / np.sqrt(252.0), 0.005)
        components.append(float(np.log(spot / previous_close) / daily_scale))
        weights.append(0.25)
    vwap = getattr(state, "vwap", None)
    if vwap is not None and vwap > 0.0:
        components.append(float((spot - vwap) / vwap / 0.003))
        weights.append(0.25)
    return_5m = getattr(state, "return_5m", None)
    if return_5m is not None and np.isfinite(return_5m):
        components.append(float(return_5m) / 0.003)
        weights.append(0.25)
    return_15m = getattr(state, "return_15m", None)
    if return_15m is not None and np.isfinite(return_15m):
        components.append(float(return_15m) / 0.006)
        weights.append(0.15)
    rvol = getattr(state, "rvol", None)
    if rvol is not None and rvol > 0.0:
        components.append(float(np.log(max(rvol, EPS))))
        weights.append(0.10)
    if not weights:
        return 0.0, 0.0
    weight_array = np.asarray(weights, dtype=float)
    raw = float(np.dot(weight_array, np.asarray(components, dtype=float)) / weight_array.sum())
    data_confidence = float(np.clip(getattr(state, "data_confidence", 1.0), 0.0, 1.0))
    return float(np.tanh(raw)), float(np.clip(len(weights) / 5.0 * data_confidence, 0.0, 1.0))


def short_pressure(short_data: ShortData | None, stock_signal: float) -> ShortFactor:
    """Map observable short pressure and squeeze interaction to one signal."""

    if short_data is None:
        return ShortFactor(0.0, 0.0, 0.0, 0.0)
    values = [
        short_data.short_interest_ratio,
        short_data.short_interest_change,
        short_data.short_volume_ratio,
        short_data.borrow_fee,
        short_data.utilization,
        short_data.days_to_cover,
    ]
    numbers = [np.nan if value is None else float(value) for value in values]
    if HAS_CPP_CORE and hasattr(cpp_core, "compute_short_factor"):
        result = cpp_core.compute_short_factor(*numbers, float(stock_signal), float(short_data.confidence))
        return ShortFactor(float(result["signal"]), float(result["confidence"]), float(result["pressure"]), float(result["squeeze"]))
    importance = np.asarray((0.15, 0.25, 0.20, 0.15, 0.15, 0.10), dtype=float)
    features = np.asarray((
        np.tanh((numbers[0] - 0.10) / 0.15),
        np.tanh(numbers[1] / 0.10),
        np.tanh((numbers[2] - 0.50) / 0.20),
        np.tanh(np.log1p(max(numbers[3], 0.0)) / 0.10),
        np.tanh((numbers[4] - 0.50) / 0.25),
        np.tanh((numbers[5] - 2.0) / 3.0),
    ))
    valid = np.isfinite(features)
    if not np.any(valid):
        return ShortFactor(0.0, 0.0, 0.0, 0.0)
    pressure = float(np.dot(importance[valid], features[valid]) / importance[valid].sum())
    squeeze = 1.60 * max(pressure, 0.0) * max(stock_signal, 0.0)
    return ShortFactor(
        float(np.clip(-pressure + squeeze, -1.0, 1.0)),
        float(np.clip(short_data.confidence, 0.0, 1.0) * np.count_nonzero(valid) / 6.0),
        pressure,
        squeeze,
    )


def adaptive_blend(
    values: Sequence[float],
    confidences: Sequence[float],
    state: FactorState,
    config: FactorConfig,
) -> FactorBlend:
    """Update EWMA covariance and compute non-negative ridge-GLS weights."""

    factors = np.clip(np.asarray(values, dtype=float), -1.0, 1.0)
    quality = np.clip(np.asarray(confidences, dtype=float), 0.0, 1.0)
    if factors.shape != (len(config.names),) or quality.shape != factors.shape:
        raise ValueError("factor vector does not match FactorConfig")
    quality = np.where(quality >= config.minimum_confidence, quality, 0.0)
    priors = np.asarray(config.priors, dtype=float)
    if HAS_CPP_CORE and hasattr(cpp_core, "blend_factors"):
        result = cpp_core.blend_factors(
            np.ascontiguousarray(factors),
            np.ascontiguousarray(quality),
            np.ascontiguousarray(priors),
            np.ascontiguousarray(state.mean),
            np.ascontiguousarray(state.covariance.ravel()),
            float(state.count),
            float(config.ewma_alpha),
            float(config.covariance_ridge),
        )
        state.mean = np.asarray(result["mean"], dtype=float)
        state.covariance = np.asarray(result["covariance"], dtype=float).reshape(factors.size, factors.size)
        state.count = float(result["count"])
        weights = np.asarray(result["weights"], dtype=float)
        signal = float(result["signal"])
        confidence = float(result["confidence"])
        projected_variance = float(result["projected_variance"])
    else:
        if state.count <= 0.0:
            state.mean = np.where(quality > 0.0, factors, state.mean)
        else:
            old_mean = state.mean.copy()
            state.mean = np.where(quality > 0.0, (1.0 - config.ewma_alpha) * state.mean + config.ewma_alpha * factors, state.mean)
            innovation_old = np.where(quality > 0.0, factors - old_mean, 0.0)
            innovation_new = np.where(quality > 0.0, factors - state.mean, 0.0)
            state.covariance = (1.0 - config.ewma_alpha) * state.covariance + config.ewma_alpha * np.outer(innovation_old, innovation_new)
        state.count += 1.0
        rhs = priors * quality
        try:
            raw_weights = np.linalg.solve(state.covariance + config.covariance_ridge * np.eye(factors.size), rhs)
        except np.linalg.LinAlgError:
            raw_weights = rhs
        raw_weights = np.maximum(np.nan_to_num(raw_weights), 0.0)
        weights = raw_weights / raw_weights.sum() if raw_weights.sum() > EPS else np.full(factors.size, 1.0 / factors.size)
        signal = float(np.clip(np.dot(weights, factors), -1.0, 1.0))
        confidence = float(np.clip(np.dot(weights, quality), 0.0, 1.0))
        projected_variance = float(max(weights @ state.covariance @ weights, 0.0))
    table = pd.DataFrame({
        "factor": config.names,
        "signal": factors,
        "confidence": quality,
        "prior_weight": priors,
        "dynamic_weight": weights,
        "contribution": weights * factors,
    }).sort_values("dynamic_weight", ascending=False, ignore_index=True)
    return FactorBlend(signal, confidence, projected_variance, weights, table)
