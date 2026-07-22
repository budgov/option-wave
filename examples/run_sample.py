from __future__ import annotations

import pandas as pd

from option_wave import MarketState, OceanWave, ShortData


def make_sample_chain() -> pd.DataFrame:
    """Create two symmetric strike ladders for same-day and future expiry."""

    spot = 100.0
    strikes = [90, 95, 100, 105, 110]
    rows = []
    for expiry_days in (0, 1, 7):
        for strike in strikes:
            distance = abs(strike - spot) / spot
            time_value = 0.55 + 0.08 * (expiry_days + 1) ** 0.5
            rows.append({
                "strike": strike,
                "expiry_days": expiry_days,
                "call_bid": max(0.05, spot - strike) / 100 + time_value,
                "call_ask": max(0.08, spot - strike) / 100 + time_value + 0.04,
                "put_bid": max(0.05, strike - spot) / 100 + time_value * (1.0 + distance),
                "put_ask": max(0.08, strike - spot) / 100 + time_value * (1.0 + distance) + 0.04,
                "call_volume": 1000 + 100 * expiry_days,
                "put_volume": 900 + 160 * expiry_days,
                "call_oi": 5000,
                "put_oi": 5000,
                "call_iv": 0.24 + expiry_days * 0.005,
                "put_iv": 0.25 + expiry_days * 0.005,
                "call_delta": 0.50,
                "put_delta": -0.50,
                "call_gamma": 0.02,
                "put_gamma": 0.02,
                "call_vega": 0.10,
                "put_vega": 0.10,
            })
    return pd.DataFrame(rows)


def main() -> None:
    model = OceanWave()
    result = model.predict(
        make_sample_chain(),
        MarketState(
            spot=100.0,
            high=102.0,
            low=97.0,
            vwap=99.8,
            previous_close=99.5,
            return_5m=0.001,
            return_15m=0.002,
            rvol=1.2,
            realized_vol=0.25,
        ),
        short_data=ShortData(short_interest_ratio=0.08, short_volume_ratio=0.48, days_to_cover=1.7),
    )
    print(f"TrendScore: {result.trend_score:+.3f}")
    print(f"Direction: {result.direction}")
    print(f"Confidence: {result.confidence:.2f}")
    print("Expectations:")
    for horizon, expectation in result.expectations.items():
        print(
            f"  {horizon:>4.0f}m: price={expectation.expected_price:.3f}, "
            f"return={expectation.expected_return:+.3%}, "
            f"P(up)={expectation.probability_up:.2%}"
        )
    print("Pair check:")
    print(result.elo_surface[["expiry_days", "distance_pct", "call_strike", "put_strike", "elo_signal"]].head(8).to_string(index=False))
    print("Dynamic factor weights:")
    print(result.factor_table[["factor", "signal", "confidence", "dynamic_weight", "contribution"]].to_string(index=False))


if __name__ == "__main__":
    main()
