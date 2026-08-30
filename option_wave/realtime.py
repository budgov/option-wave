"""Low-latency, read-only Schwab inference runtime for Ocean Wave."""

from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
import uuid
from time import perf_counter
from typing import Any

import numpy as np
import pandas as pd

from . import OceanWave, assess_contract
from ._atomic_io import replace_with_retry
from ._backend import HAS_CPP_CORE
from .schwab_api import SchwabHTTPClient, SchwabHTTPConfig, latest_quote_timestamp
from .shadow_calibration import ShadowCalibrator

SYMBOL_PATTERN = re.compile(r"[A-Z][A-Z0-9.\-]{0,14}")
CHAIN_STATE_COLUMNS = (
    "strike", "expiry_days", "expiry_date",
    "call_symbol", "put_symbol", "contract_symbol",
    "call_oi", "put_oi",
)
CONTEXT_COLUMNS = (
    "strike", "expiry_days", "expiry_date",
    "call_bid", "call_ask", "call_last", "call_volume", "call_oi", "call_iv",
    "call_delta", "call_gamma", "call_theta", "call_vega",
    "put_bid", "put_ask", "put_last", "put_volume", "put_oi", "put_iv",
    "put_delta", "put_gamma", "put_theta", "put_vega",
    "call_quote_timestamp", "put_quote_timestamp",
)
GEX_HISTORY_LIMIT = 64
GEX_BASELINE_MIN_SAMPLES = 5
GEX_ANOMALY_MULTIPLIER = 50.0
OI_HISTORY_LIMIT = 64
OI_BASELINE_MIN_SAMPLES = 5
OI_ANOMALY_MULTIPLIER = 50.0
OI_ABSOLUTE_PER_CONTRACT_LIMIT = 50_000_000.0
OI_ABSOLUTE_GROSS_LIMIT = 2_000_000_000.0


@dataclass(frozen=True)
class ChainQualityAudit:
    accepted: bool
    evidence_quality: float
    gex_gross: float
    oi_gross: float
    max_open_interest: float
    quote_coverage: float
    iv_coverage: float
    greek_coverage: float
    reasons: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "accepted": self.accepted,
            "evidence_quality": self.evidence_quality,
            "gex_gross": self.gex_gross,
            "oi_gross": self.oi_gross,
            "max_open_interest": self.max_open_interest,
            "quote_coverage": self.quote_coverage,
            "iv_coverage": self.iv_coverage,
            "greek_coverage": self.greek_coverage,
            "reasons": list(self.reasons),
        }


def _audit_numbers(frame: pd.DataFrame, name: str) -> tuple[np.ndarray, np.ndarray]:
    if name not in frame:
        return np.full(len(frame), np.nan, dtype=float), np.zeros(len(frame), dtype=bool)
    source_present = frame[name].notna().to_numpy(bool)
    return pd.to_numeric(frame[name], errors="coerce").to_numpy(float), source_present


