from __future__ import annotations

import itertools
import unittest
from unittest.mock import patch

import numpy as np

from option_wave import MarketState, OceanWave
from option_wave._backend import HAS_CPP_CORE, cpp_core
from option_wave.factors import DEFAULT_FACTOR_PRIORS, FACTOR_NAMES, FactorConfig, FactorState, adaptive_blend, stock_confirmation
from tests.test_actionability import complete_state, symmetric_chain


def hessian(covariance: np.ndarray, config: FactorConfig) -> np.ndarray:
    diagonal = np.maximum(np.diag(covariance), 1e-12)
    correlation = np.clip(covariance / np.sqrt(np.outer(diagonal, diagonal)), -1.0, 1.0)
    np.fill_diagonal(correlation, 1.0)
    redundancy = (1.0 - config.covariance_shrinkage) * correlation ** 2
    redundancy += config.covariance_shrinkage * np.eye(len(diagonal))
    return (1.0-config.correlation_penalty) * np.eye(len(diagonal)) + config.correlation_penalty * redundancy


def active_set_oracle(matrix: np.ndarray, upper: np.ndarray) -> np.ndarray:
    """Independent exhaustive KKT oracle, only used for tiny three-factor tests."""
    for status in itertools.product((-1, 0, 1), repeat=len(upper)):
        candidate = np.where(np.asarray(status) == 1, upper, 0.0)
        free = np.flatnonzero(np.asarray(status) == 0)
        fixed = np.flatnonzero(np.asarray(status) != 0)
        if free.size:
            candidate[free] = np.linalg.solve(
                matrix[np.ix_(free, free)], upper[free] - matrix[np.ix_(free, fixed)] @ candidate[fixed]
            )
        if np.any(candidate < -1e-10) or np.any(candidate > upper + 1e-10):
            continue
        gradient = matrix @ candidate - upper
        projected = candidate - np.clip(candidate - gradient, 0.0, upper)
        if np.max(np.abs(projected)) < 1e-9:
            return candidate
    raise AssertionError("no feasible KKT solution")


