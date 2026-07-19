from __future__ import annotations

from dataclasses import dataclass
import numpy as np
import pandas as pd

EPS = 1e-9

@dataclass
class MarketState:
    spot: float
    high: float
    low: float
    vwap: float | None = None
    rvol: float | None = None
    stock_dollar_volume: float | None = None
    minutes_from_open: float = 0.0
    minutes_to_close_total: float = 390.0


def normalize(x: float, scale: float = 1.0) -> float:
    return float(np.tanh(x / max(scale, EPS)))


def energy_signal(chain: pd.DataFrame) -> float:
    call_energy = np.sum(chain.get("call_volume", 0) * chain.get("call_mid", chain.get("call_last", 0)) * 100)
    put_energy = np.sum(chain.get("put_volume", 0) * chain.get("put_mid", chain.get("put_last", 0)) * 100)
    return float((call_energy - put_energy) / (call_energy + put_energy + EPS))


def oi_confirm(chain: pd.DataFrame) -> float:
    call_proxy = np.sum(chain.get("call_volume", 0) / (chain.get("call_oi", 1) + 1))
    put_proxy = np.sum(chain.get("put_volume", 0) / (chain.get("put_oi", 1) + 1))
    return normalize((call_proxy - put_proxy), scale=max(abs(call_proxy) + abs(put_proxy), 1.0))


def hedge_pressure(chain: pd.DataFrame, state: MarketState) -> float:
    call_delta = chain.get("call_delta", 0.0)
    put_delta = np.abs(chain.get("put_delta", 0.0))
    call_shares = np.sum(chain.get("call_volume", 0) * 100 * call_delta)
    put_shares = np.sum(chain.get("put_volume", 0) * 100 * put_delta)
    net_dollars = state.spot * (call_shares - put_shares)
    denom = state.stock_dollar_volume or max(abs(net_dollars) * 5.0, 1.0)
    return float(np.tanh(net_dollars / (denom + EPS)))


def stock_confirm(state: MarketState, previous_spot: float | None = None) -> float:
    momentum = 0.0 if previous_spot is None else np.log(state.spot / previous_spot)
    vwap_distance = 0.0 if state.vwap is None else (state.spot - state.vwap) / max(state.vwap, EPS)
    rvol_term = 0.0 if state.rvol is None else np.log(max(state.rvol, EPS))
    return float(np.tanh(12 * momentum + 4 * vwap_distance + 0.2 * rvol_term))


def wall_pressure(state: MarketState, k_wall: float | None, energy_signal_value: float, h: float = 1.0) -> float:
    if k_wall is None or not (state.spot < k_wall and energy_signal_value > 0):
        return 0.0
    return float(np.exp(-abs(state.spot - k_wall) / max(h, EPS)))


def close_decay(state: MarketState, p: float = 2.0) -> float:
    progress = min(max(state.minutes_from_open / max(state.minutes_to_close_total, 1.0), 0.0), 1.0)
    if state.spot >= state.high:
        return 0.0
    return float((progress ** p) * ((state.high - state.spot) / (state.high - state.low + EPS)))


def momentum_divergence(state: MarketState, energy_signal_value: float, previous_spot: float | None) -> float:
    if previous_spot is None:
        return 0.0
    if energy_signal_value > 0 and state.spot < state.high and state.spot < previous_spot:
        return float(abs((state.high - state.spot) / max(state.spot, EPS)))
    return 0.0


def breakout_boost(state: MarketState, k_wall: float | None, energy_signal_value: float, previous_spot: float | None) -> float:
    if k_wall is None or previous_spot is None:
        return 0.0
    if state.spot > k_wall and state.spot > previous_spot and energy_signal_value > 0:
        return 1.0
    return 0.0