def audit_option_chain(chain: pd.DataFrame, spot: float) -> ChainQualityAudit:
    """Validate explicit option evidence before any online state can mutate.

    Missing vendor fields reduce evidence quality but are not fabricated into
    hard errors. Explicit impossible values (crossed/negative quotes, invalid
    IV, signs outside option Greek domains, negative OI) quarantine the whole
    snapshot because mixing them into ELO/covariance state is irreversible.
    """

    reasons: list[str] = []
    rows = len(chain)
    strike, strike_present = _audit_numbers(chain, "strike")
    if rows == 0:
        reasons.append("empty_chain")
    if not np.isfinite(spot) or spot <= 0.0:
        reasons.append("invalid_spot")
    if rows and np.any(~strike_present | ~np.isfinite(strike) | (strike <= 0.0)):
        reasons.append("invalid_strike")

    valid_quote_total = 0
    valid_iv_total = 0
    valid_greek_total = 0
    possible_quote_total = max(rows * 2, 1)
    possible_iv_total = max(rows * 2, 1)
    possible_greek_total = max(rows * 4, 1)
    gex_gross = 0.0
    oi_gross = 0.0
    max_open_interest = 0.0
    expiry, _ = _audit_numbers(chain, "expiry_days")
    expiry = np.maximum(np.nan_to_num(expiry, nan=0.0), 0.0)
    safe_spot = float(spot) if np.isfinite(spot) and spot > 0.0 else 1.0
    safe_strike = np.maximum(np.nan_to_num(strike, nan=safe_spot), 1e-12)
    base_weight = np.exp(-np.abs(np.log(safe_strike / safe_spot)) / 0.08) * np.exp(-expiry / 45.0)

    for side in ("call", "put"):
        bid, bid_present = _audit_numbers(chain, f"{side}_bid")
        ask, ask_present = _audit_numbers(chain, f"{side}_ask")
        invalid_numeric_quote = (
            (bid_present & ~np.isfinite(bid))
            | (ask_present & ~np.isfinite(ask))
        )
        if np.any(invalid_numeric_quote):
            reasons.append(f"{side}_nonfinite_quote")
        valid_quote = (
            np.isfinite(bid) & np.isfinite(ask)
            & (bid >= 0.0) & (ask > 0.0) & (ask >= bid)
        )
        impossible_quote = (
            np.isfinite(bid) & np.isfinite(ask)
            & ((bid < 0.0) | (ask < 0.0) | (ask < bid))
        )
        if np.any(impossible_quote):
            reasons.append(f"{side}_invalid_bid_ask")
        valid_quote_total += int(np.count_nonzero(valid_quote))

        iv, iv_present = _audit_numbers(chain, f"{side}_iv")
        # A vendor may publish IV=0 for an uncomputed deep-OTM contract. It is
        # missing evidence (not valid IV), but not by itself corrupt data.
        invalid_iv = iv_present & (~np.isfinite(iv) | (iv < 0.0) | (iv > 10.0))
        if np.any(invalid_iv):
            reasons.append(f"{side}_invalid_iv")
        valid_iv_total += int(np.count_nonzero(np.isfinite(iv) & (iv > 0.0) & (iv <= 10.0)))

        delta, delta_present = _audit_numbers(chain, f"{side}_delta")
        gamma, gamma_present = _audit_numbers(chain, f"{side}_gamma")
        vega, vega_present = _audit_numbers(chain, f"{side}_vega")
        theta, theta_present = _audit_numbers(chain, f"{side}_theta")
        delta_min, delta_max = (-0.05, 1.05) if side == "call" else (-1.05, 0.05)
        if np.any(delta_present & (~np.isfinite(delta) | (delta < delta_min) | (delta > delta_max))):
            reasons.append(f"{side}_invalid_delta")
        if np.any(gamma_present & (~np.isfinite(gamma) | (gamma < 0.0))):
            reasons.append(f"{side}_invalid_gamma")
        if np.any(vega_present & (~np.isfinite(vega) | (vega < 0.0))):
            reasons.append(f"{side}_invalid_vega")
        if np.any(theta_present & ~np.isfinite(theta)):
            reasons.append(f"{side}_invalid_theta")
        valid_greek_total += int(np.count_nonzero(np.isfinite(delta) & (delta >= delta_min) & (delta <= delta_max)))
        valid_greek_total += int(np.count_nonzero(np.isfinite(gamma) & (gamma >= 0.0)))

        oi, oi_present = _audit_numbers(chain, f"{side}_oi")
        if np.any(oi_present & (~np.isfinite(oi) | (oi < 0.0))):
            reasons.append(f"{side}_invalid_open_interest")
        valid_oi = np.isfinite(oi) & (oi >= 0.0)
        if np.any(valid_oi):
            oi_gross += float(np.sum(oi[valid_oi]))
            max_open_interest = max(max_open_interest, float(np.max(oi[valid_oi])))
        valid_gex = np.isfinite(oi) & (oi >= 0.0) & np.isfinite(gamma) & (gamma >= 0.0)
        if np.any(valid_gex):
            gex_gross += float(np.sum(
                oi[valid_gex] * gamma[valid_gex] * 100.0 * safe_spot * safe_spot * base_weight[valid_gex]
            ))

    if max_open_interest > OI_ABSOLUTE_PER_CONTRACT_LIMIT:
        reasons.append("open_interest_exceeds_per_contract_limit")
    if oi_gross > OI_ABSOLUTE_GROSS_LIMIT:
        reasons.append("open_interest_exceeds_gross_limit")

    quote_coverage = float(valid_quote_total / possible_quote_total)
    iv_coverage = float(valid_iv_total / possible_iv_total)
    greek_coverage = float(valid_greek_total / possible_greek_total)
    if rows and valid_quote_total == 0:
        reasons.append("no_valid_two_sided_quotes")
    evidence_quality = float(np.clip(
        0.50 * quote_coverage + 0.25 * iv_coverage + 0.25 * greek_coverage,
        0.0,
        1.0,
    ))
    unique_reasons = tuple(dict.fromkeys(reasons))
    return ChainQualityAudit(
        accepted=not unique_reasons,
        evidence_quality=evidence_quality,
        gex_gross=max(float(gex_gross), 0.0),
        oi_gross=max(float(oi_gross), 0.0),
        max_open_interest=max(float(max_open_interest), 0.0),
        quote_coverage=quote_coverage,
        iv_coverage=iv_coverage,
        greek_coverage=greek_coverage,
        reasons=unique_reasons,
    )


def assess_gex_history(gex_gross: float, history: tuple[float, ...]) -> dict[str, Any]:
    baseline_values = np.asarray(
        [value for value in history if np.isfinite(value) and value > 0.0],
        dtype=float,
    )
    baseline = float(np.median(baseline_values)) if baseline_values.size else None
    ratio = (
        float(gex_gross / baseline)
        if baseline is not None and baseline > 0.0 and np.isfinite(gex_gross)
        else None
    )
    baseline_ready = bool(baseline_values.size >= GEX_BASELINE_MIN_SAMPLES)
    quarantined = bool(
        baseline_ready
        and ratio is not None
        and ratio > GEX_ANOMALY_MULTIPLIER
    )
    return {
        "baseline_ready": baseline_ready,
        "history_samples": int(baseline_values.size),
        "robust_baseline": baseline,
        "current_to_baseline_ratio": ratio,
        "quarantine_multiplier": GEX_ANOMALY_MULTIPLIER,
        "quarantined": quarantined,
        "cold_start_guard": not baseline_ready,
    }


def _gross_open_interest(chain: pd.DataFrame | None) -> float | None:
    if chain is None or chain.empty:
        return None
    total = 0.0
    observed = False
    for side in ("call", "put"):
        values, present = _audit_numbers(chain, f"{side}_oi")
        valid = present & np.isfinite(values) & (values >= 0.0)
        if np.any(valid):
            total += float(np.sum(values[valid]))
            observed = True
    return total if observed else None


