from __future__ import annotations

import json
import math
import os
from pathlib import Path
import subprocess
import unittest
from dataclasses import replace

import numpy as np

from option_wave._backend import HAS_CPP_CORE, cpp_core
from option_wave.model import PDEConfig, _advance_pde, _evolve_pde


class PDEStabilityTests(unittest.TestCase):
    def test_constant_solution_and_exact_fractional_horizon(self):
        observed = np.full((3, 5), 0.4)
        result = _evolve_pde(observed, np.ones_like(observed), np.array([0, 0.002, 0.011, 0.05, 0.12]),
            np.array([0, 1, 3]), PDEConfig(decay=0, distance_drift=0.004), [0.25, 1.5, 10.25], True)
        np.testing.assert_allclose(result["field"], 0.4, rtol=0, atol=2e-12)
        np.testing.assert_allclose(result["integrals"], np.array([0.25, 1.5, 10.25]) * 0.4, rtol=0, atol=2e-11)
        self.assertEqual(len(result["scores"]), 12)

    def test_neumann_boundary_matches_exact_linear_system(self):
        config = PDEConfig(distance_diffusion=1, expiry_diffusion=0, decay=0, source_strength=0)
        observed = np.array([[1.0, 0.0, 0.0]])
        result = _advance_pde(observed, observed, np.array([0.0, 0.5, 1.0]), np.array([0.0]), config, 0.25)
        np.testing.assert_allclose(result, [[7 / 15, 1 / 5, 2 / 15]], rtol=0, atol=1e-14)

    def test_stiff_high_frequency_mode_damped_without_clipping(self):
        coordinates = np.arange(257, dtype=float) * 0.0001
        observed = (0.6 * np.where(np.arange(257) % 2, -1, 1))[None, :]
        config = PDEConfig(expiry_diffusion=0, decay=0, source_strength=0)
        result = _advance_pde(observed, observed, coordinates, np.array([0]), config, 1)
        self.assertLess(float(np.max(np.abs(result))), 2e-7)

    def test_irregular_grid_diffusion_conserves_cell_weighted_score(self):
        coordinates = np.array([0.0, 0.002, 0.011, 0.05, 0.12])
        widths = 0.5 * (np.r_[0, np.diff(coordinates)] + np.r_[np.diff(coordinates), 0])
        observed = np.array([[1.0, 0.0, -0.4, 0.2, -0.3]])
        config = PDEConfig(expiry_diffusion=0, decay=0, source_strength=0)
        result = _evolve_pde(observed, widths[None, :], coordinates, np.array([0]), config, [5])
        self.assertAlmostEqual(float(np.sum(result["field"] * widths)), float(np.sum(observed * widths)), places=13)
        self.assertEqual(result["scores"].size, 0)

    def test_coordinate_scale_and_coefficient_units(self):
        coordinates = np.array([0.0, 0.002, 0.011, 0.05, 0.12])
        observed = np.array([[1.0, 0.0, -0.4, 0.2, -0.3]])
        config = PDEConfig(distance_drift=0.004, timestep_minutes=0.5)
        result = _evolve_pde(observed, np.ones_like(observed), coordinates, np.array([0]), config, [3])
        scaled = _evolve_pde(observed, np.ones_like(observed), coordinates * 100, np.array([0]),
            replace(config, distance_diffusion=config.distance_diffusion * 100**2, distance_drift=config.distance_drift * 100), [3])
        np.testing.assert_allclose(result["field"], scaled["field"], rtol=0, atol=1e-12)

    def test_source_decay_and_time_step_convergence(self):
        observed = np.array([[0.7]])
        errors = []
        config = PDEConfig(decay=0.2, source_strength=0.1)
        exact = 0.7 * (1 / 3 + (2 / 3) * math.exp(-0.3 * 3))
        for dt in (0.5, 0.25, 0.125):
            result = _evolve_pde(observed, np.ones_like(observed), np.array([0]), np.array([0]),
                replace(config, timestep_minutes=dt), [3])
            errors.append(abs(float(result["field"][0, 0]) - exact))
        self.assertGreater(errors[0] / errors[1], 1.8)
        self.assertGreater(errors[1] / errors[2], 1.8)

    def test_maximum_principle_both_drift_directions(self):
        observed = np.array([[0.0, 1.0, 0.0]])
        for drift in (-20.0, 20.0):
            result = _advance_pde(observed, observed, np.array([0, 0.01, 1]), np.array([0]),
                PDEConfig(distance_drift=drift), 100)
            self.assertTrue(np.all(result >= 0.0))
            self.assertTrue(np.all(result <= 1.0))

    def test_large_finite_weights_do_not_overflow_and_zero_weights_are_uniform(self):
        observed = np.array([[0.2, 0.8]])
        config = PDEConfig(distance_diffusion=0, expiry_diffusion=0, decay=0, source_strength=0)
        for weights in (np.full_like(observed, 1e308), np.zeros_like(observed)):
            result = _evolve_pde(observed, weights, np.array([0, 1]), np.array([0]), config, [1])
            self.assertAlmostEqual(result["averages"][0], 0.5, places=14)

    def test_invalid_coordinates_coefficients_and_workload_rejected(self):
        observed = np.array([[0.0, 0.1]])
        for coordinates in ([0, 0], [1, 0], [0, np.inf], [0, np.nan]):
            with self.subTest(coordinates=coordinates), self.assertRaises(ValueError):
                _advance_pde(observed, observed, np.asarray(coordinates), np.array([0]), PDEConfig(), 1)
        for name in ("distance_diffusion", "expiry_diffusion", "decay", "source_strength"):
            for value in (-1.0, np.inf, np.nan):
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    _advance_pde(observed, observed, np.array([0, 1]), np.array([0]), replace(PDEConfig(), **{name: value}), 1)
        for dt in (-1, 0, np.nan, np.inf, 1e-9):
            with self.subTest(dt=dt), self.assertRaises(ValueError):
                _evolve_pde(observed, np.ones_like(observed), np.array([0, 1]), np.array([0]),
                    PDEConfig(timestep_minutes=dt), [1])
        for horizons in ([], [0], [-1], [np.nan], [np.inf], [1] * 10001):
            with self.subTest(horizon_count=len(horizons)), self.assertRaises(ValueError):
                _evolve_pde(observed, np.ones_like(observed), np.array([0, 1]), np.array([0]), PDEConfig(), horizons)
        with self.assertRaises(ValueError):
            _evolve_pde(observed, -np.ones_like(observed), np.array([0, 1]), np.array([0]), PDEConfig(), [1])
        with self.assertRaises(ValueError):
            _evolve_pde(np.full_like(observed, 2), np.ones_like(observed), np.array([0, 1]), np.array([0]), PDEConfig(), [1])
        with self.assertRaises(ValueError):
            _evolve_pde(np.zeros((1, 101)), np.ones((1, 101)), np.arange(101), np.array([0]), PDEConfig(), [1_000_000])


