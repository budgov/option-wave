from __future__ import annotations

from dataclasses import dataclass, replace
from math import exp, expm1, sqrt
from statistics import NormalDist
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from option_wave._backend import cpp_core
from option_wave.model import Expectation
from option_wave.contract import (
    ContractAssessment,
    STANDARD_EQUITY_OPTION_UNIT_ASSUMPTIONS,
    assess_contract,
    assess_contract_value,
)


@dataclass(frozen=True)
class _Expectation:
    expected_return: float
    return_variance: float
    expected_price: float


class _Result:
    trend_score = 0.40
    confidence = 0.80
    expectations = {
        30.0: _Expectation(
            expected_return=0.01,
            return_variance=0.0004,
            expected_price=101.0,
        )
    }


def _complete_contract() -> dict[str, object]:
    return {
        "option_type": "call",
        "underlying_price": 100.0,
        "bid": 1.0,
        "ask": 1.1,
        "delta": 0.50,
        "gamma": 0.02,
        "theta": -0.10,
        "vega": 0.10,
        "iv": 0.25,
        "round_trip_fee_per_contract": 1.30,
        "contract_multiplier": 100.0,
        "unit_assumptions": dict(STANDARD_EQUITY_OPTION_UNIT_ASSUMPTIONS),
    }


class ContractValueOverlayTests(unittest.TestCase):
    def test_shadow_value_overlay_calculates_auditable_greek_components(self) -> None:
        assessment = assess_contract(_Result(), _complete_contract(), horizon_minutes=30.0)
        overlay = assessment.value_overlay

        self.assertIsNotNone(overlay)
        assert overlay is not None
        self.assertEqual(overlay.deployment_status, "shadow_only")
        self.assertEqual(overlay.status, "available")
        self.assertEqual(overlay.decision, "diagnostic_only")
        self.assertEqual(overlay.data_completeness, 1.0)
        self.assertEqual(assessment.decision, "support")

        base = overlay.base_iv_stress
        bull = overlay.bull_iv_stress
        bear = overlay.bear_iv_stress
        assert base is not None and bull is not None and bear is not None
        self.assertAlmostEqual(base.delta_component, 0.50)
        self.assertAlmostEqual(base.gamma_component, 0.05)
        self.assertAlmostEqual(base.theta_component, -0.10 * 30.0 / 390.0)
        self.assertAlmostEqual(base.round_trip_spread_cost, 0.10)
        self.assertAlmostEqual(base.round_trip_fee_per_share, 0.013)
        self.assertAlmostEqual(base.net_edge_after_spread, 0.4293076923076923)
        self.assertAlmostEqual(overlay.net_edge_after_spread, base.net_edge_after_spread)
        self.assertAlmostEqual(bull.vega_component, 0.20)
        self.assertAlmostEqual(bear.vega_component, -0.20)
        self.assertGreater(bull.net_edge_after_spread, base.net_edge_after_spread)
        self.assertLess(bear.net_edge_after_spread, base.net_edge_after_spread)

        serialized = assessment.to_dict()
        self.assertEqual(serialized["value_overlay"]["status"], "available")
        self.assertIn("net_edge_after_spread", serialized["value_overlay"]["base_iv_stress"])

    def test_missing_greek_or_unit_metadata_abstains_without_changing_legacy_score(self) -> None:
        contract = _complete_contract()
        contract.pop("vega")
        contract.pop("unit_assumptions")

        assessment = assess_contract(_Result(), contract, horizon_minutes=30.0)
        overlay = assessment.value_overlay

        self.assertEqual(assessment.decision, "support")
        assert overlay is not None
        self.assertEqual(overlay.status, "unavailable")
        self.assertEqual(overlay.decision, "abstain")
        self.assertIsNone(overlay.net_edge_after_spread)
        self.assertLess(overlay.data_completeness, 1.0)
        self.assertIn("missing_vega", overlay.reasons)
        self.assertIn("missing_unit_assumptions", overlay.reasons)

    def test_ambiguous_vega_units_are_not_silently_converted(self) -> None:
        contract = _complete_contract()
        units = dict(STANDARD_EQUITY_OPTION_UNIT_ASSUMPTIONS)
        units["vega"] = "unknown_vendor_units"
        contract["unit_assumptions"] = units

        overlay = assess_contract_value(_Result(), contract, horizon_minutes=30.0)

        self.assertEqual(overlay.status, "unavailable")
        self.assertIn("unsupported_or_ambiguous_unit_assumptions", overlay.reasons)

    def test_requested_horizon_must_exist_in_ocean_wave_result(self) -> None:
        overlay = assess_contract_value(_Result(), _complete_contract(), horizon_minutes=15.0)

        self.assertEqual(overlay.status, "unavailable")
        self.assertEqual(overlay.horizon_minutes, 15.0)
        self.assertIn("forecast_horizon_unavailable", overlay.reasons)

    def test_iv_stress_cannot_imply_negative_iv(self) -> None:
        contract = _complete_contract()
        contract["iv"] = 0.01

        overlay = assess_contract_value(
            _Result(),
            contract,
            horizon_minutes=30.0,
            iv_stress_decimal={"base": 0.0, "bull": 0.02, "bear": -0.02},
        )

        self.assertEqual(overlay.status, "unavailable")
        self.assertIn("iv_stress_would_make_iv_negative", overlay.reasons)

    def test_contract_assessment_positional_constructor_remains_compatible(self) -> None:
        assessment = ContractAssessment("call", 1, 0.2, 0.1, 0.05, 0.8, 0.16, "support", ())

        self.assertIsNone(assessment.value_overlay)

    def test_ocean_wave_price_variance_is_converted_to_simple_return_units(self) -> None:
        log_mean, log_variance, spot = 0.015, 0.02, 100.0
        expected_price = spot * exp(log_mean + 0.5 * log_variance)
        expectation = Expectation(30.0, 0.0, 0.0, expected_price / spot - 1.0,
            expected_price, log_variance, expected_price**2 * expm1(log_variance), 0.75)
        result = SimpleNamespace(expectations={30.0: expectation})
        overlay = assess_contract_value(result, _complete_contract())

        expected_simple_variance = expectation.price_variance / spot**2
        self.assertEqual(overlay.status, "available")
        self.assertEqual(overlay.return_variance_source, "price_variance_divided_by_spot_squared")
        self.assertAlmostEqual(overlay.underlying_return_variance, expected_simple_variance, places=14)
        self.assertGreater(abs(expected_simple_variance - log_variance), 0.001)
        self.assertAlmostEqual(overlay.base_iv_stress.gamma_component,
            0.5 * 0.02 * spot**2 * (expected_simple_variance + expectation.expected_return**2), places=12)
        legacy = assess_contract_value(_Result(), _complete_contract())
        self.assertEqual(legacy.return_variance_source, "declared_simple_return")
        self.assertEqual(legacy.underlying_return_variance, 0.0004)

    def test_explicit_invalid_price_variance_does_not_fall_back_to_log_variance(self) -> None:
        for price_variance in (None, -1.0, float("nan"), float("inf")):
            expectation = SimpleNamespace(expected_return=0.01, expected_price=101,
                return_variance=0.0004, price_variance=price_variance)
            with self.subTest(price_variance=price_variance):
                overlay = assess_contract_value(SimpleNamespace(expectations={30.0: expectation}), _complete_contract())
                self.assertEqual(overlay.status, "unavailable")
                self.assertIn("missing_or_invalid_price_variance", overlay.reasons)
                self.assertIsNone(overlay.base_iv_stress)

    @unittest.skipUnless(cpp_core is not None and hasattr(cpp_core, "option_profit_probability"), "upgraded native core unavailable")
    def test_call_and_put_profit_probabilities_include_theta_spread_and_fees(self) -> None:
        result = SimpleNamespace(expectations={30.0: _Expectation(0.0, 0.0004, 100.0)})
        normal = NormalDist(mu=0.0, sigma=0.02)
        for option_type, delta in (("call", 0.5), ("put", -0.5)):
            contract = {**_complete_contract(), "option_type": option_type, "delta": delta, "gamma": 0.0}
            overlay = assess_contract_value(result, contract)
            base, bull, bear = overlay.base_iv_stress, overlay.bull_iv_stress, overlay.bear_iv_stress
            cost = 0.1 + 0.013 + 0.1 * 30 / 390
            expected_probability = normal.cdf(-cost / 50.0)
            self.assertAlmostEqual(base.probability_profit_after_costs, expected_probability, places=14)
            self.assertLess(base.probability_profit_after_costs, 0.5)
            self.assertGreater(base.probability_profit_before_fees, base.probability_profit_after_costs)
            self.assertGreater(bull.probability_profit_after_costs, base.probability_profit_after_costs)
            self.assertLess(bear.probability_profit_after_costs, base.probability_profit_after_costs)

    @unittest.skipUnless(cpp_core is not None and hasattr(cpp_core, "option_profit_probability"), "upgraded native core unavailable")
    def test_quadratic_gamma_profit_probability_matches_gaussian_tail(self) -> None:
        result = SimpleNamespace(expectations={30.0: _Expectation(0.0, 0.0004, 100.0)})
        contract = {**_complete_contract(), "delta": 0.0, "theta": 0.0, "vega": 0.0}
        overlay = assess_contract_value(result, contract)
        threshold = sqrt((0.1 + 0.013) / (0.5 * 0.02 * 100**2))
        expected = 2.0 * NormalDist(0.0, 0.02).cdf(-threshold)
        self.assertAlmostEqual(overlay.base_iv_stress.probability_profit_after_costs, expected, places=14)

    @unittest.skipUnless(cpp_core is not None and hasattr(cpp_core, "option_profit_probability"), "upgraded native core unavailable")
    def test_zero_variance_deterministic_profit_is_strictly_positive(self) -> None:
        contract = {**_complete_contract(), "bid": 1.0, "ask": 1.0, "theta": 0.0,
            "vega": 0.0, "gamma": 0.0, "round_trip_fee_per_contract": 0.0}
        for mean_return, expected in ((-0.01, 0.0), (0.0, 0.0), (0.01, 1.0)):
            result = SimpleNamespace(expectations={30.0: _Expectation(mean_return, 0.0, 100 * (1 + mean_return))})
            overlay = assess_contract_value(result, contract)
            self.assertEqual(overlay.base_iv_stress.probability_profit_after_costs, expected)

    def test_missing_greeks_or_fees_never_call_native_probability(self) -> None:
        for missing in ("delta", "gamma", "theta", "vega", "round_trip_fee_per_contract", "contract_multiplier", "unit_assumptions"):
            contract = _complete_contract()
            contract.pop(missing)
            native = Mock()
            with self.subTest(missing=missing), patch("option_wave.contract.cpp_core", native):
                overlay = assess_contract_value(_Result(), contract)
                self.assertEqual(overlay.status, "unavailable")
                self.assertIsNone(overlay.base_iv_stress)
                native.option_profit_probability.assert_not_called()

    def test_unsupported_native_ranges_return_unavailable_before_call(self) -> None:
        for name, value in (
            ("underlying_price", 1e8), ("delta", 1.01), ("gamma", 10001),
            ("vega", 1e8), ("theta", 1e12), ("round_trip_fee_per_contract", 1e12),
            ("contract_multiplier", 1e-300), ("ask", 1e9), ("delta", True),
            ("gamma", 10**1000),
        ):
            contract = {**_complete_contract(), name: value}
            native = Mock()
            with self.subTest(name=name), patch("option_wave.contract.cpp_core", native):
                overlay = assess_contract_value(_Result(), contract)
                self.assertEqual(overlay.status, "unavailable")
                native.option_profit_probability.assert_not_called()
        for field_name, value in (("expected_return", 3), ("return_variance", 4.01)):
            expectation = replace(_Result.expectations[30.0], **{field_name: value})
            overlay = assess_contract_value(SimpleNamespace(expectations={30.0: expectation}), _complete_contract())
            self.assertEqual(overlay.status, "unavailable")
        overlay = assess_contract_value(_Result(), _complete_contract(),
            iv_stress_decimal={"base": 0.0, "bull": 11.0, "bear": 0.0})
        self.assertEqual(overlay.status, "unavailable")
        self.assertIn("unsupported_iv_stress_range", overlay.reasons)

    def test_native_error_or_invalid_probability_is_an_unavailable_overlay(self) -> None:
        for reply in (RuntimeError("unsupported native input"),
            {"available": True, "probability_profit": float("nan")},
            {"available": True, "probability_profit": 1.1},
            {"available": False, "probability_profit": 0.5}):
            native = Mock()
            if isinstance(reply, Exception):
                native.option_profit_probability.side_effect = reply
            else:
                native.option_profit_probability.return_value = reply
            with self.subTest(reply=reply), patch("option_wave.contract.cpp_core", native):
                overlay = assess_contract_value(_Result(), _complete_contract())
                self.assertEqual(overlay.status, "unavailable")
                self.assertEqual(overlay.decision, "abstain")
                self.assertIn("native_profit_probability_unavailable", overlay.reasons)
                self.assertIsNone(overlay.net_edge_after_spread)

    def test_missing_native_core_does_not_substitute_direction_probability(self) -> None:
        result = SimpleNamespace(expectations=_Result.expectations, raw_probability=0.99)
        with patch("option_wave.contract.cpp_core", None):
            overlay = assess_contract_value(result, _complete_contract())
        self.assertEqual(overlay.status, "available")
        self.assertIsNone(overlay.base_iv_stress.probability_profit_before_fees)
        self.assertIsNone(overlay.base_iv_stress.probability_profit_after_costs)

    def test_zero_fees_reuse_the_identical_native_result(self) -> None:
        native = Mock()
        native.option_profit_probability.return_value = {"available": True, "probability_profit": 0.42}
        contract = {**_complete_contract(), "round_trip_fee_per_contract": 0.0}
        with patch("option_wave.contract.cpp_core", native):
            overlay = assess_contract_value(_Result(), contract)
        self.assertEqual(native.option_profit_probability.call_count, 3)
        self.assertEqual(overlay.base_iv_stress.probability_profit_before_fees, 0.42)
        self.assertEqual(overlay.base_iv_stress.probability_profit_after_costs, 0.42)


if __name__ == "__main__":
    unittest.main()