def _oi_lookup(frame: pd.DataFrame, side: str) -> pd.Series:
    values, present = _audit_numbers(frame, f"{side}_oi")
    symbol_column = f"{side}_symbol"
    if symbol_column in frame:
        symbols = frame[symbol_column].astype("string").str.strip().str.upper()
        valid = present & np.isfinite(values) & symbols.notna().to_numpy() & symbols.ne("").to_numpy()
        if np.any(valid):
            return pd.Series(values[valid], index=symbols[valid]).groupby(level=0, sort=False).last()
    if "expiry_date" in frame and "strike" in frame:
        expiries = pd.to_datetime(frame["expiry_date"], errors="coerce").dt.strftime("%Y-%m-%d")
        strikes = pd.to_numeric(frame["strike"], errors="coerce")
        valid = present & np.isfinite(values) & expiries.notna().to_numpy() & np.isfinite(strikes.to_numpy(float))
        if np.any(valid):
            index = pd.MultiIndex.from_arrays([expiries[valid], strikes[valid]])
            return pd.Series(values[valid], index=index).groupby(level=[0, 1], sort=False).last()
    return pd.Series(dtype=float)


def open_interest_change_gross(
    chain: pd.DataFrame,
    previous_chain: pd.DataFrame | None,
) -> tuple[float | None, int]:
    """Return gross matched-contract OI change without positional guessing."""

    if previous_chain is None or previous_chain.empty:
        return None, 0
    total = 0.0
    matched = 0
    for side in ("call", "put"):
        current = _oi_lookup(chain, side)
        previous = _oi_lookup(previous_chain, side)
        shared = current.index.intersection(previous.index)
        if len(shared):
            total += float(np.abs(current.reindex(shared).to_numpy() - previous.reindex(shared).to_numpy()).sum())
            matched += len(shared)
    return (total, matched) if matched else (None, 0)


def assess_oi_history(
    oi_gross: float,
    history: tuple[float, ...],
    *,
    previous_oi_gross: float | None = None,
    oi_change_gross: float | None = None,
    matched_contracts: int = 0,
) -> dict[str, Any]:
    """Bound gross OI and matched-contract changes before online learning."""

    baseline_values = np.asarray(
        [value for value in history if np.isfinite(value) and value > 0.0],
        dtype=float,
    )
    baseline = float(np.median(baseline_values)) if baseline_values.size else None
    ratio = (
        float(oi_gross / baseline)
        if baseline is not None and baseline > 0.0 and np.isfinite(oi_gross)
        else None
    )
    previous_ratio = (
        float(abs(oi_gross - previous_oi_gross) / previous_oi_gross)
        if previous_oi_gross is not None and previous_oi_gross > 0.0
        else None
    )
    change_ratio = (
        float(oi_change_gross / previous_oi_gross)
        if oi_change_gross is not None
        and previous_oi_gross is not None
        and previous_oi_gross > 0.0
        else None
    )
    baseline_ready = bool(baseline_values.size >= OI_BASELINE_MIN_SAMPLES)
    reasons: list[str] = []
    if baseline_ready and ratio is not None and ratio > OI_ANOMALY_MULTIPLIER:
        reasons.append("oi_gross_extreme_outlier")
    if previous_ratio is not None and previous_ratio > OI_ANOMALY_MULTIPLIER:
        reasons.append("oi_gross_change_extreme_outlier")
    if change_ratio is not None and change_ratio > OI_ANOMALY_MULTIPLIER:
        reasons.append("oi_contract_change_extreme_outlier")
    if oi_change_gross is not None and oi_change_gross > OI_ABSOLUTE_GROSS_LIMIT:
        reasons.append("oi_contract_change_exceeds_absolute_limit")
    return {
        "baseline_ready": baseline_ready,
        "history_samples": int(baseline_values.size),
        "robust_baseline": baseline,
        "current_to_baseline_ratio": ratio,
        "change_to_previous_ratio": previous_ratio,
        "matched_change_to_previous_ratio": change_ratio,
        "matched_change_gross": oi_change_gross,
        "matched_contracts": int(matched_contracts),
        "quarantine_multiplier": OI_ANOMALY_MULTIPLIER,
        "quarantined": bool(reasons),
        "reasons": reasons,
        "cold_start_guard": not baseline_ready,
    }


