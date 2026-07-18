from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from option_wave import MarketState, OptionWaveV09, aggregate_large_flow
from option_wave.elo import EloConfig, asymmetric_cost, build_symmetric_pairs


def chain(spread: float = 0.10) -> pd.DataFrame:
    rows = []
    for expiry_days in (0, 1, 7):
        for strike in (90.0, 95.0, 100.0, 105.0, 110.0):
            rows.append({
                "strike": strike,
                "expiry_days": expiry_days,
                "call_bid": 1.0,
                "call_ask": 1.0 + spread,
                "put_bid": 1.0,
                "put_ask": 1.0 + spread,
                "call_volume": 1000.0,
                "put_volume": 900.0,
                "call_oi": 5000.0,
                "put_oi": 5000.0,
                "call_iv": 0.25,
                "put_iv": 0.26,
            })
    return pd.DataFrame(rows)


class OptionWaveV09Tests(unittest.TestCase):
    def test_symmetric_pair_is_relative_not_same_strike(self) -> None:
        pairs = build_symmetric_pairs(chain(), spot=100.0)
        match = pairs[(pairs.expiry_days == 0) & np.isclose(pairs.distance_pct, 0.05)]
        self.assertEqual(len(match), 1)
        row = match.iloc[0]
        self.assertAlmostEqual(row.call_strike, 105.0)
        self.assertAlmostEqual(row.put_strike, 95.0)

    def test_upside_cost_is_higher_than_downside_cost(self) -> None:
        cfg = EloConfig()
        up = asymmetric_cost(0.05, "up", cfg)
        down = asymmetric_cost(0.05, "down", cfg)
        self.assertGreater(float(up), float(down))

    def test_wider_quotes_reduce_pair_confidence(self) -> None:
        tight = build_symmetric_pairs(chain(0.02), spot=100.0)
        wide = build_symmetric_pairs(chain(1.00), spot=100.0)
        tight_conf = tight.loc[np.isclose(tight.distance_pct, 0.05), "confidence"].mean()
        wide_conf = wide.loc[np.isclose(wide.distance_pct, 0.05), "confidence"].mean()
        self.assertGreater(tight_conf, wide_conf)

    def test_model_returns_integrated_expectations(self) -> None:
        model = OptionWaveV09()
        result = model.predict(
            chain(),
            MarketState(spot=100.0, realized_vol=0.25),
            horizons_minutes=(5.0, 30.0),
        )
        self.assertEqual(set(result.expectations), {5.0, 30.0})
        self.assertEqual(result.field_grid.shape, (3, 3))
        self.assertTrue(np.isfinite(result.trend_score))
        self.assertTrue(np.isfinite(result.expectations[30.0].expected_price))
        self.assertGreaterEqual(result.expectations[30.0].probability_up, 0.0)
        self.assertLessEqual(result.expectations[30.0].probability_up, 1.0)

    def test_online_elo_state_changes_between_snapshots(self) -> None:
        model = OptionWaveV09()
        first = model.predict(chain(), MarketState(spot=100.0, realized_vol=0.25))
        changed = chain()
        changed["call_bid"] += 0.25
        changed["call_ask"] += 0.25
        second = model.predict(changed, MarketState(spot=100.0, realized_vol=0.25))
        first_signal = first.elo_surface.elo_signal.to_numpy()
        second_signal = second.elo_surface.elo_signal.to_numpy()
        self.assertFalse(np.allclose(first_signal, second_signal))

    def test_large_flow_tracks_direction_without_price_guessing(self) -> None:
        flow = pd.DataFrame([
            {
                "timestamp": "2026-07-18T14:59:00Z",
                "right": "C",
                "aggressor": "buy",
                "contracts": 10_000,
                "trade_price": 2.0,
                "is_opening": True,
            },
            {
                "timestamp": "2026-07-18T14:59:00Z",
                "right": "P",
                "aggressor": "buy",
                "contracts": 5_000,
                "trade_price": 1.0,
                "is_opening": True,
            },
            {
                "timestamp": "2026-07-18T14:59:00Z",
                "right": "C",
                "contracts": 5_000,
                "trade_price": 1.0,
                "is_opening": True,
            },
        ])
        summary = aggregate_large_flow(flow, asof="2026-07-18T15:00:00Z")
        self.assertEqual(summary.large_trade_count, 1)
        self.assertGreater(summary.large_net_notional, 0.0)
        self.assertGreater(summary.large_signal, 0.0)
        self.assertGreater(summary.confidence, 0.0)

    def test_inverse_index_is_mapped_back_to_target_direction(self) -> None:
        inverse = chain()
        inverse["call_bid"] += 0.5
        inverse["call_ask"] += 0.5
        result = OptionWaveV09().predict(
            chain(),
            MarketState(spot=100.0, realized_vol=0.25),
            inverse_chain=inverse,
            inverse_state=MarketState(spot=100.0, realized_vol=0.25),
            inverse_beta=-1.0,
            horizons_minutes=(30.0,),
        )
        self.assertGreater(result.diagnostics["inverse_native_signal"], 0.0)
        self.assertGreater(result.diagnostics["inverse_confidence"], 0.0)
        self.assertLess(result.diagnostics["inverse_target_signal"], 0.0)

    def test_composite_signal_contains_optional_indicators(self) -> None:
        flow = pd.DataFrame([
            {
                "age_minutes": 1.0,
                "right": "C",
                "aggressor": "buy",
                "contracts": 10_000,
                "trade_price": 2.0,
                "is_opening": True,
            },
        ])
        result = OptionWaveV09().predict(
            chain(),
            MarketState(spot=100.0, realized_vol=0.25),
            flow=flow,
            inverse_state=MarketState(spot=100.0, previous_close=99.0, realized_vol=0.25),
            inverse_beta=-1.0,
            horizons_minutes=(30.0,),
        )
        self.assertIn("composite_signal", result.diagnostics)
        self.assertGreater(result.diagnostics["large_flow_gross_notional"], 0.0)
        self.assertNotEqual(result.diagnostics["inverse_target_signal"], 0.0)


if __name__ == "__main__":
    unittest.main()
