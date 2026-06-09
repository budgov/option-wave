from __future__ import annotations

import pandas as pd

from option_wave import OptionWaveV08
from option_wave.data_sources.normalize import normalize_option_chain
from option_wave.factors import MarketState


def test_normalize_long_form_chain() -> None:
    raw = pd.DataFrame(
        [
            {
                "code": "US.AAPL240621C00190000",
                "option_type": "CALL",
                "strike": 190,
                "expiry_date": "2026-06-21",
                "bid": 3.1,
                "ask": 3.3,
                "last": 3.2,
                "volume": 120,
                "oi": 700,
                "iv": 0.24,
                "delta": 0.42,
                "gamma": 0.03,
                "vega": 0.14,
            },
            {
                "code": "US.AAPL240621P00190000",
                "option_type": "PUT",
                "strike": 190,
                "expiry_date": "2026-06-21",
                "bid": 2.8,
                "ask": 3.0,
                "last": 2.9,
                "volume": 95,
                "oi": 680,
                "iv": 0.26,
                "delta": -0.38,
                "gamma": 0.03,
                "vega": 0.13,
            },
        ]
    )

    chain = normalize_option_chain(raw)
    assert len(chain) == 1
    assert chain.loc[0, "call_bid"] == 3.1
    assert chain.loc[0, "put_bid"] == 2.8
    assert chain.loc[0, "call_oi"] == 700
    assert chain.loc[0, "put_delta"] == -0.38


def test_model_pipeline_runs_on_normalized_chain() -> None:
    chain = pd.DataFrame(
        [
            {
                "strike": 189,
                "expiry_date": "2026-06-21",
                "expiry_days": 12,
                "call_bid": 4.2,
                "call_ask": 4.4,
                "call_last": 4.3,
                "put_bid": 1.9,
                "put_ask": 2.1,
                "put_last": 2.0,
                "call_volume": 150,
                "put_volume": 80,
                "call_oi": 900,
                "put_oi": 500,
                "call_iv": 0.24,
                "put_iv": 0.23,
                "call_delta": 0.52,
                "put_delta": -0.31,
                "call_gamma": 0.04,
                "put_gamma": 0.03,
                "call_vega": 0.12,
                "put_vega": 0.11,
            },
            {
                "strike": 190,
                "expiry_date": "2026-06-21",
                "expiry_days": 12,
                "call_bid": 3.5,
                "call_ask": 3.7,
                "call_last": 3.6,
                "put_bid": 2.5,
                "put_ask": 2.7,
                "put_last": 2.6,
                "call_volume": 160,
                "put_volume": 120,
                "call_oi": 950,
                "put_oi": 640,
                "call_iv": 0.25,
                "put_iv": 0.24,
                "call_delta": 0.48,
                "put_delta": -0.36,
                "call_gamma": 0.04,
                "put_gamma": 0.03,
                "call_vega": 0.11,
                "put_vega": 0.12,
            },
        ]
    )
    chain = normalize_option_chain(chain)
    state = MarketState(
        spot=190.4,
        high=191.2,
        low=188.8,
        vwap=190.1,
        rvol=1.1,
        stock_dollar_volume=250_000_000,
        minutes_from_open=110,
    )

    result = OptionWaveV08().predict(chain, state, k_wall=190.0)
    assert -1.0 <= result.trend_score <= 1.0
    assert result.direction
    assert "premium_elo" in result.factors
    assert "breakout_boost" in result.boosts
