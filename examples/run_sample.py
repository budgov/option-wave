from __future__ import annotations

import pandas as pd

from option_wave import OptionWaveV08
from option_wave.factors import MarketState
from option_wave.charts import plot_contributions


def make_sample_chain() -> pd.DataFrame:
    strikes = [717, 718, 719, 720, 721, 722, 723, 724, 725]
    rows = []
    for k in strikes:
        rows.append({
            "strike": k,
            "expiry_days": 0,
            "call_bid": max(0.05, 721.5 - k) + 0.35,
            "call_ask": max(0.08, 721.5 - k) + 0.45,
            "call_last": max(0.06, 721.5 - k) + 0.40,
            "put_bid": max(0.05, k - 721.5) + 0.35,
            "put_ask": max(0.08, k - 721.5) + 0.45,
            "put_last": max(0.06, k - 721.5) + 0.40,
            "call_volume": 1000 + max(0, k - 720) * 300,
            "put_volume": 900 + max(0, 721 - k) * 350,
            "call_oi": 5000,
            "put_oi": 5000,
            "call_delta": max(0.05, min(0.95, 0.5 - (k-721.5)*0.08)),
            "put_delta": -max(0.05, min(0.95, 0.5 + (k-721.5)*0.08)),
        })
    return pd.DataFrame(rows)


def main() -> None:
    chain = make_sample_chain()
    model = OptionWaveV08()
    state = MarketState(
        spot=721.5,
        high=725.0,
        low=717.18,
        vwap=721.8,
        rvol=1.2,
        stock_dollar_volume=721.5 * 10_000_000,
        minutes_from_open=180,
    )
    result = model.predict(chain, state, k_wall=722.0, whale_impact=0.0, whale_confidence=0.0)
    print(f"TrendScore: {result.trend_score:+.3f}")
    print(f"Direction: {result.direction}")
    print(f"Confidence: {result.confidence:.2f}")
    print("Factors:")
    for k, v in result.factors.items():
        print(f"  {k}: {v:+.4f}")

    plot_contributions(result.contributions, "Option Wave v0.8 sample factor contributions", "sample_contributions.png")
    print("Saved chart: sample_contributions.png")


if __name__ == "__main__":
    main()
