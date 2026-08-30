from __future__ import annotations

import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from option_wave._backend import HAS_CPP_CORE, cpp_core
from option_wave.intraday_features import extract_intraday_price_features


@unittest.skipUnless(HAS_CPP_CORE, "compiled extension is not installed")
class IntradayFourierBindingTests(unittest.TestCase):
    @staticmethod
    def signal(sample_count: int = 64) -> np.ndarray:
        index = np.arange(sample_count, dtype=np.float64)
        return (
            0.001
            + 0.020 * np.cos(2.0 * np.pi * 4.0 * index / sample_count + 0.30)
            + 0.010 * np.cos(2.0 * np.pi * 7.0 * index / sample_count - 0.70)
        )

    def test_known_components_and_energy_are_extracted(self) -> None:
        values = self.signal()
        result = cpp_core.extract_intraday_fourier(values, len(values), 8, 1.0, False, False)

        self.assertEqual(cpp_core.FOURIER_MIN_SAMPLES, 8)
        self.assertEqual(cpp_core.FOURIER_MAX_SAMPLES, 4096)
        self.assertEqual(cpp_core.FOURIER_MAX_HARMONICS, 256)
        self.assertEqual(cpp_core.FOURIER_BAND_COUNT, 4)
        self.assertEqual(result["schema_version"], "intraday_fourier.v2")
        self.assertEqual(result["feature_version"], 2)
        self.assertTrue(result["causal_prefix"])
        self.assertEqual(result["detrend_strategy"], "causal_mean_only")
        self.assertEqual(result["taper_strategy"], "none")
        self.assertEqual(int(result["sample_count"]), 64)
        self.assertEqual(int(result["harmonic_count"]), 8)
        self.assertAlmostEqual(float(result["mean"]), 0.001, places=14)
        self.assertEqual(int(result["dominant_harmonic"]), 4)
        self.assertAlmostEqual(float(result["dominant_period"]), 16.0, places=12)
        self.assertAlmostEqual(float(result["explained_energy_fraction"]), 1.0, places=12)

        cosine = np.asarray(result["cosine_coefficients"])
        sine = np.asarray(result["sine_coefficients"])
        amplitude = np.asarray(result["amplitudes"])
        phase = np.asarray(result["phases"])
        self.assertAlmostEqual(float(cosine[3]), 0.020 * np.cos(0.30), places=13)
        self.assertAlmostEqual(float(sine[3]), -0.020 * np.sin(0.30), places=13)
        self.assertAlmostEqual(float(amplitude[3]), 0.020, places=13)
        self.assertAlmostEqual(float(phase[3]), 0.30, places=13)
        self.assertEqual(tuple(result["band_names"]), ("2_to_5m", "5_to_15m", "15_to_60m", "60_to_120m"))
        np.testing.assert_array_equal(result["band_period_lower_minutes"], [2.0, 5.0, 15.0, 60.0])
        np.testing.assert_array_equal(result["band_period_upper_minutes"], [5.0, 15.0, 60.0, 120.0])
        self.assertAlmostEqual(float(np.sum(result["band_energy_fraction"])), 1.0, places=13)

    def test_default_causal_detrend_hann_and_fixed_minute_bands(self) -> None:
        sample_count = 240
        minute = np.arange(sample_count, dtype=np.float64)
        values = (
            0.010 * np.cos(2.0 * np.pi * minute / 4.0 + 0.20)
            + 0.008 * np.cos(2.0 * np.pi * minute / 10.0 - 0.40)
            + 0.006 * np.cos(2.0 * np.pi * minute / 30.0 + 0.60)
            + 0.004 * np.cos(2.0 * np.pi * minute / 120.0 - 0.80)
        )
        result = cpp_core.extract_intraday_fourier(values, sample_count, 80, 1.0)

        self.assertTrue(result["linear_detrend"])
        self.assertTrue(result["hann_taper"])
        self.assertEqual(result["detrend_strategy"], "causal_ols_linear")
        self.assertEqual(result["taper_strategy"], "causal_prefix_hann")
        self.assertEqual(result["band_strategy"], "fixed_period_minutes_v1")
        self.assertEqual(result["lookahead_samples"], 0)
        self.assertEqual(result["period_unit"], "minutes")
        self.assertGreater(float(result["taper_coherent_gain"]), 0.0)
        self.assertLess(float(result["taper_coherent_gain"]), 1.0)
        self.assertGreater(float(result["taper_power_gain"]), 0.0)
        self.assertTrue(np.all(np.asarray(result["band_energy"]) > 0.0))
        self.assertAlmostEqual(
            float(result["dominant_phase_sine"]) ** 2
            + float(result["dominant_phase_cosine"]) ** 2,
            1.0,
            places=12,
        )
        self.assertAlmostEqual(
            float(result["dominant_phase_sine"]),
            float(np.sin(result["dominant_phase"])),
            places=13,
        )

    def test_explicit_prefix_ignores_future_buffer_values(self) -> None:
        prefix = self.signal()
        first = np.concatenate((prefix, np.full(64, np.nan, dtype=np.float64)))
        second = np.concatenate((prefix, np.linspace(1_000.0, 2_000.0, 64, dtype=np.float64)))
        first_result = cpp_core.extract_intraday_fourier(first, 64, 8, 1.0)
        second_result = cpp_core.extract_intraday_fourier(second, 64, 8, 1.0)

        for key in (
            "frequencies", "periods", "cosine_coefficients", "sine_coefficients",
            "amplitudes", "phases", "power", "band_energy",
        ):
            np.testing.assert_array_equal(first_result[key], second_result[key])

    def test_boundary_rejects_unsafe_or_ambiguous_arrays(self) -> None:
        valid = self.signal()
        with self.assertRaises((RuntimeError, TypeError)):
            cpp_core.extract_intraday_fourier(valid.astype(np.float32), 64, 8, 1.0)
        with self.assertRaises((RuntimeError, TypeError)):
            cpp_core.extract_intraday_fourier(valid[::2], 32, 8, 1.0)
        with self.assertRaises((RuntimeError, TypeError)):
            cpp_core.extract_intraday_fourier(valid.tolist(), 64, 8, 1.0)
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(valid, 7, 8, 1.0)
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(valid, 65, 8, 1.0)
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(valid, 64, 257, 1.0)
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(valid, 64, 8, float("nan"))
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(valid, 64, 8, 1e-10)
        poisoned = valid.copy()
        poisoned[12] = np.inf
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(poisoned, 64, 8, 1.0)
        poisoned = valid.copy()
        poisoned[12] = 11.0
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(poisoned, 64, 8, 1.0)
        with self.assertRaises(RuntimeError):
            cpp_core.extract_intraday_fourier(np.zeros(4097, dtype=np.float64), 4097, 8, 1.0)


