from __future__ import annotations

import errno
import os
import threading
import unittest
from unittest.mock import patch
from typing import Any, Mapping
from pathlib import Path
import json
import tempfile
from time import sleep

import numpy as np
import pandas as pd

from option_wave import (
    EventContext,
    FACTOR_NAMES,
    HTTPAPIConfig,
    InverseLink,
    InverseMarketData,
    InverseRegistry,
    MarketState,
    MassiveHTTPClient,
    OceanWave,
    OptionWaveV09,
    ShortData,
    SchwabHTTPClient,
    aggregate_large_flow,
    assess_contract,
    HAS_CPP_CORE,
)
from option_wave._backend import cpp_core
from option_wave.elo import EloConfig, build_elo_surface, energy_cost, build_symmetric_pairs
from option_wave.factors import extract_chain_factors
from option_wave.schwab_api import latest_quote_timestamp
from option_wave.realtime import (
    RealtimePredictor,
    apply_market_state_overrides,
    audit_option_chain,
    build_chain_context,
    compact_previous_chain,
    write_json_atomic,
)


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
    def test_market_state_overrides_are_causal_bounded_and_cannot_replace_spot(self) -> None:
        state = MarketState(spot=100.0, symbol="QQQ")
        enriched = apply_market_state_overrides(state, {
            "vwap": 99.5, "return_5m": 0.002, "return_15m": -0.001,
            "realized_vol": 0.24, "rvol": 1.4, "data_confidence": 2.0,
        })
        self.assertEqual(enriched.spot, 100.0)
        self.assertEqual(enriched.vwap, 99.5)
        self.assertEqual(enriched.data_confidence, 1.0)
        with self.assertRaisesRegex(ValueError, "unsupported market state override"):
            apply_market_state_overrides(state, {"spot": 101.0})
        with self.assertRaisesRegex(ValueError, "cannot be negative"):
            apply_market_state_overrides(state, {"realized_vol": -0.1})

    def test_atomic_state_write_retries_transient_replace_locks(self) -> None:
        real_replace = os.replace
        attempts = 0

        def flaky_replace(source: str, target: str | Path) -> None:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise OSError(errno.EACCES, "temporarily locked")
            if attempts == 2:
                raise OSError(errno.EBUSY, "temporarily busy")
            real_replace(source, target)

        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "SPY.model.json"
            with (
                patch("option_wave._atomic_io.os.replace", side_effect=flaky_replace),
                patch("option_wave._atomic_io.sleep") as pause,
            ):
                write_json_atomic(target, {"schema_version": "test", "value": 7})

            self.assertEqual(attempts, 3)
            self.assertEqual([item.args[0] for item in pause.call_args_list], [0.01, 0.02])
            self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["value"], 7)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_atomic_state_write_bounds_retries_and_removes_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "SPY.model.json"
            with (
                patch("option_wave._atomic_io.os.replace", side_effect=OSError(errno.EPERM, "persistently locked")) as replace,
                patch("option_wave._atomic_io.sleep") as pause,
            ):
                with self.assertRaises(OSError):
                    write_json_atomic(target, {"schema_version": "test"})

            self.assertEqual(replace.call_count, 8)
            self.assertEqual(pause.call_count, 7)
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_contract_overlay_aligns_direction_and_penalizes_costs(self) -> None:
        class Result:
            trend_score = 0.40
            confidence = 0.80

        call = assess_contract(Result(), {"option_type": "call", "bid": 1.0, "ask": 1.1, "theta": -0.05})
        put = assess_contract(Result(), {"option_type": "put", "bid": 1.0, "ask": 1.1, "theta": -0.05})
        self.assertEqual(call.decision, "support")
        self.assertEqual(put.decision, "oppose")
        self.assertGreater(call.contract_score, 0.0)
        self.assertLess(put.contract_score, 0.0)

    def test_contract_overlay_abstains_without_executable_quote(self) -> None:
        class Result:
            trend_score = 0.40
            confidence = 0.80

        assessment = assess_contract(Result(), {"option_type": "call", "theta": -0.05})
        self.assertEqual(assessment.decision, "abstain")
        self.assertIn("missing_or_invalid_executable_quote", assessment.reasons)

    def test_contract_overlay_abstains_when_theta_dominates_weak_edge(self) -> None:
        class Result:
            trend_score = 0.014
            confidence = 0.725

        assessment = assess_contract(Result(), {"option_type": "call", "bid": 0.57, "ask": 0.58, "theta": -0.565})
        self.assertEqual(assessment.decision, "abstain")
        self.assertIn("theta_dominates_weak_directional_edge", assessment.reasons)

    def test_symmetric_pair_is_relative_not_same_strike(self) -> None:
        pairs = build_symmetric_pairs(chain(), spot=100.0)
        match = pairs[(pairs.expiry_days == 0) & np.isclose(pairs.distance_pct, 0.05)]
        self.assertEqual(len(match), 1)
        row = match.iloc[0]
        self.assertAlmostEqual(row.call_strike, 105.0)
        self.assertAlmostEqual(row.put_strike, 95.0)

    def test_energy_cost_is_direction_neutral(self) -> None:
        cfg = EloConfig()
        cost = energy_cost(0.05, cfg)
        self.assertAlmostEqual(float(cost), 0.05)

        pairs = build_symmetric_pairs(chain(), spot=100.0, cfg=cfg)
        row = pairs[(pairs.expiry_days == 0) & np.isclose(pairs.distance_pct, 0.05)].iloc[0]
        self.assertAlmostEqual(float(row.call_force), float(row.put_force))

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

    @unittest.skipUnless(HAS_CPP_CORE, "compiled extension is not installed")
    def test_cpp_forecast_matches_python_reference(self) -> None:
        native = OceanWave().predict(
            chain(),
            MarketState(
                spot=100.0,
                previous_close=99.5,
                vwap=99.8,
                return_5m=0.001,
                return_15m=0.002,
                rvol=1.2,
                realized_vol=0.25,
            ),
            horizons_minutes=(5.0, 30.0),
        )
        with (
            patch("option_wave.elo.HAS_CPP_CORE", False),
            patch("option_wave.factors.HAS_CPP_CORE", False),
            patch("option_wave.flow.HAS_CPP_CORE", False),
            patch("option_wave.model.HAS_CPP_CORE", False),
        ):
            reference = OceanWave().predict(
                chain(),
                MarketState(
                    spot=100.0,
                    previous_close=99.5,
                    vwap=99.8,
                    return_5m=0.001,
                    return_15m=0.002,
                    rvol=1.2,
                    realized_vol=0.25,
                ),
                horizons_minutes=(5.0, 30.0),
            )

        np.testing.assert_allclose(native.field_grid, reference.field_grid, rtol=1e-10, atol=1e-12)
        self.assertAlmostEqual(native.trend_score, reference.trend_score, places=10)
        self.assertAlmostEqual(native.confidence, reference.confidence, places=10)
        for horizon in (5.0, 30.0):
            self.assertAlmostEqual(
                native.expectations[horizon].expected_price,
                reference.expectations[horizon].expected_price,
                places=10,
            )

    @unittest.skipUnless(HAS_CPP_CORE, "compiled extension is not installed")
    def test_cpp_surface_aggregate_is_available(self) -> None:
        result = cpp_core.aggregate_surface_signals(
            np.asarray([0.60, 0.40]),
            np.asarray([0.80, 0.80]),
            np.asarray([0.25, -0.25]),
            np.asarray([1.00, 1.00]),
        )
        np.testing.assert_allclose(np.asarray(result["pair_signal"]), [0.24, -0.24])
        self.assertAlmostEqual(float(result["premium_signal"]), 0.0)
        self.assertAlmostEqual(float(result["mean_pair_confidence"]), 0.8)

    @unittest.skipUnless(HAS_CPP_CORE, "compiled extension is not installed")
    def test_cpp_boundary_rejects_mismatched_or_unbounded_inputs(self) -> None:
        with self.assertRaises(RuntimeError):
            cpp_core.aggregate_surface_signals(
                np.asarray([0.6]), np.asarray([0.8, 0.7]), np.asarray([0.1]), np.asarray([1.0])
            )
        with self.assertRaises(RuntimeError):
            cpp_core.evolve_field(
                np.asarray([0.0]), np.asarray([1.0]), np.asarray([0.0]), np.asarray([0.0]),
                0.01, 0.01, 0.0, 0.01, 0.10, 1.0, [],
            )

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

    def test_online_elo_state_releases_stale_spot_grids(self) -> None:
        ratings: dict[tuple[str, float, float], float] = {}
        latest = None
        for spot in np.linspace(99.0, 101.0, 80):
            latest = build_elo_surface(chain(), float(spot), ratings=ratings)
        self.assertIsNotNone(latest)
        self.assertLessEqual(len(ratings), 2 * len(latest))
        self.assertLess(len(ratings), 200)

    def test_online_state_round_trips_as_json_data(self) -> None:
        original = OceanWave()
        original.predict(chain(), MarketState(spot=100.0, realized_vol=0.25))
        state = original.state_dict()
        restored = OceanWave()
        restored.load_state_dict(state)
        self.assertEqual(restored.state_dict(), state)

    def test_realtime_snapshot_is_compact_and_checkpoints_only_required_chain_state(self) -> None:
        source_chain = chain()
        source_chain["expiry_date"] = source_chain["expiry_days"].map({
            0: "2026-08-19", 1: "2026-08-20", 7: "2026-08-26"
        })

        class FakeSchwabClient:
            def __init__(self, _config: object) -> None:
                pass

            def fetch_market_snapshot(self, _symbol: str, *, strike_count: int) -> tuple[pd.DataFrame, MarketState]:
                self.strike_count = strike_count
                return source_chain, MarketState(spot=100.0, realized_vol=0.25)

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.SchwabHTTPClient", FakeSchwabClient
        ):
            with RealtimePredictor(Path(directory), async_checkpoints=False, require_native_core=False) as predictor:
                snapshot = predictor.predict(
                    symbol="SPY",
                    signal_published_at="2026-08-19T14:00:00Z",
                    access_token="test-token",
                    horizons=(5.0, 15.0),
                    strike_count=40,
                    strike=100.0,
                    option_type="call",
                    checkpoint_async=False,
                )
            self.assertNotIn("chain", snapshot)
            self.assertIsNone(snapshot["target_contract"]["requested"]["expiry"])
            self.assertEqual(snapshot["target_contract"]["resolved"]["expiry"], "2026-08-19")
            self.assertTrue(snapshot["target_contract"]["resolved"]["expiry_inferred"])
            self.assertTrue(snapshot["target_contract"]["exact_expiry_match"])
            self.assertTrue(snapshot["execution_eligible"])
            self.assertEqual(snapshot["chain_context"]["row_count"], len(source_chain))
            self.assertLess(len(json.dumps(snapshot)), 100_000)
            state = json.loads((Path(directory) / "SPY.state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["schema_version"], "ocean-wave-runtime-state.v1")
            self.assertRegex(state["checkpoint_generation"], r"^[0-9a-f-]{36}$")
            self.assertEqual(state["model"]["schema_version"], "ocean-wave-state.v1")
            self.assertTrue(state["chain"]["rows"])
            self.assertEqual(
                state["quality_state"]["schema_version"],
                "ocean-wave-chain-quality-state.v1",
            )
            self.assertEqual(len(state["quality_state"]["accepted_gex_gross"]), 1)
            self.assertLessEqual(set(state["chain"]["rows"][0]), set(compact_previous_chain(source_chain).columns))
            self.assertFalse((Path(directory) / "SPY.model.json").exists())
            self.assertFalse((Path(directory) / "SPY.chain.json").exists())

    def test_extreme_gex_snapshot_is_quarantined_without_mutating_online_state(self) -> None:
        baseline_chain = chain()
        extreme_chain = baseline_chain.copy()
        extreme_chain["call_gamma"] *= 100.0
        extreme_chain["put_gamma"] *= 100.0
        baseline_gex = audit_option_chain(baseline_chain, 100.0).gex_gross

        class FakeSchwabClient:
            def __init__(self, _config: object) -> None:
                pass

            def fetch_market_snapshot(self, _symbol: str, *, strike_count: int) -> tuple[pd.DataFrame, MarketState]:
                self.strike_count = strike_count
                return extreme_chain, MarketState(spot=100.0, realized_vol=0.25)

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.SchwabHTTPClient", FakeSchwabClient
        ):
            with RealtimePredictor(Path(directory), async_checkpoints=False, require_native_core=False) as predictor:
                runtime = predictor._load("SPY")
                runtime.previous_chain = compact_previous_chain(baseline_chain)
                runtime.gex_history = (baseline_gex,) * 5
                model_before = runtime.model.state_dict()
                previous_before = runtime.previous_chain.copy(deep=True)
                snapshot = predictor.predict(
                    symbol="SPY",
                    signal_published_at="2026-08-28T17:00:00Z",
                    access_token="test-token",
                    horizons=(30.0,),
                    strike_count=40,
                    checkpoint_async=False,
                )
                self.assertEqual(runtime.model.state_dict(), model_before)
                pd.testing.assert_frame_equal(runtime.previous_chain, previous_before)
                self.assertEqual(runtime.gex_history, (baseline_gex,) * 5)

            self.assertTrue(snapshot["quarantined"])
            self.assertIn("gex_gross_extreme_outlier", snapshot["quarantine_reasons"])
            self.assertIsNone(snapshot["ocean_wave"])
            self.assertFalse(snapshot["runtime"]["prediction_ran"])
            self.assertFalse(snapshot["runtime"]["state_updated"])
            self.assertEqual(snapshot["runtime"]["checkpoint"], "none")
            self.assertFalse((Path(directory) / "SPY.state.json").exists())

    def test_realtime_state_migrates_legacy_model_and_chain_into_one_atomic_bundle(self) -> None:
        source_chain = compact_previous_chain(chain())
        model = OceanWave()
        model.predict(chain(), MarketState(spot=100.0, realized_vol=0.25))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "SPY.model.json").write_text(json.dumps(model.state_dict()), encoding="utf-8")
            (root / "SPY.chain.json").write_text(json.dumps({
                "schema_version": "ocean-wave-chain-state.v2",
                "captured_at": "2026-08-21T20:00:00Z",
                "rows": source_chain.to_dict(orient="records"),
            }), encoding="utf-8")
            with RealtimePredictor(root, async_checkpoints=False, require_native_core=False) as predictor:
                runtime = predictor._load("SPY")
                self.assertEqual(runtime.model.state_dict(), model.state_dict())
                self.assertEqual(len(runtime.previous_chain), len(source_chain))
            combined = json.loads((root / "SPY.state.json").read_text(encoding="utf-8"))
            self.assertEqual(combined["schema_version"], "ocean-wave-runtime-state.v1")
            self.assertEqual(len(combined["chain"]["rows"]), len(source_chain))

    def test_async_checkpoint_blocks_reload_of_an_evicted_symbol_until_bundle_is_durable(self) -> None:
        started = threading.Event()
        release = threading.Event()
        errors: list[Exception] = []
        loaded: list[object] = []
        real_write = write_json_atomic

        def blocked_write(path: Path, payload: object) -> None:
            started.set()
            if not release.wait(2.0):
                raise TimeoutError("checkpoint test release timed out")
            real_write(path, payload)

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.write_json_atomic", side_effect=blocked_write
        ):
            predictor = RealtimePredictor(
                Path(directory), max_symbols=1, async_checkpoints=True, require_native_core=False
            )
            reload_thread: threading.Thread | None = None
            try:
                runtime = predictor._load("SPY")
                runtime.previous_chain = pd.DataFrame([{"strike": 123.0, "expiry_days": 1.0}])
                runtime.dirty = True
                predictor._checkpoint("SPY", runtime, asynchronous=True)
                self.assertTrue(started.wait(1.0))
                predictor._load("AAPL")

                def reload_spy() -> None:
                    try:
                        loaded.append(predictor._load("SPY"))
                    except Exception as error:  # pragma: no cover - asserted below.
                        errors.append(error)

                reload_thread = threading.Thread(target=reload_spy, name="test-reload-spy")
                reload_thread.start()
                reload_thread.join(0.05)
                self.assertTrue(reload_thread.is_alive(), "reload bypassed the pending checkpoint barrier")
            finally:
                release.set()
                reload_thread and reload_thread.join(2.0)
                predictor.close()
                # Windows may briefly report a directory involved in an
                # atomic rename as non-empty after the worker has exited.
                sleep(0.05)

            self.assertFalse(errors)
            self.assertEqual(len(loaded), 1)
            self.assertIsNotNone(loaded[0].previous_chain)
            self.assertEqual(float(loaded[0].previous_chain.iloc[0].strike), 123.0)

    def test_synchronous_checkpoint_cannot_be_overwritten_by_an_older_async_bundle(self) -> None:
        first_started = threading.Event()
        release_first = threading.Event()
        second_entered = threading.Event()
        second_finished = threading.Event()
        counter_lock = threading.Lock()
        call_count = 0
        real_write = write_json_atomic

        def ordered_write(path: Path, payload: object) -> None:
            nonlocal call_count
            with counter_lock:
                call_count += 1
                index = call_count
            if index == 1:
                first_started.set()
                if not release_first.wait(2.0):
                    raise TimeoutError("checkpoint test release timed out")
            else:
                second_entered.set()
            real_write(path, payload)
            if index > 1:
                second_finished.set()

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.write_json_atomic", side_effect=ordered_write
        ):
            predictor = RealtimePredictor(Path(directory), async_checkpoints=True, require_native_core=False)
            runtime = predictor._load("SPY")
            runtime.previous_chain = pd.DataFrame([{"strike": 100.0, "expiry_days": 1.0}])
            runtime.dirty = True
            predictor._checkpoint("SPY", runtime, asynchronous=True)
            self.assertTrue(first_started.wait(1.0))
            runtime.previous_chain = pd.DataFrame([{"strike": 200.0, "expiry_days": 1.0}])
            runtime.dirty = True
            sync_errors: list[Exception] = []

            def checkpoint_current() -> None:
                try:
                    predictor._checkpoint("SPY", runtime, asynchronous=False)
                except Exception as error:  # pragma: no cover - asserted below.
                    sync_errors.append(error)

            sync_thread = threading.Thread(target=checkpoint_current, name="test-sync-checkpoint")
            sync_thread.start()
            # The pre-fix implementation enters and completes the newer write
            # while the older one is still blocked.  Release only after that
            # completion when observed, making the stale overwrite deterministic.
            if second_entered.wait(0.10):
                self.assertTrue(second_finished.wait(1.0))
            release_first.set()
            sync_thread.join(2.0)
            predictor.close()
            sleep(0.05)
            self.assertFalse(sync_errors)
            state = json.loads((Path(directory) / "SPY.state.json").read_text(encoding="utf-8"))
            self.assertEqual(float(state["chain"]["rows"][0]["strike"]), 200.0)

    def test_close_recovers_a_failed_async_checkpoint_and_shuts_down_executor(self) -> None:
        call_count = 0
        real_write = write_json_atomic

        def fail_once(path: Path, payload: object) -> None:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise OSError("simulated asynchronous checkpoint failure")
            real_write(path, payload)

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.write_json_atomic", side_effect=fail_once
        ):
            predictor = RealtimePredictor(Path(directory), async_checkpoints=True, require_native_core=False)
            runtime = predictor._load("SPY")
            runtime.previous_chain = pd.DataFrame([{"strike": 321.0, "expiry_days": 1.0}])
            runtime.dirty = True
            predictor._checkpoint("SPY", runtime, asynchronous=True)
            predictor.close()
            state = json.loads((Path(directory) / "SPY.state.json").read_text(encoding="utf-8"))
            self.assertEqual(float(state["chain"]["rows"][0]["strike"]), 321.0)
            with self.assertRaises(RuntimeError):
                predictor._executor.submit(lambda: None)

    def test_context_quote_skips_prediction_learning_and_checkpoints(self) -> None:
        class FakeSchwabClient:
            def __init__(self, _config: object) -> None:
                pass

            def fetch_underlying_state(self, symbol: str) -> MarketState:
                return MarketState(spot=521.25, symbol=symbol, previous_close=519.0)

            def fetch_market_snapshot(self, _symbol: str, *, strike_count: int) -> tuple[pd.DataFrame, MarketState]:
                raise AssertionError(f"option-chain prediction ran with {strike_count=}")

        with tempfile.TemporaryDirectory() as directory, patch(
            "option_wave.realtime.SchwabHTTPClient", FakeSchwabClient
        ):
            with RealtimePredictor(Path(directory), async_checkpoints=False, require_native_core=False) as predictor:
                with (
                    patch.object(predictor, "_load", side_effect=AssertionError("model state was loaded")),
                    patch.object(predictor, "_checkpoint", side_effect=AssertionError("checkpoint was written")),
                    patch.object(predictor, "apply_feedback", side_effect=AssertionError("feedback was applied")),
                ):
                    snapshot = predictor.quote(
                        symbol="SPY",
                        signal_published_at="2026-08-21T16:00:00Z",
                        access_token="test-token",
                    )

            self.assertEqual(snapshot["data_tier"], "realtime_underlying")
            self.assertEqual(snapshot["market_state"]["spot"], 521.25)
            self.assertTrue(snapshot["context_only"])
            self.assertIsNone(snapshot["target_contract"])
            self.assertIsNone(snapshot["ocean_wave"])
            self.assertEqual(snapshot["runtime"]["operation"], "quote_only")
            self.assertFalse(snapshot["runtime"]["prediction_ran"])
            self.assertEqual(snapshot["runtime"]["checkpoint"], "none")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_chain_context_bounds_nearby_rows(self) -> None:
        context = build_chain_context(chain(), 100.0, None, 100.0, row_limit=4)
        self.assertEqual(context["row_count"], len(chain()))
        self.assertLessEqual(len(context["nearby_contracts"]), 4)

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

    def test_short_pressure_enters_model_without_changing_energy_cost(self) -> None:
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
        expected_cost = energy_cost(float(np.median(result.distance_grid)), EloConfig())
        self.assertAlmostEqual(float(result.diagnostics["energy_cost_at_median_distance"]), float(expected_cost))

    def test_iv_gex_and_oi_statistics_are_extracted(self) -> None:
        current = chain()
        current["expiry_date"] = current["expiry_days"].map({
            0: "2026-08-28", 1: "2026-08-29", 7: "2026-09-04",
        })
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

    def test_oi_change_uses_stable_contract_identity_and_zero_change_has_no_directional_confidence(self) -> None:
        previous = chain()
        previous["expiry_date"] = previous["expiry_days"].map({
            0: "2026-08-28", 1: "2026-08-29", 7: "2026-09-04",
        })
        previous["call_symbol"] = [f"TEST-C-{index}" for index in range(len(previous))]
        previous["put_symbol"] = [f"TEST-P-{index}" for index in range(len(previous))]
        current = previous.copy()
        # The same listed contracts naturally have a different DTE tomorrow.
        current["expiry_days"] = np.maximum(current["expiry_days"] - 1.0, 0.0)
        current["call_oi"] += 100.0

        with patch("option_wave.factors.HAS_CPP_CORE", False):
            python_summary = extract_chain_factors(current, 100.0, previous_chain=previous)
        native_summary = extract_chain_factors(current, 100.0, previous_chain=previous)
        self.assertGreater(native_summary.oi_signal, 0.0)
        self.assertGreater(native_summary.oi_confidence, 0.0)
        self.assertAlmostEqual(native_summary.oi_signal, python_summary.oi_signal, places=10)
        self.assertAlmostEqual(native_summary.oi_confidence, python_summary.oi_confidence, places=10)

        unchanged = previous.copy()
        unchanged["expiry_days"] = np.maximum(unchanged["expiry_days"] - 1.0, 0.0)
        with patch("option_wave.factors.HAS_CPP_CORE", False):
            unchanged_python = extract_chain_factors(unchanged, 100.0, previous_chain=previous)
        unchanged_native = extract_chain_factors(unchanged, 100.0, previous_chain=previous)
        self.assertEqual(unchanged_python.oi_signal, 0.0)
        self.assertEqual(unchanged_python.oi_confidence, 0.0)
        self.assertEqual(unchanged_native.oi_signal, 0.0)
        self.assertEqual(unchanged_native.oi_confidence, 0.0)

    def test_confidence_fields_distinguish_evidence_from_directional_edge(self) -> None:
        result = OceanWave().predict(
            chain(), MarketState(spot=100.0, realized_vol=0.25), horizons_minutes=(30.0,)
        )
        self.assertEqual(result.evidence_quality, result.confidence)
        self.assertGreaterEqual(result.directional_edge, 0.0)
        self.assertLessEqual(result.directional_edge, 1.0)
        self.assertEqual(
            result.confidence_semantics,
            "evidence_reliability_not_direction_probability",
        )
        self.assertEqual(result.diagnostics["evidence_quality"], result.evidence_quality)

    def test_chain_audit_rejects_impossible_market_fields(self) -> None:
        invalid = chain()
        invalid.loc[0, "call_bid"] = 2.0
        invalid.loc[0, "call_ask"] = 1.0
        invalid.loc[1, "put_gamma"] = -0.01
        audit = audit_option_chain(invalid, 100.0)
        self.assertFalse(audit.accepted)
        self.assertIn("call_invalid_bid_ask", audit.reasons)
        self.assertIn("put_invalid_gamma", audit.reasons)

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

    def test_event_context_only_widens_risk_and_reduces_confidence(self) -> None:
        baseline = OceanWave().predict(
            chain(), MarketState(spot=100.0, realized_vol=0.25), horizons_minutes=(30.0,)
        )
        stressed = OceanWave().predict(
            chain(),
            MarketState(spot=100.0, realized_vol=0.25),
            event_context=EventContext(
                minutes_to_earnings=5.0, minutes_to_macro=15.0,
                event_surprise_z=2.0, headline_intensity=0.8, confidence=1.0,
            ),
            horizons_minutes=(30.0,),
        )
        self.assertGreater(stressed.expectations[30.0].return_variance, baseline.expectations[30.0].return_variance)
        self.assertLess(stressed.confidence, baseline.confidence)
        self.assertEqual(stressed.direction, baseline.direction)
        self.assertGreater(stressed.diagnostics["event_risk_multiplier"], 1.0)

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

    def test_historical_quote_normalizer_preserves_executable_spread(self) -> None:
        normalized = MassiveHTTPClient.normalize_option_quotes({"results": [
            {
                "sip_timestamp": 1784980801000000000,
                "bid_price": 1.1,
                "ask_price": 1.3,
                "bid_size": 2,
                "ask_size": 4,
                "sequence_number": 9,
            },
            {
                "sip_timestamp": 1784980800000000000,
                "bid_price": 1.0,
                "ask_price": 1.2,
                "bid_size": 1,
                "ask_size": 3,
                "sequence_number": 8,
            },
            {
                "sip_timestamp": 1784980802000000000,
                "bid_price": 1.5,
                "ask_price": 1.4,
            },
        ]})
        self.assertEqual(list(normalized.sequence_number.iloc[:2]), [8, 9])
        self.assertAlmostEqual(float(normalized.iloc[0].mid), 1.1)
        self.assertAlmostEqual(float(normalized.iloc[0].spread), 0.2)
        self.assertTrue(bool(normalized.iloc[0].executable))
        self.assertFalse(bool(normalized.iloc[2].executable))

    def test_historical_quote_fetch_uses_bounded_point_in_time_window(self) -> None:
        urls: list[str] = []

        def transport(url: str) -> dict[str, object]:
            urls.append(url)
            return {"results": []}

        client = MassiveHTTPClient(HTTPAPIConfig(api_key="test-key"), transport=transport)
        client.fetch_option_quotes(
            "O:SPY260717C00600000",
            start="2026-07-17T14:30:00Z",
            end="2026-07-17T14:35:00Z",
        )
        self.assertEqual(len(urls), 1)
        self.assertIn("timestamp.gte=", urls[0])
        self.assertIn("timestamp.lte=", urls[0])

    def test_news_fetch_is_bounded_before_signal_time(self) -> None:
        urls: list[str] = []

        def transport(url: str) -> dict[str, object]:
            urls.append(url)
            return {"results": [{
                "id": "n1",
                "published_utc": "2026-07-17T14:29:00Z",
                "title": "Company update",
                "publisher": {"name": "Example Wire"},
                "tickers": ["SPY"],
                "insights": [{"ticker": "SPY", "sentiment": "neutral"}],
            }]}

        client = MassiveHTTPClient(HTTPAPIConfig(), transport=transport)
        frame = client.fetch_news("spy", start="2026-07-16", end="2026-07-17T14:30:00Z")
        self.assertEqual(frame.iloc[0].title, "Company update")
        self.assertIn("ticker=SPY", urls[0])
        self.assertIn("published_utc.lte=", urls[0])

    def test_schwab_chain_normalizer_builds_wide_chain(self) -> None:
        payload = {
            "callExpDateMap": {
                "2026-09-18:33": {
                    "100.0": [{
                        "symbol": "AAPL  260918C00100000",
                        "strikePrice": 100.0,
                        "bid": 4.8,
                        "ask": 5.0,
                        "last": 4.9,
                        "totalVolume": 1200,
                        "openInterest": 8000,
                        "volatility": 31.0,
                        "delta": 0.55,
                        "gamma": 0.04,
                        "theta": -0.08,
                        "vega": 0.12,
                        "quoteTimeInLong": 1786905600000,
                    }],
                },
            },
            "putExpDateMap": {
                "2026-09-18:33": {
                    "100.0": [{
                        "symbol": "AAPL  260918P00100000",
                        "strikePrice": 100.0,
                        "bid": 4.1,
                        "ask": 4.3,
                        "last": 4.2,
                        "totalVolume": 900,
                        "openInterest": 7500,
                        "volatility": 0.33,
                        "delta": -0.45,
                        "gamma": 0.04,
                        "theta": -0.07,
                        "vega": 0.11,
                        "quoteTimeInLong": 1786905600000,
                    }],
                },
            },
        }
        normalized = SchwabHTTPClient.normalize_option_chain(payload, as_of="2026-08-16")
        self.assertEqual(len(normalized), 1)
        self.assertAlmostEqual(float(normalized.call_bid.iloc[0]), 4.8)
        self.assertAlmostEqual(float(normalized.put_ask.iloc[0]), 4.3)
        self.assertAlmostEqual(float(normalized.call_iv.iloc[0]), 0.31)
        self.assertEqual(normalized.expiry_date.iloc[0], "2026-09-18")
        self.assertAlmostEqual(float(normalized.put_delta.iloc[0]), -0.45)

    def test_schwab_quote_normalizer_builds_market_state(self) -> None:
        state = SchwabHTTPClient.normalize_underlying_quote("AAPL", {
            "AAPL": {"quote": {
                "mark": 231.5,
                "closePrice": 229.0,
                "highPrice": 233.0,
                "lowPrice": 227.5,
                "totalVolume": 50_000_000,
            }},
        })
        self.assertAlmostEqual(state.spot, 231.5)
        self.assertAlmostEqual(state.previous_close or 0.0, 229.0)
        self.assertAlmostEqual(state.stock_dollar_volume or 0.0, 11_575_000_000.0)

    def test_schwab_snapshot_reuses_chain_underlying_quote(self) -> None:
        urls: list[str] = []

        def transport(url: str, _headers: Mapping[str, str]) -> Mapping[str, Any]:
            urls.append(url)
            return {
                "underlying": {
                    "symbol": "AAPL",
                    "mark": 231.5,
                    "close": 229.0,
                    "highPrice": 233.0,
                    "lowPrice": 227.5,
                    "totalVolume": 50_000_000,
                },
                "callExpDateMap": {},
                "putExpDateMap": {},
            }

        client = SchwabHTTPClient(token_provider=lambda: "test", transport=transport)
        chain, state = client.fetch_market_snapshot("AAPL", strike_count=40)
        self.assertTrue(chain.empty)
        self.assertAlmostEqual(state.spot, 231.5)
        self.assertEqual(len(urls), 1)
        self.assertIn("/marketdata/v1/chains?", urls[0])
        self.assertIn("includeUnderlyingQuote=true", urls[0])

    def test_schwab_snapshot_uses_the_latest_source_quote_timestamp(self) -> None:
        quotes = pd.DataFrame({
            "call_quote_timestamp": [pd.Timestamp("2026-08-18T16:44:41Z"), pd.NaT],
            "put_quote_timestamp": [pd.Timestamp("2026-08-18T16:44:43Z"), pd.NaT],
        })
        self.assertEqual(latest_quote_timestamp(quotes), "2026-08-18T16:44:43+00:00")


if __name__ == "__main__":
    unittest.main()
