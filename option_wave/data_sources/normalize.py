from __future__ import annotations

from typing import Iterable

import numpy as np
import pandas as pd

REQUIRED_COLUMNS = [
    "strike",
    "expiry_date",
    "expiry_days",
    "call_bid",
    "call_ask",
    "call_last",
    "put_bid",
    "put_ask",
    "put_last",
    "call_volume",
    "put_volume",
    "call_oi",
    "put_oi",
    "call_iv",
    "put_iv",
    "call_delta",
    "put_delta",
    "call_gamma",
    "put_gamma",
    "call_vega",
    "put_vega",
]

ALIASES = {
    "expiry": "expiry_date",
    "expiration": "expiry_date",
    "expiration_date": "expiry_date",
    "dte": "expiry_days",
    "days_to_expiry": "expiry_days",
    "call_open_interest": "call_oi",
    "put_open_interest": "put_oi",
}

NUMERIC_COLUMNS = [c for c in REQUIRED_COLUMNS if c not in {"expiry_date"}]
OPTION_FIELDS = {
    "bid": "bid",
    "ask": "ask",
    "last": "last",
    "mid": "mid",
    "volume": "volume",
    "oi": "oi",
    "iv": "iv",
    "delta": "delta",
    "gamma": "gamma",
    "vega": "vega",
    "theta": "theta",
    "code": "code",
}


def _clean_columns(columns: Iterable[str]) -> list[str]:
    cleaned = []
    for col in columns:
        col = str(col).strip().lower().replace(" ", "_")
        col = col.replace("/", "_").replace("-", "_")
        cleaned.append(ALIASES.get(col, col))
    return cleaned


def _coerce_expiry_days(df: pd.DataFrame) -> pd.DataFrame:
    if "expiry_days" in df.columns and df["expiry_days"].notna().any():
        return df
    if "expiry_date" not in df.columns:
        df["expiry_days"] = 0
        return df
    expiry = pd.to_datetime(df["expiry_date"], errors="coerce")
    today = pd.Timestamp.utcnow().normalize().tz_localize(None)
    df["expiry_days"] = (expiry - today).dt.days.clip(lower=0).fillna(0)
    return df


def _ensure_mid_prices(df: pd.DataFrame) -> pd.DataFrame:
    for side in ("call", "put"):
        bid = pd.to_numeric(df.get(f"{side}_bid", 0.0), errors="coerce").fillna(0.0)
        ask = pd.to_numeric(df.get(f"{side}_ask", 0.0), errors="coerce").fillna(0.0)
        last = pd.to_numeric(df.get(f"{side}_last", 0.0), errors="coerce").fillna(0.0)
        mid = np.where((bid > 0) & (ask > 0), (bid + ask) / 2.0, last)
        df[f"{side}_mid"] = mid
    return df


def normalize_option_chain(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        raise ValueError("Option chain is empty.")

    out = df.copy()
    out.columns = _clean_columns(out.columns)

    if {"option_type", "code"}.issubset(out.columns):
        out = _pivot_long_option_chain(out)

    missing = [col for col in REQUIRED_COLUMNS if col not in out.columns]
    for col in missing:
        if col == "expiry_date":
            out[col] = pd.NaT
        else:
            out[col] = 0.0

    if "expiry_date" in out.columns:
        out["expiry_date"] = pd.to_datetime(out["expiry_date"], errors="coerce").dt.strftime("%Y-%m-%d")
    out = _coerce_expiry_days(out)

    for col in NUMERIC_COLUMNS:
        if col in out.columns:
            out[col] = pd.to_numeric(out[col], errors="coerce").fillna(0.0)

    out = _ensure_mid_prices(out)
    out = out.sort_values(["expiry_days", "strike"], ascending=[True, True]).reset_index(drop=True)
    return out


def _pivot_long_option_chain(df: pd.DataFrame) -> pd.DataFrame:
    long_df = df.copy()
    long_df["option_type"] = long_df["option_type"].astype(str).str.upper()
    long_df["side"] = np.where(long_df["option_type"].str.startswith("C"), "call", "put")

    if "strike" not in long_df.columns and "option_strike_price" in long_df.columns:
        long_df["strike"] = long_df["option_strike_price"]
    if "expiry_date" not in long_df.columns and "strike_time" in long_df.columns:
        long_df["expiry_date"] = long_df["strike_time"]
    if "oi" not in long_df.columns and "option_open_interest" in long_df.columns:
        long_df["oi"] = long_df["option_open_interest"]
    if "iv" not in long_df.columns and "option_implied_volatility" in long_df.columns:
        long_df["iv"] = long_df["option_implied_volatility"]
    if "delta" not in long_df.columns and "option_delta" in long_df.columns:
        long_df["delta"] = long_df["option_delta"]
    if "gamma" not in long_df.columns and "option_gamma" in long_df.columns:
        long_df["gamma"] = long_df["option_gamma"]
    if "vega" not in long_df.columns and "option_vega" in long_df.columns:
        long_df["vega"] = long_df["option_vega"]
    if "theta" not in long_df.columns and "option_theta" in long_df.columns:
        long_df["theta"] = long_df["option_theta"]
    if "bid" not in long_df.columns and "bid_price" in long_df.columns:
        long_df["bid"] = long_df["bid_price"]
    if "ask" not in long_df.columns and "ask_price" in long_df.columns:
        long_df["ask"] = long_df["ask_price"]
    if "last" not in long_df.columns and "last_price" in long_df.columns:
        long_df["last"] = long_df["last_price"]

    value_columns = [
        "code",
        "bid",
        "ask",
        "last",
        "volume",
        "oi",
        "iv",
        "delta",
        "gamma",
        "vega",
        "theta",
        "expiry_days",
    ]
    base_columns = [col for col in ["strike", "expiry_date"] if col in long_df.columns]

    pivoted = long_df[base_columns + ["side"] + [c for c in value_columns if c in long_df.columns]].pivot_table(
        index=base_columns,
        columns="side",
        values=[c for c in value_columns if c in long_df.columns],
        aggfunc="first",
    )
    pivoted.columns = [f"{side}_{field}" for field, side in pivoted.columns]
    pivoted = pivoted.reset_index()

    rename_map = {
        "call_code": "call_code",
        "put_code": "put_code",
        "call_bid": "call_bid",
        "put_bid": "put_bid",
        "call_ask": "call_ask",
        "put_ask": "put_ask",
        "call_last": "call_last",
        "put_last": "put_last",
        "call_volume": "call_volume",
        "put_volume": "put_volume",
        "call_oi": "call_oi",
        "put_oi": "put_oi",
        "call_iv": "call_iv",
        "put_iv": "put_iv",
        "call_delta": "call_delta",
        "put_delta": "put_delta",
        "call_gamma": "call_gamma",
        "put_gamma": "put_gamma",
        "call_vega": "call_vega",
        "put_vega": "put_vega",
        "call_theta": "call_theta",
        "put_theta": "put_theta",
    }
    pivoted = pivoted.rename(columns=rename_map)
    return pivoted