class IntradayPriceAdapterTests(unittest.TestCase):
    def test_price_adapter_converts_native_arrays_and_scalars_to_strict_json(self) -> None:
        native_result = {
            "schema_version": "intraday_fourier.v2",
            "feature_version": np.int64(2),
            "harmonics": np.asarray([1.0, 2.0], dtype=np.float64),
            "nested": {"scores": (np.float64(0.25), np.asarray([0.5, 0.75]))},
        }
        fake_core = SimpleNamespace(
            FOURIER_MAX_SAMPLES=4096,
            extract_intraday_fourier=lambda *args: native_result,
        )
        with (
            patch("option_wave.intraday_features.HAS_CPP_CORE", True),
            patch("option_wave.intraday_features.cpp_core", fake_core),
        ):
            result = extract_intraday_price_features([100.0] * 9, 9)

        encoded = json.dumps({"result": result}, allow_nan=False)
        decoded = json.loads(encoded)["result"]
        self.assertEqual(decoded["feature_version"], 2)
        self.assertEqual(decoded["harmonics"], [1.0, 2.0])
        self.assertEqual(decoded["nested"]["scores"], [0.25, [0.5, 0.75]])

    def test_price_adapter_rejects_non_finite_native_output(self) -> None:
        fake_core = SimpleNamespace(
            FOURIER_MAX_SAMPLES=4096,
            extract_intraday_fourier=lambda *args: {
                "schema_version": "intraday_fourier.v2",
                "power": np.asarray([0.5, np.nan]),
            },
        )
        with (
            patch("option_wave.intraday_features.HAS_CPP_CORE", True),
            patch("option_wave.intraday_features.cpp_core", fake_core),
            self.assertRaisesRegex(ValueError, r"result\.power\[1\] must be finite"),
        ):
            extract_intraday_price_features([100.0] * 9, 9)

    def test_prices_become_causal_log_returns_for_native_core(self) -> None:
        if not HAS_CPP_CORE:
            self.skipTest("compiled extension is not installed")
        returns = IntradayFourierBindingTests.signal()
        prices = 100.0 * np.exp(np.concatenate(([0.0], np.cumsum(returns))))
        adapted = extract_intraday_price_features(
            prices,
            len(prices),
            max_harmonics=8,
            linear_detrend=False,
            hann_taper=False,
        )
        direct = cpp_core.extract_intraday_fourier(returns, len(returns), 8, 1.0, False, False)

        self.assertEqual(adapted["status"], "ok")
        self.assertEqual(adapted["schema_version"], "intraday_price_features.v1")
        self.assertEqual(adapted["native_schema_version"], "intraday_fourier.v2")
        self.assertEqual(adapted["source"], "ocean_wave_cpp")
        self.assertEqual(adapted["input_transform"], "causal_log_returns")
        self.assertFalse(adapted["python_spectral_fallback"])
        self.assertEqual(adapted["price_sample_count"], 65)
        self.assertEqual(adapted["return_sample_count"], 64)
        np.testing.assert_allclose(
            adapted["cosine_coefficients"], direct["cosine_coefficients"], rtol=0.0, atol=2e-16
        )
        np.testing.assert_allclose(
            adapted["sine_coefficients"], direct["sine_coefficients"], rtol=0.0, atol=2e-16
        )

    def test_price_adapter_never_observes_future_tail(self) -> None:
        if not HAS_CPP_CORE:
            self.skipTest("compiled extension is not installed")
        returns = IntradayFourierBindingTests.signal()
        prefix = list(100.0 * np.exp(np.concatenate(([0.0], np.cumsum(returns)))))
        first = np.asarray(prefix + ["future-invalid"] * 10, dtype=object)
        second = np.asarray(prefix + [-1_000.0] * 10, dtype=object)
        first_result = extract_intraday_price_features(first, len(prefix), max_harmonics=8)
        second_result = extract_intraday_price_features(second, len(prefix), max_harmonics=8)
        for key in ("cosine_coefficients", "sine_coefficients", "amplitudes", "phases", "power"):
            np.testing.assert_array_equal(first_result[key], second_result[key])

    def test_price_adapter_default_resolves_two_minute_session_cycles(self) -> None:
        if not HAS_CPP_CORE:
            self.skipTest("compiled extension is not installed")
        prices = np.full(391, 500.0, dtype=np.float64)
        result = extract_intraday_price_features(prices, len(prices))
        self.assertEqual(int(result["return_sample_count"]), 390)
        self.assertEqual(int(result["harmonic_count"]), 195)
        self.assertAlmostEqual(float(np.min(result["periods"])), 2.0, places=12)

    def test_native_unavailability_explicitly_abstains_without_fallback(self) -> None:
        with patch("option_wave.intraday_features.HAS_CPP_CORE", False):
            result = extract_intraday_price_features([], 0)
        self.assertEqual(result["status"], "abstain")
        self.assertEqual(result["reason"], "native_core_unavailable")
        self.assertTrue(result["native_required"])
        self.assertFalse(result["python_spectral_fallback"])

        with (
            patch("option_wave.intraday_features.HAS_CPP_CORE", True),
            patch("option_wave.intraday_features.cpp_core", object()),
        ):
            result = extract_intraday_price_features([], 0)
        self.assertEqual(result["status"], "abstain")
        self.assertEqual(result["reason"], "native_fourier_api_unavailable")

    def test_price_adapter_strictly_validates_the_causal_prefix(self) -> None:
        if not HAS_CPP_CORE:
            self.skipTest("compiled extension is not installed")
        with self.assertRaises(ValueError):
            extract_intraday_price_features([100.0] * 8, 8)
        with self.assertRaises(ValueError):
            extract_intraday_price_features([100.0] * 10, 11)
        invalid = [100.0] * 10
        invalid[4] = 0.0
        with self.assertRaises(ValueError):
            extract_intraday_price_features(invalid, 10)
        with self.assertRaises(TypeError):
            extract_intraday_price_features([100.0] * 10, True)


if __name__ == "__main__":
    unittest.main()
