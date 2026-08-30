"""Offline ABI and numerical-parity validation for a staged Ocean-Wave extension."""

from __future__ import annotations

import argparse
import hashlib
import importlib.machinery
import importlib.util
import json
import math
from pathlib import Path

import numpy as np


def file_sha256(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        for block in iter(lambda: source.read(256 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_extension(filename: Path):
    if not any(str(filename).endswith(suffix) for suffix in importlib.machinery.EXTENSION_SUFFIXES):
        raise RuntimeError("extension suffix is incompatible with this Python runtime")
    spec = importlib.util.spec_from_file_location("_core", filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not create an extension-module loader")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parity_check(core) -> dict[str, object]:
    for name in ("forecast_surface", "evolve_field", "extract_intraday_fourier"):
        if not callable(getattr(core, name, None)):
            raise RuntimeError(f"required native symbol is missing: {name}")

    distances = np.asarray([-0.15, -0.05, 0.05, 0.15], dtype=np.float64)
    expiries = np.asarray([1.0, 7.0, 30.0], dtype=np.float64)
    row_expiry = np.repeat(expiries, distances.size)
    row_distance = np.tile(distances, expiries.size)
    signals = np.asarray([
        -0.18, -0.09, 0.07, 0.16,
        -0.14, -0.04, 0.04, 0.14,
        -0.10, -0.02, 0.02, 0.10,
    ], dtype=np.float64)
    weights = np.ones(signals.size, dtype=np.float64)
    variances = np.zeros(signals.size, dtype=np.float64)
    horizons = [5.0, 17.0, 30.0]
    kernel = (0.015, 0.010, 0.002, 0.020, 0.080, 0.5)
    composite_signal = float(np.average(signals, weights=weights))

    forecast = core.forecast_surface(
        row_expiry, row_distance, signals, weights, variances,
        composite_signal, 0.8, 0.02, 100.0, 0.25, 0.9, 0.01, 0.5, 1.0, 98_280.0,
        *kernel, horizons,
    )
    evolved = core.evolve_field(signals, weights, distances, expiries, *kernel, horizons)
    for key in ("field", "integrals", "averages"):
        if not np.array_equal(np.asarray(forecast[key]), np.asarray(evolved[key])):
            raise RuntimeError(f"forecast/evolve parity failed for {key}")
    scores = np.asarray(evolved["scores"])
    if scores.size != 61 or not np.isfinite(scores).all():
        raise RuntimeError("evolve_field retained-score contract failed")
    for value in forecast.values():
        values = np.asarray(value)
        if not all(math.isfinite(float(item)) for item in values.reshape(-1)):
            raise RuntimeError("forecast contains a non-finite value")
    returns = np.asarray([
        0.001 * math.sin(2.0 * math.pi * index / 16.0)
        for index in range(64)
    ], dtype=np.float64)
    spectral = core.extract_intraday_fourier(returns, 64, 32, 1.0, True, True)
    if (
        spectral.get("schema_version") != "intraday_fourier.v2"
        or spectral.get("causal_prefix") is not True
        or spectral.get("lookahead_samples") != 0
        or spectral.get("taper_strategy") != "causal_prefix_hann"
        or spectral.get("detrend_strategy") != "causal_ols_linear"
    ):
        raise RuntimeError("intraday Fourier causal/preprocessing contract failed")
    if not math.isfinite(float(spectral.get("spectral_entropy", math.nan))):
        raise RuntimeError("intraday Fourier diagnostics are non-finite")
    return {
        "score_count": int(scores.size),
        "parity": "bit_exact",
        "intraday_fourier": "causal_v2",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    arguments = parser.parse_args()
    extension = arguments.extension.resolve(strict=True)
    actual_hash = file_sha256(extension)
    if actual_hash != arguments.expected_sha256.lower():
        raise RuntimeError("extension SHA-256 does not match the approved digest")
    core = load_extension(extension)
    parity = parity_check(core)
    print(json.dumps({
        "status": "ok",
        "sha256": actual_hash,
        "extension_suffix": next(
            suffix for suffix in importlib.machinery.EXTENSION_SUFFIXES if str(extension).endswith(suffix)
        ),
        **parity,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