class FactorBudgetTests(unittest.TestCase):
    def test_cold_start_family_budgets_are_not_legacy_weights(self) -> None:
        self.assertEqual(FACTOR_NAMES, ("premium_elo", "iv_surface", "stock_confirmation",
                                     "inverse_confirmation", "gold", "treasury_10y", "dollar_index", "vix"))
        self.assertEqual(DEFAULT_FACTOR_PRIORS, (.125, .125, .25, .25, .0625, .0625, .0625, .0625))
        with self.assertRaises(ValueError):
            FactorConfig(priors=(1.0,) * 8)
        partial = FactorConfig(names=("one", "two"), priors=(.2, .3))
        self.assertEqual(partial.priors, (.2, .3))

    def test_only_elo_cannot_inherit_other_budgets(self) -> None:
        config = FactorConfig()
        blended = adaptive_blend(np.ones(8), [1, 0, 0, 0, 0, 0, 0, 0], FactorState.create(config), config)
        self.assertLessEqual(blended.weights[0], .125)
        np.testing.assert_array_equal(blended.weights[1:], np.zeros(7))
        self.assertAlmostEqual(blended.signal + blended.neutral_weight, 1.0)
        self.assertAlmostEqual(blended.weights[0], .125, msg="a factor cannot be penalized for correlation with itself")
        self.assertAlmostEqual(blended.neutral_weight, .875)

    def test_quality_reduces_evidence_once_not_twice(self) -> None:
        config = FactorConfig()
        for native in (True, False):
            with patch("option_wave.factors.HAS_CPP_CORE", HAS_CPP_CORE and native):
                blended = adaptive_blend(np.ones(8), [.5, 0, 0, 0, 0, 0, 0, 0], FactorState.create(config), config)
            self.assertAlmostEqual(blended.weights[0], .0625)
            self.assertAlmostEqual(blended.confidence, .0625)
        for penalty in (1., 1.1, -0.1):
            with self.assertRaises(ValueError):
                FactorConfig(correlation_penalty=penalty)

    def test_all_missing_is_neutral_and_does_not_erase_uncertainty(self) -> None:
        config = FactorConfig()
        state = FactorState.create(config)
        state.count = 20.0
        covariance = state.covariance.copy()
        blended = adaptive_blend(np.ones(8), np.zeros(8), state, config)
        np.testing.assert_array_equal(blended.weights, np.zeros(8))
        np.testing.assert_array_equal(state.covariance, covariance)
        self.assertEqual(state.count, 20.0)
        self.assertEqual((blended.signal, blended.confidence, blended.neutral_weight), (0.0, 0.0, 1.0))

    def test_nan_and_negative_correlation_cannot_restore_missing_factors(self) -> None:
        config = FactorConfig()
        state = FactorState.create(config)
        state.covariance[0, 1] = state.covariance[1, 0] = -.24
        values = np.ones(8)
        values[2] = np.nan
        quality = [1, 0, 1, 0, 0, 0, 0, 0]
        blended = adaptive_blend(values, quality, state, config)
        np.testing.assert_array_equal(blended.weights[1:], np.zeros(7))
        self.assertTrue(np.isfinite(blended.signal))

    def test_masked_covariance_stays_psd_and_absent_diagonal_stays_fixed(self) -> None:
        config = FactorConfig()
        state = FactorState.create(config)
        rng = np.random.default_rng(827)
        for _ in range(100):
            blended = adaptive_blend(rng.uniform(-1, 1, 8), [1, 1, 1, 1, 0, 0, 0, 0], state, config)
            self.assertGreaterEqual(np.linalg.eigvalsh(state.covariance).min(), -1e-12)
            self.assertLessEqual(blended.weights.sum(), 1.0)
            self.assertTrue(np.all(blended.weights <= np.asarray(config.priors) + 1e-12))
        np.testing.assert_array_equal(np.diag(state.covariance)[4:], np.full(4, .25))

    def test_qp_matches_independent_active_set_and_kkt_conditions(self) -> None:
        config = FactorConfig(names=("a", "b", "c"), priors=(.2, .3, .5), correlation_penalty=.95)
        rng = np.random.default_rng(912)
        for _ in range(20):
            state = FactorState.create(config)
            design = rng.normal(size=(3, 4))
            state.covariance = design @ design.T + .01 * np.eye(3)
            quality = rng.uniform(0.1, 1.0, 3)
            blended = adaptive_blend(rng.uniform(-1, 1, 3), quality, state, config)
            matrix = hessian(state.covariance, config)
            upper = np.asarray(config.priors) * quality
            expected = active_set_oracle(matrix, upper)
            np.testing.assert_allclose(blended.weights, expected, atol=1e-10, rtol=1e-10)
            self.assertLess(blended.kkt_residual, 1e-9)

    @unittest.skipUnless(HAS_CPP_CORE and hasattr(cpp_core, "blend_factor_budgets"), "new native budget kernel unavailable")
    def test_native_and_reference_budget_solver_match(self) -> None:
        config = FactorConfig()
        native_state = FactorState.create(config)
        reference_state = FactorState.create(config)
        rng = np.random.default_rng(161)
        for _ in range(50):
            values = rng.uniform(-1, 1, 8)
            quality = rng.uniform(0, 1, 8)
            quality[rng.random(8) < .3] = 0.0
            native = adaptive_blend(values, quality, native_state, config)
            with patch("option_wave.factors.HAS_CPP_CORE", False):
                reference = adaptive_blend(values, quality, reference_state, config)
            np.testing.assert_allclose(native.weights, reference.weights, atol=1e-12, rtol=1e-12)
            np.testing.assert_allclose(native_state.covariance, reference_state.covariance, atol=1e-12, rtol=1e-12)
            self.assertAlmostEqual(native.signal, reference.signal, places=12)
            self.assertAlmostEqual(native.confidence, reference.confidence, places=12)

    def test_legacy_state_resets_deleted_covariance_but_preserves_elo(self) -> None:
        model = OceanWave()
        model.predict(symmetric_chain(), complete_state())
        old = model.state_dict()
        ratings = old["ratings"]
        old.update(schema_version="ocean-wave-state.v1", factor_state={"mean": [9.] * 9,
                   "covariance": (np.eye(9) * 99).tolist(), "count": 1000})
        restored = OceanWave()
        restored.load_state_dict(old)
        migrated = restored.state_dict()
        self.assertEqual(migrated["ratings"], ratings)
        self.assertEqual(migrated["schema_version"], "ocean-wave-state.v3")
        self.assertEqual(migrated["factor_state"]["count"], 0.0)
        self.assertEqual(migrated["factor_names"], list(FACTOR_NAMES))
        self.assertIn("v1_factor_covariance_reset", migrated["state_migration"])
        duplicate = OceanWave()
        duplicate.load_state_dict(migrated)
        self.assertEqual(duplicate.state_dict(), migrated)

    def test_v2_state_migration_preserves_only_validated_elo(self) -> None:
        model = OceanWave()
        model.predict(symmetric_chain(), complete_state())
        payload = model.state_dict()
        payload.update(schema_version="ocean-wave-state.v2", weighting_scheme="bounded-correlation-budget.v1")
        restored = OceanWave()
        restored.load_state_dict(payload)
        migrated = restored.state_dict()
        self.assertEqual(migrated["ratings"], payload["ratings"])
        self.assertEqual(migrated["factor_state"]["count"], 0.)
        self.assertIn("v2_factor_covariance_reset", migrated["state_migration"])
        payload["factor_state"]["covariance"][0][0] = -1.
        with self.assertRaises(ValueError):
            OceanWave().load_state_dict(payload)

    def test_state_rejects_changed_names_and_indefinite_covariance(self) -> None:
        payload = OceanWave().state_dict()
        payload["factor_names"][0] = "institutional_flow"
        with self.assertRaises(ValueError):
            OceanWave().load_state_dict(payload)
        payload = OceanWave().state_dict()
        payload["factor_state"]["covariance"][0][0] = -1.0
        with self.assertRaises(ValueError):
            OceanWave().load_state_dict(payload)

    def test_macro_missing_has_zero_weight_and_risk_does_not_invent_direction(self) -> None:
        baseline = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,))
        stressed = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,),
                                      market_context={"macro_signals": {"gold": None, "vix": None},
                                                      "macro_confidences": {"gold": 1., "vix": 1.}, "risk_multiplier": 2.0})
        rows = stressed.factor_table.set_index("factor")
        self.assertEqual(float(rows.loc[["gold", "treasury_10y", "dollar_index", "vix"], "dynamic_weight"].sum()), 0.0)
        self.assertEqual(stressed.trend_score, baseline.trend_score)
        # Public values are independently rounded to 12 decimals; scaling the
        # rounded baseline can differ by 1.5 units in the final decimal place.
        self.assertAlmostEqual(stressed.expectations[30.].return_variance,
                               2 * baseline.expectations[30.].return_variance, delta=1.5e-12)

    def test_macro_and_inverse_budget_are_used_only_with_valid_evidence(self) -> None:
        result = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,), market_context={
            "inverse_signal": -.7, "inverse_confidence": 1., "inverse_symbol": "SQQQ",
            "macro_signals": {"gold": .2, "treasury_10y": -.3, "dollar_index": -.1, "vix": -.4},
            "macro_confidences": {"gold": 1., "treasury_10y": 1., "dollar_index": 1., "vix": 1.},
        })
        rows = result.factor_table.set_index("factor")
        for name in ("gold", "treasury_10y", "dollar_index", "vix"):
            self.assertGreater(rows.loc[name, "dynamic_weight"], 0.0)
            self.assertLessEqual(rows.loc[name, "dynamic_weight"], .0625)
        self.assertGreater(rows.loc["inverse_confirmation", "dynamic_weight"], 0.0)
        self.assertEqual(result.diagnostics["inverse_symbols"], "SQQQ")
        self.assertEqual(result.diagnostics["inverse_count"], 1)
        self.assertIsNone(result.diagnostics["inverse_native_signal"])
        self.assertLessEqual(rows.loc["premium_elo", "dynamic_weight"], .125)

    def test_inverse_five_minute_return_uses_matching_volatility_units(self) -> None:
        model = OceanWave()
        inverse = MarketState(spot=10, previous_close=9, return_5m=-.006, realized_vol=.6)
        native, target, confidence = model._inverse_observation(None, inverse, -3.)
        expected = np.tanh(np.log1p(-.006) / -3 / (.2 * np.sqrt(5 / (252 * 390))))
        self.assertAlmostEqual(target, expected)
        self.assertLess(native, 0.)
        self.assertGreater(target, 0.)
        self.assertEqual(confidence, 1.)

    def test_rvol_alone_has_no_direction_or_confidence(self) -> None:
        for rvol in (.2, 1., 2., 10.):
            state = MarketState(spot=100., rvol=rvol)
            self.assertEqual(stock_confirmation(state), (0., 0.))
            with patch("option_wave.factors.HAS_CPP_CORE", False):
                self.assertEqual(stock_confirmation(state), (0., 0.))

    def test_rvol_cannot_change_sign_or_add_bullish_bias(self) -> None:
        for rvol in (None, .2, 1., 2., 10.):
            bullish = MarketState(spot=100., return_5m=.003, return_15m=.006, rvol=rvol)
            bearish = MarketState(spot=100., return_5m=-.003, return_15m=-.006, rvol=rvol)
            up, down = stock_confirmation(bullish), stock_confirmation(bearish)
            self.assertAlmostEqual(up[0], -down[0], places=12)
            self.assertEqual(up[1], down[1])
            with patch("option_wave.factors.HAS_CPP_CORE", False):
                reference_up, reference_down = stock_confirmation(bullish), stock_confirmation(bearish)
            np.testing.assert_allclose(up, reference_up, atol=1e-12, rtol=1e-12)
            np.testing.assert_allclose(down, reference_down, atol=1e-12, rtol=1e-12)

    def test_macro_risk_native_and_reference_expectations_match(self) -> None:
        context = {"inverse_signal": -.3, "inverse_confidence": .8, "risk_multiplier": 2.}
        native = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,), market_context=context)
        with patch("option_wave.model.HAS_CPP_CORE", False):
            reference = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,), market_context=context)
        for name in ("expected_price", "expected_return", "return_variance", "price_variance", "probability_up"):
            self.assertAlmostEqual(getattr(native.expectations[30.], name), getattr(reference.expectations[30.], name), places=10)

    def test_elo_spatial_surface_cannot_bypass_factor_budget(self) -> None:
        result = OceanWave().predict(symmetric_chain(), complete_state(), horizons_minutes=(30.,))
        weights = result.elo_surface["pair_weight"].to_numpy(float)
        raw_mean = np.average(result.elo_surface["pair_signal"].to_numpy(float), weights=weights)
        cap = result.factor_table.set_index("factor").loc["premium_elo", "dynamic_weight"]
        self.assertAlmostEqual(result.diagnostics["current_field_signal"], raw_mean * cap, places=10)
        self.assertEqual(result.diagnostics["elo_field_weight"], cap)


if __name__ == "__main__":
    unittest.main()