def json_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, np.ndarray):
        return json_value(value.tolist())
    if isinstance(value, np.generic):
        return json_value(value.item())
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if value is pd.NaT or (isinstance(value, float) and not np.isfinite(value)):
        return None
    return value


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"invalid JSON state: {path}")
    return payload


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(json_value(payload), stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        replace_with_retry(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def validate_symbol(value: str) -> str:
    symbol = str(value).strip().upper()
    if not SYMBOL_PATTERN.fullmatch(symbol):
        raise ValueError("invalid underlying symbol")
    return symbol


def validate_horizons(values: tuple[float, ...]) -> tuple[float, ...]:
    horizons = tuple(float(value) for value in values)
    if not horizons or any(not np.isfinite(value) or value <= 0 for value in horizons):
        raise ValueError("horizons must be positive")
    return horizons


MARKET_STATE_OVERRIDE_FIELDS = {
    "high", "low", "vwap", "rvol", "realized_vol", "minutes_from_open",
    "minutes_to_close_total", "previous_close", "return_5m", "return_15m",
    "stock_volume", "stock_dollar_volume", "data_confidence",
}


def apply_market_state_overrides(state: Any, overrides: dict[str, Any] | None) -> Any:
    """Merge causal intraday features without allowing spot/symbol replacement."""

    if overrides is None:
        return state
    if not isinstance(overrides, dict):
        raise ValueError("market_state_overrides must be an object")
    unknown = set(overrides) - MARKET_STATE_OVERRIDE_FIELDS
    if unknown:
        raise ValueError(f"unsupported market state override: {sorted(unknown)[0]}")
    normalized: dict[str, float | None] = {}
    for key, raw in overrides.items():
        if raw is None:
            normalized[key] = None
            continue
        value = float(raw)
        if not np.isfinite(value):
            raise ValueError(f"market state override {key} must be finite")
        normalized[key] = value
    if normalized.get("rvol") is not None and normalized["rvol"] < 0.0:
        raise ValueError("rvol cannot be negative")
    if normalized.get("realized_vol") is not None and normalized["realized_vol"] < 0.0:
        raise ValueError("realized_vol cannot be negative")
    if normalized.get("data_confidence") is not None:
        normalized["data_confidence"] = float(np.clip(normalized["data_confidence"], 0.0, 1.0))
    return replace(state, **normalized)


def compact_previous_chain(chain: pd.DataFrame) -> pd.DataFrame:
    columns = [column for column in CHAIN_STATE_COLUMNS if column in chain]
    return chain.loc[:, columns].copy()


def _context_records(frame: pd.DataFrame) -> list[dict[str, Any]]:
    columns = [column for column in CONTEXT_COLUMNS if column in frame]
    return json_value(frame.loc[:, columns].to_dict(orient="records"))


def build_chain_context(
    chain: pd.DataFrame,
    spot: float,
    requested_expiry: str | None,
    requested_strike: float | None,
    row_limit: int = 16,
) -> dict[str, Any]:
    expiry_dates = sorted({str(value) for value in chain.get("expiry_date", []) if pd.notna(value)})
    at_the_money = []
    if "expiry_date" in chain and "strike" in chain:
        for _expiry_date, group in chain.groupby("expiry_date", sort=True):
            index = (pd.to_numeric(group["strike"], errors="coerce") - spot).abs().idxmin()
            at_the_money.extend(_context_records(chain.loc[[index]]))

    nearby = chain
    if requested_expiry and "expiry_date" in nearby:
        exact_expiry = nearby[nearby["expiry_date"].astype(str) == requested_expiry]
        if not exact_expiry.empty:
            nearby = exact_expiry
    elif "expiry_days" in nearby and not nearby.empty:
        nearest_days = pd.to_numeric(nearby["expiry_days"], errors="coerce").min()
        nearby = nearby[pd.to_numeric(nearby["expiry_days"], errors="coerce") == nearest_days]
    center = float(requested_strike) if requested_strike is not None else float(spot)
    if "strike" in nearby:
        nearby = nearby.assign(_distance=(pd.to_numeric(nearby["strike"], errors="coerce") - center).abs())
        nearby = nearby.sort_values(["_distance", "strike"]).head(max(1, int(row_limit))).drop(columns=["_distance"])

    return {
        "row_count": int(len(chain)),
        "expiry_count": len(expiry_dates),
        "expiry_dates": expiry_dates,
        "at_the_money_by_expiry": at_the_money,
        "nearby_contracts": _context_records(nearby),
        "nearby_contract_limit": max(1, int(row_limit)),
    }


@dataclass
class SymbolRuntime:
    model: OceanWave
    previous_chain: pd.DataFrame | None
    dirty: bool = False
    gex_history: tuple[float, ...] = ()
    oi_history: tuple[float, ...] = ()


class RealtimePredictor:
    """Keeps imports and online model state warm between read-only requests."""

    def __init__(
        self,
        state_dir: Path,
        *,
        max_symbols: int = 32,
        async_checkpoints: bool = True,
        require_native_core: bool = True,
        feedback_learning_rate: float = 0.025,
        feedback_minimum_samples: int = 30,
        feedback_minimum_promotion_samples: int = 500,
        feedback_minimum_valid_days: int = 40,
    ) -> None:
        if require_native_core and not HAS_CPP_CORE:
            raise RuntimeError("Ocean Wave C++ core is required for realtime inference")
        self.state_dir = Path(state_dir).resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.max_symbols = max(1, int(max_symbols))
        self.async_checkpoints = bool(async_checkpoints)
        self._symbols: OrderedDict[str, SymbolRuntime] = OrderedDict()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocean-wave-checkpoint")
        # Only the newest submitted write for each symbol needs to be retained:
        # the single-thread executor guarantees that every older write runs
        # before it.  A symbol-specific tail also acts as a read/write barrier
        # when LRU eviction is followed by an immediate reload.
        self._checkpoints: dict[str, Future[None]] = {}
        self._checkpoint_failures: dict[str, Exception] = {}
        self._closed = False
        self._calibrator = ShadowCalibrator(
            self.state_dir,
            learning_rate=feedback_learning_rate,
            minimum_samples=feedback_minimum_samples,
            minimum_promotion_samples=feedback_minimum_promotion_samples,
            minimum_valid_days=feedback_minimum_valid_days,
        )

    def _legacy_paths(self, symbol: str) -> tuple[Path, Path]:
        return self.state_dir / f"{symbol}.model.json", self.state_dir / f"{symbol}.chain.json"

    def _state_path(self, symbol: str) -> Path:
        return self.state_dir / f"{symbol}.state.json"

    def _load(self, symbol: str) -> SymbolRuntime:
        cached = self._symbols.pop(symbol, None)
        if cached is not None:
            self._symbols[symbol] = cached
            return cached

        # An evicted runtime may still have an atomic write queued.  Loading
        # before that write completes would silently replace its model/chain
        # with an empty runtime.
        self._wait_for_checkpoint(symbol)
        state_payload = read_json(self._state_path(symbol))
        migrating_legacy = state_payload is None
        if state_payload is not None:
            if state_payload.get("schema_version") != "ocean-wave-runtime-state.v1":
                raise ValueError(f"invalid combined Ocean Wave state for {symbol}")
            model_payload = state_payload.get("model")
            chain_payload = state_payload.get("chain")
        else:
            # One-time compatibility path for deployments created before the
            # model and previous chain were checkpointed as one atomic unit.
            model_path, chain_path = self._legacy_paths(symbol)
            model_payload = read_json(model_path)
            chain_payload = read_json(chain_path)
        model = OceanWave()
        if model_payload is not None:
            if not isinstance(model_payload, dict):
                raise ValueError(f"invalid Ocean Wave model state for {symbol}")
            model.load_state_dict(model_payload)
        previous_chain = None
        if isinstance(chain_payload, dict) and isinstance(chain_payload.get("rows"), list):
            previous_chain = pd.DataFrame(chain_payload["rows"])
        quality_payload = state_payload.get("quality_state") if state_payload is not None else None
        history_values = quality_payload.get("accepted_gex_gross", []) if isinstance(quality_payload, dict) else []
        gex_history = tuple(
            value
            for value in (float(item) for item in history_values)
            if np.isfinite(value) and value > 0.0
        )[-GEX_HISTORY_LIMIT:]
        oi_history_values = quality_payload.get("accepted_oi_gross", []) if isinstance(quality_payload, dict) else []
        oi_history = tuple(
            value
            for value in (float(item) for item in oi_history_values)
            if np.isfinite(value) and value > 0.0
        )[-OI_HISTORY_LIMIT:]
        runtime = SymbolRuntime(
            model=model,
            previous_chain=previous_chain,
            dirty=bool(migrating_legacy and (model_payload is not None or chain_payload is not None)),
            gex_history=gex_history,
            oi_history=oi_history,
        )
        self._symbols[symbol] = runtime

        while len(self._symbols) > self.max_symbols:
            evicted_symbol, evicted = self._symbols.popitem(last=False)
            if evicted.dirty:
                self._checkpoint(evicted_symbol, evicted, asynchronous=False)
        return runtime

    def _reap_checkpoints(self) -> None:
        first_error: Exception | None = None
        for symbol, future in list(self._checkpoints.items()):
            if not future.done():
                continue
            try:
                future.result()
                self._checkpoint_failures.pop(symbol, None)
            except Exception as error:
                self._checkpoint_failures[symbol] = error
                first_error = first_error or error
            finally:
                if self._checkpoints.get(symbol) is future:
                    self._checkpoints.pop(symbol, None)
        if first_error is not None:
            raise first_error

    def _wait_for_checkpoint(self, symbol: str, *, ignore_failure: bool = False) -> None:
        future = self._checkpoints.get(symbol)
        if future is not None:
            try:
                future.result()
                self._checkpoint_failures.pop(symbol, None)
            except Exception as error:
                self._checkpoint_failures[symbol] = error
            finally:
                if self._checkpoints.get(symbol) is future:
                    self._checkpoints.pop(symbol, None)
        failure = self._checkpoint_failures.get(symbol)
        if failure is not None and not ignore_failure:
            raise failure

    def _checkpoint(self, symbol: str, runtime: SymbolRuntime, *, asynchronous: bool) -> None:
        state_path = self._state_path(symbol)
        captured_at = datetime.now(timezone.utc).isoformat()
        state_payload = {
            "schema_version": "ocean-wave-runtime-state.v1",
            "checkpoint_generation": str(uuid.uuid4()),
            "captured_at": captured_at,
            "model": runtime.model.state_dict(),
            "chain": {
                "schema_version": "ocean-wave-chain-state.v2",
                "captured_at": captured_at,
                "rows": [] if runtime.previous_chain is None else json_value(runtime.previous_chain.to_dict(orient="records")),
            },
            "quality_state": {
                "schema_version": "ocean-wave-chain-quality-state.v1",
                "accepted_gex_gross": list(runtime.gex_history[-GEX_HISTORY_LIMIT:]),
                "accepted_oi_gross": list(runtime.oi_history[-OI_HISTORY_LIMIT:]),
            },
        }

        def write() -> None:
            write_json_atomic(state_path, state_payload)

        if asynchronous and self.async_checkpoints:
            self._reap_checkpoints()
            self._checkpoints[symbol] = self._executor.submit(write)
        else:
            # A newer synchronous bundle must never be overwritten later by an
            # older queued asynchronous bundle for the same symbol.
            self._wait_for_checkpoint(symbol, ignore_failure=True)
            try:
                write()
            except Exception as error:
                runtime.dirty = True
                self._checkpoint_failures[symbol] = error
                raise
            self._checkpoint_failures.pop(symbol, None)
        runtime.dirty = False

    def quote(
        self,
        *,
        symbol: str,
        signal_published_at: str,
        access_token: str,
    ) -> dict[str, Any]:
        """Fetch only the underlying quote without loading or mutating model state."""

        started = perf_counter()
        symbol = validate_symbol(symbol)
        if not access_token:
            raise ValueError("Schwab access token is missing")

        fetch_started = perf_counter()
        client = SchwabHTTPClient(SchwabHTTPConfig(access_token=access_token))
        market_state = client.fetch_underlying_state(symbol)
        captured_at = datetime.now(timezone.utc).isoformat()
        fetch_ms = (perf_counter() - fetch_started) * 1000.0
        output = {
            "schema_version": "ocean-wave-snapshot.v2",
            "provider": "schwab",
            "data_tier": "realtime_underlying",
            "symbol": symbol,
            "signal_published_at": signal_published_at,
            "observed_at": captured_at,
            "as_of": captured_at,
            "captured_at": captured_at,
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "execution_eligible": False,
            "context_only": True,
            "market_state": asdict(market_state),
            "target_contract": None,
            "contract_assessment": None,
            "greeks": None,
            "iv": None,
            "term_structure": None,
            "events": None,
            "chain_context": None,
            "ocean_wave": None,
            "runtime": {
                "worker_mode": "persistent" if self.async_checkpoints else "single_shot",
                "operation": "quote_only",
                "fetch_ms": round(fetch_ms, 3),
                "model_ms": 0.0,
                "total_ms": round((perf_counter() - started) * 1000.0, 3),
                "prediction_ran": False,
                "checkpoint": "none",
            },
            "provenance": {
                "source": "Schwab Trader API",
                "quote_fields": "underlying quote endpoint only",
                "state_schema": None,
                "orders_enabled": False,
            },
        }
        return json_value(output)

    def predict(
        self,
        *,
        symbol: str,
        signal_published_at: str,
        access_token: str,
        horizons: tuple[float, ...],
        strike_count: int,
        expiry: str | None = None,
        strike: float | None = None,
        option_type: str | None = None,
        market_state_overrides: dict[str, Any] | None = None,
        checkpoint_async: bool | None = None,
    ) -> dict[str, Any]:
        started = perf_counter()
        symbol = validate_symbol(symbol)
        horizons = validate_horizons(horizons)
        if not access_token:
            raise ValueError("Schwab access token is missing")
        if option_type not in {None, "call", "put"}:
            raise ValueError("invalid option type")
        strike_count = int(strike_count)
        if strike_count < 1 or strike_count > 500:
            raise ValueError("strike count is outside the allowed range")

        runtime = self._load(symbol)
        fetch_started = perf_counter()
        client = SchwabHTTPClient(SchwabHTTPConfig(access_token=access_token))
        chain, market_state = client.fetch_market_snapshot(symbol, strike_count=strike_count)
        market_state = apply_market_state_overrides(market_state, market_state_overrides)
        captured_at = datetime.now(timezone.utc).isoformat()
        fetch_ms = (perf_counter() - fetch_started) * 1000.0
        if chain.empty:
            raise ValueError(f"Schwab returned an empty option chain for {symbol}")

        # This gate must run before OceanWave.predict(): that method updates
        # both ELO ratings and the factor covariance as part of inference.
        # Rejected snapshots therefore cannot contaminate any online state or
        # replace the last accepted chain used for OI deltas.
        quality_audit = audit_option_chain(chain, market_state.spot)
        quality_diagnostics = quality_audit.to_dict()
        gex_diagnostics = assess_gex_history(quality_audit.gex_gross, runtime.gex_history)
        quality_diagnostics["gex_history"] = gex_diagnostics
        oi_change, matched_contracts = open_interest_change_gross(chain, runtime.previous_chain)
        oi_diagnostics = assess_oi_history(
            quality_audit.oi_gross,
            runtime.oi_history,
            previous_oi_gross=_gross_open_interest(runtime.previous_chain),
            oi_change_gross=oi_change,
            matched_contracts=matched_contracts,
        )
        quality_diagnostics["oi_history"] = oi_diagnostics
        quarantine_reasons = list(quality_audit.reasons)
        if gex_diagnostics["quarantined"]:
            quarantine_reasons.append("gex_gross_extreme_outlier")
        quarantine_reasons.extend(oi_diagnostics["reasons"])
        if quarantine_reasons:
            quality_diagnostics["accepted"] = False
            quality_diagnostics["reasons"] = quarantine_reasons
            observed_at = latest_quote_timestamp(chain) or captured_at
            return json_value({
                "schema_version": "ocean-wave-snapshot.v2",
                "provider": "schwab",
                "data_tier": "realtime",
                "symbol": symbol,
                "signal_published_at": signal_published_at,
                "observed_at": observed_at,
                "as_of": observed_at,
                "captured_at": captured_at,
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "execution_eligible": False,
                "quarantined": True,
                "quarantine_reasons": quarantine_reasons,
                "market_state": asdict(market_state),
                "target_contract": None,
                "contract_assessment": None,
                "events": None,
                "chain_context": None,
                "chain_quality": quality_diagnostics,
                "ocean_wave": None,
                "runtime": {
                    "worker_mode": "persistent" if self.async_checkpoints else "single_shot",
                    "operation": "predict",
                    "prediction_ran": False,
                    "fetch_ms": round(fetch_ms, 3),
                    "model_ms": 0.0,
                    "total_ms": round((perf_counter() - started) * 1000.0, 3),
                    "checkpoint": "none",
                    "state_updated": False,
                },
                "provenance": {
                    "source": "Schwab Trader API",
                    "quote_fields": "option chain and included underlying quote",
                    "state_schema": "ocean-wave-runtime-state.v1",
                    "orders_enabled": False,
                    "intraday_market_state_overrides": sorted(market_state_overrides or {}),
                },
            })

        quality_multiplier = 0.80 if oi_diagnostics["cold_start_guard"] else 1.0
        effective_chain_quality = float(np.clip(
            quality_audit.evidence_quality * quality_multiplier,
            0.0,
            1.0,
        ))
        quality_diagnostics["effective_evidence_quality"] = effective_chain_quality
        quality_diagnostics["oi_cold_start_quality_multiplier"] = quality_multiplier
        current_data_confidence = getattr(market_state, "data_confidence", 1.0)
        current_data_confidence = (
            float(current_data_confidence)
            if current_data_confidence is not None and np.isfinite(current_data_confidence)
            else 0.0
        )
        market_state = replace(
            market_state,
            data_confidence=min(current_data_confidence, effective_chain_quality),
        )
        model_started = perf_counter()
        result = runtime.model.predict(chain, market_state, previous_chain=runtime.previous_chain, horizons_minutes=horizons)
        runtime.previous_chain = compact_previous_chain(chain)
        if quality_audit.gex_gross > 0.0:
            runtime.gex_history = (
                *runtime.gex_history,
                quality_audit.gex_gross,
            )[-GEX_HISTORY_LIMIT:]
        if quality_audit.oi_gross > 0.0:
            runtime.oi_history = (
                *runtime.oi_history,
                quality_audit.oi_gross,
            )[-OI_HISTORY_LIMIT:]
        runtime.dirty = True
        model_ms = (perf_counter() - model_started) * 1000.0

        target_contract = None
        contract_assessment = None
        observed_at = latest_quote_timestamp(chain) or captured_at
        resolved_expiry = expiry
        expiry_inferred = False
        if not resolved_expiry and "expiry_date" in chain and "expiry_days" in chain:
            expiry_table = chain.loc[:, ["expiry_date", "expiry_days"]].copy()
            expiry_table["expiry_days"] = pd.to_numeric(expiry_table["expiry_days"], errors="coerce")
            expiry_table = expiry_table.dropna(subset=["expiry_date", "expiry_days"])
            expiry_table = expiry_table[expiry_table["expiry_days"] >= 0.0]
            if not expiry_table.empty:
                nearest_days = float(expiry_table["expiry_days"].min())
                resolved_expiry = str(expiry_table.loc[expiry_table["expiry_days"] == nearest_days, "expiry_date"].astype(str).min())
                expiry_inferred = True
        if strike is not None:
            requested_strike = float(strike)
            candidates = chain
            if resolved_expiry and "expiry_date" in candidates:
                candidates = candidates[candidates["expiry_date"].astype(str) == resolved_expiry]
            target_contract = {
                "requested": {"expiry": expiry, "strike": requested_strike, "option_type": option_type},
                "resolved": {
                    "expiry": resolved_expiry,
                    "expiry_inferred": expiry_inferred,
                    "expiry_policy": "nearest_listed_expiry" if expiry_inferred else "explicit",
                },
                "matched": None,
                "exact_expiry_match": False,
                "exact_strike_match": False,
                "exact_option_type_match": option_type is not None,
            }
            if candidates.empty:
                contract_assessment = assess_contract(result, None, exact_match=False).to_dict()
            else:
                chosen_index = (pd.to_numeric(candidates["strike"], errors="coerce") - requested_strike).abs().idxmin()
                chosen = candidates.loc[chosen_index]
                prefix = option_type or "call"
                matched = {
                    "expiry": chosen.get("expiry_date"), "expiry_days": chosen.get("expiry_days"),
                    "strike": chosen.get("strike"), "option_type": prefix,
                    "bid": chosen.get(f"{prefix}_bid"), "ask": chosen.get(f"{prefix}_ask"),
                    "last": chosen.get(f"{prefix}_last"), "volume": chosen.get(f"{prefix}_volume"),
                    "open_interest": chosen.get(f"{prefix}_oi"), "iv": chosen.get(f"{prefix}_iv"),
                    "delta": chosen.get(f"{prefix}_delta"), "gamma": chosen.get(f"{prefix}_gamma"),
                    "theta": chosen.get(f"{prefix}_theta"), "vega": chosen.get(f"{prefix}_vega"),
                    "rho": chosen.get(f"{prefix}_rho"),
                    "quote_timestamp": chosen.get(f"{prefix}_quote_timestamp"),
                    "trade_timestamp": chosen.get(f"{prefix}_trade_timestamp"),
                }
                target_contract = {
                    "requested": {"expiry": expiry, "strike": requested_strike, "option_type": option_type},
                    "resolved": {
                        "expiry": resolved_expiry,
                        "expiry_inferred": expiry_inferred,
                        "expiry_policy": "nearest_listed_expiry" if expiry_inferred else "explicit",
                    },
                    "matched": matched,
                    "exact_expiry_match": resolved_expiry is not None and str(chosen.get("expiry_date")) == resolved_expiry,
                    "exact_strike_match": abs(float(chosen.get("strike")) - requested_strike) < 1e-9,
                    "exact_option_type_match": option_type is not None,
                }
                quote_timestamp = matched.get("quote_timestamp")
                if quote_timestamp is not None and not pd.isna(quote_timestamp):
                    observed_at = pd.Timestamp(quote_timestamp).isoformat()
                contract_assessment = assess_contract(
                    result,
                    matched,
                    exact_match=bool(target_contract["exact_expiry_match"] and target_contract["exact_strike_match"] and target_contract["exact_option_type_match"]),
                ).to_dict()

        matched_quote = target_contract.get("matched") if target_contract else None
        matched_bid = matched_quote.get("bid") if matched_quote else None
        matched_ask = matched_quote.get("ask") if matched_quote else None
        execution_eligible = bool(
            target_contract
            and target_contract.get("exact_expiry_match")
            and target_contract.get("exact_strike_match")
            and target_contract.get("exact_option_type_match")
            and matched_bid is not None and matched_ask is not None
            and np.isfinite(float(matched_bid)) and np.isfinite(float(matched_ask))
            and float(matched_bid) >= 0.0 and float(matched_ask) > 0.0
            and float(matched_ask) >= float(matched_bid)
        )
        context = build_chain_context(chain, market_state.spot, resolved_expiry, strike)
        use_async = self.async_checkpoints if checkpoint_async is None else bool(checkpoint_async)
        self._checkpoint(symbol, runtime, asynchronous=use_async)
        output = {
            "schema_version": "ocean-wave-snapshot.v2", "provider": "schwab", "data_tier": "realtime",
            "symbol": symbol, "signal_published_at": signal_published_at, "observed_at": observed_at,
            "as_of": observed_at, "captured_at": captured_at,
            "completed_at": datetime.now(timezone.utc).isoformat(), "execution_eligible": execution_eligible,
            "market_state": asdict(market_state), "target_contract": target_contract,
            "contract_assessment": contract_assessment, "events": None, "chain_context": context,
            "chain_quality": quality_diagnostics, "quarantined": False,
            "ocean_wave": {
                "native_core": HAS_CPP_CORE, "trend_score": result.trend_score,
                "direction": result.direction, "confidence": result.confidence,
                "evidence_quality": result.evidence_quality,
                "directional_edge": result.directional_edge,
                "raw_probability": result.raw_probability,
                "calibrated_probability": result.calibrated_probability,
                "actionability": result.actionability,
                "abstain_reason": result.abstain_reason,
                "confidence_semantics": result.confidence_semantics,
                "expectations": {str(key): asdict(value) for key, value in result.expectations.items()},
                "diagnostics": result.diagnostics, "chain_factors": asdict(result.chain_factors),
                "factor_table": result.factor_table.to_dict(orient="records"),
            },
            "runtime": {
                "worker_mode": "persistent" if self.async_checkpoints else "single_shot",
                "fetch_ms": round(fetch_ms, 3), "model_ms": round(model_ms, 3),
                "total_ms": round((perf_counter() - started) * 1000.0, 3),
                "checkpoint": "async" if use_async else "durable_before_return",
                "prediction_ran": True, "state_updated": True,
            },
            "provenance": {
                "source": "Schwab Trader API", "quote_fields": "option chain and included underlying quote",
                "state_schema": "ocean-wave-runtime-state.v1", "orders_enabled": False,
                "intraday_market_state_overrides": sorted(market_state_overrides or {}),
            },
        }
        if option_type in {"call", "put"}:
            probabilities = {}
            for horizon, expectation in result.expectations.items():
                raw_profit = expectation.probability_up if option_type == "call" else 1.0 - expectation.probability_up
                probabilities[str(horizon)] = {
                    "horizon_minutes": float(horizon),
                    **self._calibrator.project(symbol, raw_profit),
                }
            output["ocean_wave"]["challenger"] = {
                "schema_version": "ocean-wave-shadow-challenger.v1",
                "option_type": option_type,
                "probabilities": probabilities,
                "deployment_status": "shadow_only",
            }
        return json_value(output)

    def apply_feedback(self, event: dict[str, Any]) -> dict[str, Any]:
        return self._calibrator.apply_feedback(event)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # Drain queued writes before issuing any final synchronous write;
            # otherwise an older async bundle could win the last rename.
            pending_symbols = set(self._checkpoints) | set(self._checkpoint_failures)
            for symbol in pending_symbols:
                try:
                    self._wait_for_checkpoint(symbol)
                except Exception:
                    pass
            for symbol, runtime in self._symbols.items():
                if runtime.dirty or symbol in self._checkpoint_failures:
                    try:
                        self._checkpoint(symbol, runtime, asynchronous=False)
                    except Exception:
                        pass
            unresolved = dict(self._checkpoint_failures)
        finally:
            self._executor.shutdown(wait=True, cancel_futures=False)
            self._checkpoints.clear()
            self._checkpoint_failures.clear()
            self._symbols.clear()
        if unresolved:
            raise next(iter(unresolved.values()))

    def __enter__(self) -> "RealtimePredictor":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        self.close()


__all__ = [
    "HAS_CPP_CORE", "RealtimePredictor", "assess_gex_history", "assess_oi_history",
    "audit_option_chain", "open_interest_change_gross",
    "build_chain_context", "compact_previous_chain", "json_value", "read_json",
    "validate_horizons", "validate_symbol", "write_json_atomic",
]