class PDEBackendParityTests(unittest.TestCase):
    @staticmethod
    def fixture():
        observed = np.array([[0.1, -0.5, 0.8, 0.2], [0.9, -0.7, -0.2, 0.4], [-0.6, 0.3, -0.1, 0.7]])
        weights = np.array([[1, 2, 3, 4], [2, 0, 1, 5], [4, 2, 1, 3]], dtype=float)
        distances = np.array([0.0, 0.002, 0.03, 0.09])
        expiries = np.array([0.0, 1.0, 7.0])
        config = PDEConfig(distance_drift=-0.007, timestep_minutes=0.7)
        horizons = [2.25, 0.25, 1.4, 2.25]
        return observed, weights, distances, expiries, config, horizons

    def assert_result_matches(self, actual):
        expected = _evolve_pde(*self.fixture(), retain_scores=True)
        for key in expected:
            np.testing.assert_allclose(np.asarray(actual[key]).ravel(), expected[key].ravel(), rtol=0, atol=2e-12,
                err_msg=f"native/reference mismatch: {key}")

    @unittest.skipUnless(HAS_CPP_CORE, "compiled extension is not installed")
    def test_binding_matches_python_reference(self):
        observed, weights, distances, expiries, config, horizons = self.fixture()
        actual = cpp_core.evolve_field(observed.ravel(), weights.ravel(), distances, expiries,
            config.distance_diffusion, config.expiry_diffusion, config.distance_drift,
            config.decay, config.source_strength, config.timestep_minutes, horizons)
        self.assert_result_matches(actual)

    def test_independent_cpp_kernel_matches_python_reference(self):
        executable = Path(os.environ.get("PDE_TEST_BINARY", Path(__file__).resolve().parents[1] / "build/pde-tests/cpp_pde_stability_test.exe"))
        if not executable.is_file():
            self.skipTest("independent PDE kernel test binary has not been built")
        completed = subprocess.run([str(executable), "--fixture"], check=True, capture_output=True, text=True, timeout=15)
        self.assert_result_matches(json.loads(completed.stdout))


if __name__ == "__main__":
    unittest.main()
