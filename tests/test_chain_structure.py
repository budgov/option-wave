"""Offline measured-chain metadata and native/reference parity checks."""
from __future__ import annotations

import math
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

from option_wave.factors import extract_chain_factors
from option_wave.online_forecast import HAS_ONLINE_CORE


def structure_chain() -> pd.DataFrame:
    rows = []
    for expiry in (1., 14.):
        for strike in (90., 95., 100., 105., 110.):
            moneyness = math.log(strike / 100.)
            level = .25 + .05 * moneyness + .4 * moneyness ** 2 + .01 * math.sqrt((expiry + 1) / 365.)
            rows.append({"strike": strike, "expiry_days": expiry,
                         "call_bid": 1., "call_ask": 1.1, "put_bid": 1., "put_ask": 1.1,
                         "call_volume": 1000., "put_volume": 500.,
                         "call_oi": 4000., "put_oi": 4000.,
                         "call_delta": .5, "put_delta": -.4,
                         "call_gamma": .02, "put_gamma": .02,
                         "call_iv": level, "put_iv": level + .02})
    return pd.DataFrame(rows)


@unittest.skipUnless(HAS_ONLINE_CORE, "v3 native option-structure core is not installed")
class ChainStructureTests(unittest.TestCase):
    def compare(self, frame: pd.DataFrame):
        with patch("option_wave.factors.HAS_CPP_CORE", False):
            reference = extract_chain_factors(frame, 100., realized_vol=.2)
        native = extract_chain_factors(frame, 100., realized_vol=.2)
        names = ("iv_skew_coverage", "iv_term_coverage", "iv_fit_coverage", "quote_coverage",
                 "option_activity", "option_activity_coverage", "gamma_concentration",
                 "iv_coverage", "iv_skew", "iv_level", "iv_term_slope", "liquidity_quality")
        for name in names:
            self.assertAlmostEqual(getattr(native, name), getattr(reference, name), places=10, msg=name)
        return native

    def test_complete_chain_reports_measured_structure_and_native_parity(self):
        result = self.compare(structure_chain())
        for name in ("iv_skew_coverage", "iv_term_coverage", "iv_fit_coverage",
                     "quote_coverage", "option_activity_coverage"):
            self.assertEqual(getattr(result, name), 1., name)
        self.assertAlmostEqual(result.option_activity, math.log1p(10 * (1000 * .5 + 500 * .4)))
        self.assertGreater(result.gamma_concentration, 0.)
        self.assertLess(result.gamma_concentration, 1.)

    def test_missing_far_expiry_has_no_identified_term_slope(self):
        frame = structure_chain()
        frame = frame.loc[frame.expiry_days <= 7.].copy()
        result = self.compare(frame)
        self.assertEqual(result.iv_term_coverage, 0.)
        self.assertEqual(result.iv_term_slope, 0.)
        self.assertEqual(result.iv_coverage, 1.)

    def test_activity_requires_measured_volume_and_delta_not_default_delta(self):
        baseline = structure_chain()
        for missing in (("call_volume", "put_volume"), ("call_delta", "put_delta"),
                        ("call_volume", "put_delta")):
            with self.subTest(missing=missing):
                result = self.compare(baseline.drop(columns=list(missing)))
                self.assertEqual(result.option_activity_coverage, 0.)
                self.assertEqual(result.option_activity, 0.)
        zero_volume = baseline.copy()
        zero_volume[["call_volume", "put_volume"]] = 0.
        result = self.compare(zero_volume)
        self.assertEqual(result.option_activity, 0.)
        self.assertEqual(result.option_activity_coverage, 1.)

    def test_invalid_bid_ask_has_no_observed_liquidity(self):
        for bid, ask in ((np.nan, np.nan), (2., 1.), (-.1, .1), (-.1, .3)):
            with self.subTest(bid=bid, ask=ask):
                frame = structure_chain()
                frame[["call_bid", "put_bid"]] = bid
                frame[["call_ask", "put_ask"]] = ask
                result = self.compare(frame)
                self.assertEqual(result.quote_coverage, 0.)
                self.assertEqual(result.liquidity_quality, 0.)

    def test_gamma_concentration_aggregates_same_strike_across_expiries(self):
        frame = structure_chain()
        frame[["call_gamma", "put_gamma"]] = 0.
        frame.loc[frame.strike == 100., ["call_gamma", "put_gamma"]] = .04
        result = self.compare(frame)
        self.assertGreater(result.gex_gross, 0.)
        self.assertEqual(result.gamma_concentration, 1.)
        # Changing call/put ownership proxies cannot change unsigned concentration.
        swapped = frame.copy()
        swapped["call_oi"], swapped["put_oi"] = frame["put_oi"], frame["call_oi"]
        self.assertEqual(self.compare(swapped).gamma_concentration, result.gamma_concentration)

    def test_rank_deficient_strike_geometry_is_not_an_identified_iv_fit(self):
        frame = structure_chain()
        frame["strike"] = 100.
        result = self.compare(frame)
        self.assertEqual(result.iv_fit_coverage, 0.)
        self.assertEqual(result.iv_coverage, 1.)
        self.assertEqual(result.iv_term_coverage, 1.)

    def test_one_sided_iv_does_not_fabricate_two_sided_skew(self):
        frame = structure_chain().drop(columns=["put_iv"])
        result = self.compare(frame)
        self.assertEqual(result.iv_coverage, 1.)
        self.assertEqual(result.iv_skew_coverage, 0.)
        self.assertEqual(result.iv_skew, 0.)
        self.assertEqual(result.iv_term_coverage, 1.)


if __name__ == "__main__":
    unittest.main()
