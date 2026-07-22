"""Reproducible warm-path benchmark for the Ocean Wave engine."""

from __future__ import annotations

import argparse
from time import perf_counter_ns

import numpy as np
import pandas as pd

from option_wave import HAS_CPP_CORE, MarketState, OceanWave


def make_chain(expiries: int = 20, strikes: int = 101) -> pd.DataFrame:
    spot = 100.0
    strike_grid = np.linspace(70.0, 130.0, strikes)
    rows = []
    for expiry in np.linspace(0.0, 60.0, expiries):
        tau = (expiry + 1.0) / 365.0
        for strike in strike_grid:
            moneyness = np.log(strike / spot)
            iv = 0.22 - 0.10 * moneyness + 0.35 * moneyness * moneyness + 0.02 * np.sqrt(tau)
            time_value = max(0.05, spot * iv * np.sqrt(tau) * np.exp(-4.0 * abs(moneyness)) / 8.0)
            call_mid = max(spot - strike, 0.0) + time_value
            put_mid = max(strike - spot, 0.0) + time_value * (1.0 + max(-moneyness, 0.0))
            delta_call = float(np.clip(0.50 - 3.0 * moneyness, 0.02, 0.98))
            gamma = float(np.exp(-20.0 * moneyness * moneyness) / max(spot * iv * np.sqrt(tau), 1.0))
            volume = 1500.0 * np.exp(-8.0 * abs(moneyness)) + 20.0
            rows.append({
                "strike": strike,
                "expiry_days": expiry,
                "call_bid": max(call_mid - 0.03, 0.01),
                "call_ask": call_mid + 0.03,
                "put_bid": max(put_mid - 0.03, 0.01),
                "put_ask": put_mid + 0.03,
                "call_volume": volume * 1.08,
                "put_volume": volume,
                "call_oi": volume * 8.0,
                "put_oi": volume * 8.5,
                "call_iv": iv,
                "put_iv": iv + 0.015 * np.exp(-4.0 * abs(moneyness)),
                "call_delta": delta_call,
                "put_delta": delta_call - 1.0,
                "call_gamma": gamma,
                "put_gamma": gamma,
                "call_vega": spot * np.sqrt(tau) * np.exp(-10.0 * moneyness * moneyness) / 100.0,
                "put_vega": spot * np.sqrt(tau) * np.exp(-10.0 * moneyness * moneyness) / 100.0,
            })
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=100)
    args = parser.parse_args()
    chain = make_chain()
    previous = chain.copy()
    previous["call_oi"] *= 0.99
    previous["put_oi"] *= 1.01
    state = MarketState(
        spot=100.0,
        previous_close=99.5,
        vwap=99.8,
        return_5m=0.001,
        return_15m=0.002,
        rvol=1.15,
        realized_vol=0.21,
    )
    model = OceanWave()
    model.predict(chain, state, previous_chain=previous, horizons_minutes=(30.0,))
    samples = []
    for _ in range(max(args.iterations, 1)):
        started = perf_counter_ns()
        model.predict(chain, state, previous_chain=previous, horizons_minutes=(30.0,))
        samples.append((perf_counter_ns() - started) / 1_000_000.0)
    values = np.asarray(samples)
    print(f"rows={len(chain)} cpp={HAS_CPP_CORE} iterations={len(values)}")
    print(f"median_ms={np.median(values):.3f} p95_ms={np.percentile(values, 95):.3f} min_ms={values.min():.3f}")


if __name__ == "__main__":
    main()

