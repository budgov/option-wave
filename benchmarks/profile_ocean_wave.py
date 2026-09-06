"""Offline warm timing, bounded component profiling, and optional Python heap audit.

Timing and profiling are separate: cProfile's overhead is never reported as
production latency. The optional heap audit covers Python-tracked allocations,
not process RSS or temporary C++ vectors.
"""
from __future__ import annotations

import argparse
import cProfile
import gc
import io
import json
import pstats
from time import perf_counter_ns
import tracemalloc

import numpy as np

from benchmarks.benchmark_ocean_wave import make_chain
from option_wave import HAS_CPP_CORE, MarketState, OceanWave


def bounded_iterations(value: str) -> int:
    number = int(value)
    if number < 1 or number > 2000:
        raise argparse.ArgumentTypeError("iterations must be in [1, 2000]")
    return number


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=bounded_iterations, default=150)
    parser.add_argument("--profile-iterations", type=bounded_iterations, default=50)
    parser.add_argument("--memory-iterations", type=bounded_iterations)
    args = parser.parse_args()
    chain = make_chain()
    previous = chain.copy()
    previous["call_oi"] *= 0.99
    previous["put_oi"] *= 1.01
    state = MarketState(spot=100.0, previous_close=99.5, vwap=99.8,
        return_5m=0.001, return_15m=0.002, rvol=1.15, realized_vol=0.21)
    model = OceanWave()

    def predict() -> None:
        model.predict(chain, state, previous_chain=previous, horizons_minutes=(30.0,))

    for _ in range(10):
        predict()
    elapsed = []
    for _ in range(args.iterations):
        started = perf_counter_ns()
        predict()
        elapsed.append((perf_counter_ns() - started) / 1_000_000.0)
    print(json.dumps({"rows": len(chain), "cpp": HAS_CPP_CORE, "iterations": len(elapsed),
        "median_ms": float(np.median(elapsed)), "p95_ms": float(np.percentile(elapsed, 95)),
        "rating_entries": len(model.state_dict()["ratings"])}))

    profiler = cProfile.Profile()
    profiler.enable()
    for _ in range(args.profile_iterations):
        predict()
    profiler.disable()
    output = io.StringIO()
    pstats.Stats(profiler, stream=output).strip_dirs().sort_stats("cumulative").print_stats(18)
    print(output.getvalue())

    if args.memory_iterations is not None:
        gc.collect()
        tracemalloc.start()
        for _ in range(args.memory_iterations):
            predict()
        gc.collect()
        first_retained, _ = tracemalloc.get_traced_memory()
        tracemalloc.reset_peak()
        for _ in range(args.memory_iterations):
            predict()
        gc.collect()
        second_retained, second_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        print(json.dumps({"memory_scope": "python_tracked_allocations_only",
            "cycles_per_batch": args.memory_iterations,
            "first_retained_bytes": first_retained, "second_retained_bytes": second_retained,
            "retained_growth_bytes": second_retained - first_retained,
            "second_batch_peak_bytes": second_peak,
            "rating_entries": len(model.state_dict()["ratings"])}))


if __name__ == "__main__":
    main()
