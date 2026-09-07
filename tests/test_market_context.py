from __future__ import annotations

import copy
import math
import unittest

from option_wave.market_context import prepare_market_context, SCHEMA, TNX_UNIT_CONTRACT, TNX_UNIT_SOURCE


def context():
    def instrument(symbol, **extra):
        return {"symbol": symbol, "provider": "schwab", "observed_at": "2026-09-08T14:00:00Z",
                "price": 101.0, "reference_price_5m": 100.0, "reference_at_5m": "2026-09-08T13:55:00Z",
                "reference_price_15m": 99.0, "reference_at_15m": "2026-09-08T13:45:00Z",
                "data_tier": "realtime", "is_proxy": False, "quote_unit": "usd", **extra}
    return {"schema_version": SCHEMA, "as_of": "2026-09-08T14:00:00Z", "instruments": {
        "SQQQ": instrument("SQQQ", role="inverse", underlying="QQQ", daily_leverage=-3),
        "GLD": instrument("GLD", role="macro", factor="gold", is_proxy=True, represents="gold_etf_proxy"),
        "$TNX": instrument("$TNX", role="macro", factor="treasury_10y", price=42.01,
                           reference_price_5m=42.0, quote_unit="index_points", multiplier_to_percent=0.1,
                           units_verified=True, reference_units_verified_5m=True, change_bps_5m=0.1,
                           identity_verified=True, asset_main_type="INDEX", provider_description="CBOE INT RATE 10 YR T-NOTE",
                           unit_contract=TNX_UNIT_CONTRACT, unit_source=TNX_UNIT_SOURCE),
        "$NYICDX": instrument("$NYICDX", role="macro", factor="dollar_index", quote_unit="index_points",
                             identity_verified=True, asset_main_type="INDEX", provider_description="ICE U.S. Dollar Index",
                             represents="ice_us_dollar_index"),
        "$VIX": instrument("$VIX", role="macro", factor="vix", price=25.0, reference_price_5m=24.0,
                           quote_unit="index_points")}}


class MarketContextTests(unittest.TestCase):
    def prepare(self, payload=None, symbol="QQQ"):
        return prepare_market_context(context() if payload is None else payload,
                                      symbol=symbol, issued_at="2026-09-08T14:00:00Z", realized_vol=0.3)

    def test_inverse_leverage_and_all_macro_units_are_explicit(self):
        result = self.prepare()
        self.assertAlmostEqual(result["context_features"]["inverse_return_5m"], math.log(1.01) / -3)
        self.assertLess(result["model"]["inverse_signal"], 0)
        self.assertEqual(result["model"]["inverse_symbol"], "SQQQ")
        self.assertAlmostEqual(result["context_features"]["treasury_10y_change_bps"], 0.1)
        self.assertEqual(result["context_features"]["vix_change"], 1.0)
        self.assertEqual(result["context_features"]["vix_level"], 25.0)
        self.assertTrue(result["audit"]["accepted"]["GLD"]["is_proxy"])

    def test_no_macro_direction_is_invented_or_read_from_payload(self):
        payload = context()
        payload["macro_signals"] = {"gold": 1}
        result = self.prepare(payload)
        self.assertTrue(all(value is None for value in result["model"]["macro_signals"].values()))
        self.assertGreater(result["model"]["risk_multiplier"], 1)
        self.assertLessEqual(result["model"]["risk_multiplier"], 3)

    def test_future_stale_wrong_day_or_delayed_observations_stay_missing(self):
        for updates in ({"observed_at": "2026-09-08T14:00:01Z"},
                        {"observed_at": "2026-09-08T13:59:44Z"},
                        {"observed_at": "2026-09-04T14:00:00Z"}, {"data_tier": "delayed"}):
            payload = context()
            payload["instruments"]["SQQQ"].update(updates)
            with self.subTest(updates=updates):
                self.assertIsNone(self.prepare(payload)["context_features"]["inverse_return_5m"])

    def test_same_day_completed_reference_and_nonforged_returns_required(self):
        payload = context()
        payload["instruments"]["SQQQ"].update(return_5m=999,
            reference_at_5m="2026-09-08T13:56:00Z", reference_at_15m="2026-09-04T13:45:00Z")
        result = self.prepare(payload)
        self.assertIsNone(result["context_features"]["inverse_return_5m"])
        self.assertIsNone(result["context_features"]["inverse_return_15m"])
        self.assertEqual(result["model"]["inverse_confidence"], 0)

    def test_wrong_leverage_and_other_target_are_not_used(self):
        payload = context()
        payload["instruments"]["SQQQ"]["daily_leverage"] = -1
        self.assertIsNone(self.prepare(payload)["context_features"]["inverse_return_5m"])
        self.assertIsNone(self.prepare(symbol="AAPL")["context_features"]["inverse_return_5m"])

    def test_etf_dollar_proxy_and_unverified_yield_do_not_masquerade_as_index(self):
        payload = context()
        payload["instruments"]["$TNX"]["units_verified"] = False
        payload["instruments"]["$NYICDX"]["is_proxy"] = True
        result = self.prepare(payload)
        self.assertIsNone(result["context_features"]["treasury_10y_change_bps"])
        self.assertIsNone(result["context_features"]["dollar_return_5m"])

    def test_index_identity_and_reference_units_cannot_be_forged(self):
        for key, update, feature in (
            ("$TNX", {"reference_units_verified_5m": False}, "treasury_10y_change_bps"),
            ("$TNX", {"unit_contract": "price_magnitude_guess"}, "treasury_10y_change_bps"),
            ("$TNX", {"asset_main_type": "EQUITY"}, "treasury_10y_change_bps"),
            ("$NYICDX", {"provider_description": "a dollar ETF"}, "dollar_return_5m"),
            ("$NYICDX", {"identity_verified": False}, "dollar_return_5m"),
            ("GLD", {"quote_unit": "index_points"}, "gold_return_5m"),
            ("SQQQ", {"realTime": False}, "inverse_return_5m"),
        ):
            with self.subTest(key=key, update=update):
                payload = context()
                payload["instruments"][key].update(update)
                self.assertIsNone(self.prepare(payload)["context_features"][feature])

    def test_boundary_does_not_mutate_or_trust_a_different_forecast_origin(self):
        payload = context()
        before = copy.deepcopy(payload)
        self.prepare(payload)
        self.assertEqual(before, payload)
        payload["as_of"] = "2026-09-08T14:00:01Z"
        result = self.prepare(payload)
        self.assertTrue(all(value is None for value in result["context_features"].values()))
        self.assertEqual(result["model"]["risk_multiplier"], 1.0)


if __name__ == "__main__":
    unittest.main()
