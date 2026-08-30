from __future__ import annotations

from dataclasses import dataclass
import unittest

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


if __name__ == "__main__":
    unittest.main()
