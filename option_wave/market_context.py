"""Strict point-in-time cross-asset boundary, independent of broker I/O.

Missing evidence reserves neutral budget. Macro direction is not guessed from
asset names; raw observations train the separate mature-label native challenger.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
import math
import re
from zoneinfo import ZoneInfo

SCHEMA = "ocean-wave-market-context.v1"
INVERSES = {"QQQ": ("SQQQ", -3.0), "SPY": ("SH", -1.0),
            "AAPL": ("AAPD", -1.0), "TSLA": ("TSLS", -1.0)}
MACROS = ("gold", "treasury_10y", "dollar_index", "vix")
FEATURES = ("inverse_return_5m", "inverse_return_15m", "gold_return_5m",
            "treasury_10y_change_bps", "dollar_return_5m", "vix_change", "vix_level")
EXCHANGE = ZoneInfo("America/New_York")
TNX_UNIT_CONTRACT = "cboe_tnx_yield_x10.v1"
TNX_UNIT_SOURCE = "https://cdn.cboe.com/resources/regulation/rule_book/C1_Exchange_Rule_Book.pdf#page=213"


def _index_identity(record, *, treasury=False):
    if record.get("identity_verified") is not True or record.get("asset_main_type") != "INDEX":
        return False
    description = str(record.get("provider_description", "")).strip()
    if not treasury:
        return re.fullmatch(r"ICE U\.?S\.? Dollar Index", description, re.I) is not None
    return (re.match(r"CBOE\b", description, re.I) is not None
            and re.search(r"10\s*(?:YR|YEAR)|TEN.?YEAR", description, re.I) is not None
            and re.search(r"T[\s-]*NOTE|TREASURY", description, re.I) is not None
            and re.search(r"INT(?:EREST)?\s+RATE|YIELD", description, re.I) is not None)


def _finite(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _time(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo is not None and parsed.utcoffset() is not None else None
    except ValueError:
        return None


def prepare_market_context(payload, *, symbol: str, issued_at: str,
                           realized_vol: float | None = None) -> dict:
    """Recompute features from prices/timestamps; ignore supplied feature scores."""
    model = {"inverse_signal": None, "inverse_confidence": 0.0,
             "inverse_symbol": None,
             "macro_signals": {key: None for key in MACROS},
             "macro_confidences": {key: 0.0 for key in MACROS}, "risk_multiplier": 1.0}
    result = {"model": model, "context_features": {key: None for key in FEATURES},
              "audit": {"schema_version": SCHEMA, "accepted": {}, "rejected": {},
                        "macro_direction_policy": "mature_label_learning_only",
                        "status": "unavailable"}}
    if payload is None:
        return result
    cutoff = _time(issued_at)
    if (not isinstance(payload, Mapping) or payload.get("schema_version") != SCHEMA
            or cutoff is None or _time(payload.get("as_of")) != cutoff
            or not isinstance(payload.get("instruments"), Mapping)
            or len(payload["instruments"]) > 16):
        result["audit"]["rejected"]["context"] = "invalid_schema_or_forecast_cutoff"
        return result
    date = cutoff.astimezone(EXCHANGE).date()
    features = result["context_features"]
    for key, record in payload["instruments"].items():
        if not isinstance(key, str) or len(key) > 24 or not isinstance(record, Mapping):
            continue
        observed = _time(record.get("observed_at"))
        price = _finite(record.get("price"))
        age = (cutoff - observed).total_seconds() if observed is not None else math.inf
        if (record.get("symbol") != key or record.get("provider") != "schwab"
                or record.get("data_tier") != "realtime" or record.get("delayed") is True
                or record.get("isDelayed") is True or record.get("realtime") is False
                or record.get("realTime") is False
                or price is None or price <= 0 or not 0 <= age <= 15
                or observed.astimezone(EXCHANGE).date() != date):
            result["audit"]["rejected"][key] = "unavailable_stale_future_or_untrusted_quote"
            continue
        windows = {}
        for minutes in (5, 15):
            reference = _time(record.get(f"reference_at_{minutes}m"))
            previous = _finite(record.get(f"reference_price_{minutes}m"))
            elapsed = (observed - reference).total_seconds() if reference else math.inf
            if (reference is None or previous is None or previous <= 0
                    or reference.astimezone(EXCHANGE).date() != date
                    or not minutes * 60 <= elapsed <= minutes * 60 + 60):
                continue
            windows[minutes] = (math.log(price / previous), price - previous)
        accepted = False
        link = INVERSES.get(symbol.upper())
        if (link and key == link[0] and record.get("role") == "inverse"
                and record.get("underlying") == symbol.upper()
                and _finite(record.get("daily_leverage")) == link[1]
                and record.get("is_proxy") is False and record.get("quote_unit") == "usd"):
            for minutes, (change, _) in windows.items():
                features[f"inverse_return_{minutes}m"] = change / link[1]
                accepted = True
            if 5 in windows:
                volatility = _finite(realized_vol)
                scale = max(0.05, volatility if volatility is not None and volatility > 0 else 0.25)
                scale *= math.sqrt(5.0 / (252.0 * 390.0))
                model["inverse_signal"] = math.tanh(features["inverse_return_5m"] / scale)
                model["inverse_symbol"] = key
                # Daily leverage is an approximation intraday, not independent flow.
                model["inverse_confidence"] = 0.75 * max(0.0, 1.0 - age / 30.0)
        if record.get("role") == "macro":
            factor = record.get("factor")
            if factor == "gold" and key == "GLD" and record.get("is_proxy") is True:
                if (record.get("represents") == "gold_etf_proxy" and record.get("quote_unit") == "usd"
                        and 5 in windows):
                    features["gold_return_5m"] = windows[5][0]
                    accepted = True
            elif factor == "dollar_index" and key == "$NYICDX" and record.get("is_proxy") is False:
                if (record.get("quote_unit") == "index_points" and _index_identity(record)
                        and record.get("represents") == "ice_us_dollar_index" and 5 in windows):
                    features["dollar_return_5m"] = windows[5][0]
                    accepted = True
            elif factor == "treasury_10y" and key == "$TNX" and record.get("is_proxy") is False:
                if (record.get("quote_unit") == "index_points" and record.get("units_verified") is True
                        and record.get("reference_units_verified_5m") is True and _index_identity(record, treasury=True)
                        and record.get("unit_contract") == TNX_UNIT_CONTRACT and record.get("unit_source") == TNX_UNIT_SOURCE
                        and _finite(record.get("multiplier_to_percent")) == 0.1 and 5 in windows
                        and _finite(record.get("change_bps_5m")) is not None):
                    computed = windows[5][1] * 10.0
                    if math.isclose(computed, float(record["change_bps_5m"]), abs_tol=1e-8):
                        features["treasury_10y_change_bps"] = computed
                        accepted = True
            elif factor == "vix" and key == "$VIX" and record.get("is_proxy") is False:
                if record.get("quote_unit") == "index_points" and 0 < price <= 200:
                    features["vix_level"] = price
                    if 5 in windows:
                        features["vix_change"] = windows[5][1]
                    accepted = True
        if accepted:
            result["audit"]["accepted"][key] = {
                "observed_at": record["observed_at"], "is_proxy": record.get("is_proxy"),
                "represents": record.get("represents"), "reference_windows": sorted(windows),
                "unit_contract": record.get("unit_contract"), "unit_source": record.get("unit_source")}
        else:
            result["audit"]["rejected"][key] = "wrong_identity_units_or_missing_causal_reference"
    # Bounded stress indicator affects dispersion, not directional drift.
    # Scales are ex-ante safety parameters, not fitted or optimal coefficients.
    stress = 0.0
    for name, scale in (("gold_return_5m", 0.005), ("treasury_10y_change_bps", 5.0),
                        ("dollar_return_5m", 0.002), ("vix_change", 2.0)):
        value = features[name]
        if value is not None:
            stress += min(abs(value) / scale, 2.0) / 8.0
    vix = features["vix_level"]
    if vix is not None:
        stress += min(max(vix - 20.0, 0.0) / 40.0, 1.0)
    model["risk_multiplier"] = 1.0 + min(stress, 2.0)
    result["audit"]["status"] = "partial" if result["audit"]["accepted"] else "unavailable"
    result["audit"]["risk_multiplier"] = model["risk_multiplier"]
    return result
