from __future__ import annotations
from dataclasses import dataclass
import numpy as np
import pandas as pd

EPS = 1e-9

@dataclass
class EloConfig:
    alpha_call: float = 1.25
    alpha_put: float = 0.95
    k_factor: float = 32.0
    base_rating: float = 0.0
    min_distance: float = 0.0025


def _mid_price(row: pd.Series, side: str) -> float:
    bid = row.get(f"{side}_bid", np.nan)
    ask = row.get(f"{side}_ask", np.nan)
    last = row.get(f"{side}_last", np.nan)
    if pd.notna(bid) and pd.notna(ask) and ask > 0:
        return float((bid + ask) / 2.0)
    if pd.notna(last):
        return float(last)
    return 0.0


def energy_equalized_premium(price: float, distance: float, alpha: float, min_distance: float) -> float:
    d = max(abs(distance), min_distance)
    return float(price / (d ** alpha + EPS))


def build_elo_surface(chain: pd.DataFrame, spot: float, cfg: EloConfig | None = None) -> pd.DataFrame:
    cfg = cfg or EloConfig()
    out = chain.copy()
    n = len(out)
    call_ratings = np.full(n, cfg.base_rating, dtype=float)
    put_ratings = np.full(n, cfg.base_rating, dtype=float)
    call_eq = np.zeros(n, dtype=float)
    put_eq = np.zeros(n, dtype=float)

    for idx, row in out.reset_index(drop=True).iterrows():
        strike = float(row["strike"])
        c_price = _mid_price(row, "call")
        p_price = _mid_price(row, "put")
        d_call = max((strike - spot) / spot, cfg.min_distance)
        d_put = max((spot - strike) / spot, cfg.min_distance)
        c_star = energy_equalized_premium(c_price, d_call, cfg.alpha_call, cfg.min_distance)
        p_star = energy_equalized_premium(p_price, d_put, cfg.alpha_put, cfg.min_distance)
        call_eq[idx] = c_star
        put_eq[idx] = p_star
        e_c = call_ratings[idx]
        e_p = put_ratings[idx]
        p_call_expected = 1.0 / (1.0 + 10.0 ** ((e_p - e_c) / 400.0))
        p_put_expected = 1.0 - p_call_expected
        score_call = c_star / (c_star + p_star + EPS)
        score_put = p_star / (c_star + p_star + EPS)
        call_ratings[idx] = e_c + cfg.k_factor * (score_call - p_call_expected)
        put_ratings[idx] = e_p + cfg.k_factor * (score_put - p_put_expected)

    out["call_equalized_premium"] = call_eq
    out["put_equalized_premium"] = put_eq
    out["call_elo"] = call_ratings
    out["put_elo"] = put_ratings
    out["elo_net"] = call_ratings - put_ratings
    return out


def premium_sentiment_elo(elo_df: pd.DataFrame, spot: float) -> float:
    weights = 1.0 / (1.0 + np.abs(elo_df["strike"].to_numpy(dtype=float) - spot))
    call = np.sum(np.maximum(elo_df["call_elo"].to_numpy(dtype=float), 0.0) * weights)
    put = np.sum(np.maximum(elo_df["put_elo"].to_numpy(dtype=float), 0.0) * weights)
    return float((call - put) / (abs(call) + abs(put) + EPS))
