from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from option_wave import (
    FACTOR_NAMES,
    InverseLink,
    InverseMarketData,
    InverseRegistry,
    MarketState,
    MassiveHTTPClient,
    OceanWave,
    OptionWaveV09,
    ShortData,
    aggregate_large_flow,
)
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
                "call_delta": 0.50,
                "put_delta": -0.50,
                "call_gamma": 0.02,
                "put_gamma": 0.02,
                "call_vega": 0.10,
                "put_vega": 0.10,
            })
    return pd.DataFrame(rows)


class OceanWaveTests(unittest.TestCase):
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
        model = OceanWave()
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
        self.assertEqual(set(result.factor_table.factor), set(FACTOR_NAMES))
        self.assertAlmostEqual(float(result.factor_table.dynamic_weight.sum()), 1.0)
        self.assertEqual(result.diagnostics["model_name"], "Ocean Wave")

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
                "delta": 0.45,
                "gamma": 0.02,
                "spot": 100.0,
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
        self.assertGreater(summary.delta_hedge_shares, 0.0)
        self.assertGreater(summary.hedge_signal, 0.0)

    def test_short_pressure_and_dynamic_asymmetry_enter_model(self) -> None:
        result = OceanWave().predict(
            chain(),
            MarketState(
                spot=98.0,
                previous_close=100.0,
                vwap=99.0,
                return_5m=-0.01,
                return_15m=-0.015,
                realized_vol=0.25,
            ),
            short_data=ShortData(
                short_interest_ratio=0.25,
                short_interest_change=0.12,
                short_volume_ratio=0.65,
                borrow_fee=0.18,
                utilization=0.92,
                days_to_cover=5.0,
            ),
            horizons_minutes=(30.0,),
        )
        short_row = result.factor_table.loc[result.factor_table.factor == "short_pressure"].iloc[0]
        self.assertLess(float(short_row.signal), 0.0)
        self.assertGreater(float(short_row.confidence), 0.0)
        self.assertGreater(
            float(result.diagnostics["dynamic_up_difficulty"]),
            float(result.diagnostics["dynamic_down_difficulty"]),
        )

    def test_iv_gex_and_oi_statistics_are_extracted(self) -> None:
        current = chain()
        previous = current.copy()
        current["call_oi"] += 200.0
        current["put_oi"] += 50.0
        current.loc[current.strike <= 100.0, "put_iv"] = 0.34
        result = OceanWave().predict(
            current,
            MarketState(spot=100.0, realized_vol=0.20),
            previous_chain=previous,
            horizons_minutes=(30.0,),
        )
        self.assertLess(result.chain_factors.iv_surface_signal, 0.0)
        self.assertGreater(result.chain_factors.oi_signal, 0.0)
        self.assertTrue(np.isfinite(result.chain_factors.gex_net))
        self.assertGreater(result.chain_factors.iv_coverage, 0.0)

    def test_short_json_normalizer_uses_decimal_units(self) -> None:
        short_data = MassiveHTTPClient.normalize_short_data({
            "short_percent_float": 22.0,
            "short_interest_change": 5.0,
            "short_volume_ratio": 0.61,
            "cost_to_borrow": 18.0,
            "utilization": 91.0,
            "days_to_cover": 4.2,
        })
        self.assertAlmostEqual(short_data.short_interest_ratio or 0.0, 0.22)
        self.assertAlmostEqual(short_data.borrow_fee or 0.0, 0.18)
        self.assertAlmostEqual(short_data.utilization or 0.0, 0.91)

    def test_legacy_class_name_remains_an_alias(self) -> None:
        self.assertIs(OptionWaveV09, OceanWave)

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

    def test_inverse_registry_is_universal_and_extensible(self) -> None:
        registry = InverseRegistry()
        spy_links = registry.resolve("spy", available_symbols={"SH", "SDS"})
        self.assertEqual({link.inverse_symbol for link in spy_links}, {"SH", "SDS"})
        registry.register(InverseLink("TSLA", "TSLS", -1.0, source="test"))
        self.assertEqual(registry.resolve("TSLA")[0].inverse_symbol, "TSLS")
        self.assertEqual(registry.resolve("AAPL", available_symbols={"NOPE"}), ())

    def test_model_combines_multiple_inverse_markets(self) -> None:
        inverse_chain = chain()
        inverse_chain["call_bid"] += 0.5
        inverse_chain["call_ask"] += 0.5
        result = OptionWaveV09().predict(
            chain(),
            MarketState(spot=100.0, realized_vol=0.25, symbol="SPY"),
            inverse_markets=(
                InverseMarketData("SH", inverse_chain, MarketState(spot=100.0), -1.0),
                InverseMarketData("SDS", inverse_chain, MarketState(spot=100.0), -2.0),
            ),
            horizons_minutes=(30.0,),
        )
        self.assertEqual(result.diagnostics["inverse_count"], 2.0)
        self.assertEqual(result.diagnostics["inverse_symbols"], "SH,SDS")
        self.assertLess(float(result.diagnostics["inverse_target_signal"]), 0.0)

    def test_http_snapshot_normalizer_builds_wide_chain(self) -> None:
        payload = {
            "results": [
                {
                    "details": {"contract_type": "call", "strike_price": 105.0, "expiration_date": "2026-07-25"},
                    "last_quote": {"bid": 1.9, "ask": 2.1},
                    "last_trade": {"price": 2.0, "sip_timestamp": 1784980800000000000},
                    "day": {"volume": 1000},
                    "open_interest": 5000,
                    "implied_volatility": 0.25,
                    "greeks": {"delta": 0.45, "gamma": 0.03},
                },
                {
                    "details": {"contract_type": "put", "strike_price": 95.0, "expiration_date": "2026-07-25"},
                    "last_quote": {"bid": 0.9, "ask": 1.1},
                    "last_trade": {"price": 1.0, "sip_timestamp": 1784980800000000000},
                    "day": {"volume": 800},
                    "open_interest": 4500,
                    "implied_volatility": 0.27,
                    "greeks": {"delta": -0.45, "gamma": 0.03},
                },
            ]
        }
        normalized = MassiveHTTPClient.normalize_option_snapshots(payload, as_of="2026-07-18")
        self.assertEqual(len(normalized), 2)
        self.assertIn("call_bid", normalized)
        self.assertIn("put_bid", normalized)
        self.assertEqual(float(normalized.loc[normalized.strike == 105.0, "call_last"].iloc[0]), 2.0)


if __name__ == "__main__":
    unittest.main()
