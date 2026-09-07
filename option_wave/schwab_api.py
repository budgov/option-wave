"""Charles Schwab Trader API market-data adapter for Ocean Wave.

The adapter is intentionally read-only. It accepts a short-lived OAuth access
token at runtime and never stores Schwab usernames, passwords, refresh tokens,
orders, or account identifiers. Authentication/refresh belongs in a separate
secret-managed process; callers can provide a ``token_provider`` callback.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
import json
import os
from typing import Any, Callable, Mapping
from urllib.parse import urlencode
from urllib.request import Request

import numpy as np
import pandas as pd

from .http_api import HTTPAPIError
from .model import MarketState
from .http_security import HTTPURLPolicyError, build_https_opener, resolve_https_url


def _first(mapping: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        value = mapping.get(name)
        if value is not None:
            return value
    return default


def _float(value: Any, default: float = np.nan) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if np.isfinite(parsed) else default


def _iv_decimal(value: Any) -> float:
    """Normalize Schwab percentage-point volatility to Ocean Wave decimals."""

    parsed = _float(value)
    return parsed / 100.0 if np.isfinite(parsed) and abs(parsed) > 3.0 else parsed


def _timestamp(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        if isinstance(value, bool) or not np.isfinite(float(value)) or float(value) <= 0.0:
            return None
        seconds = float(value) / 1000.0 if float(value) > 1e11 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    parsed = pd.to_datetime(value, utc=True, errors="coerce")
    return parsed.isoformat() if not pd.isna(parsed) else None


def latest_quote_timestamp(chain: pd.DataFrame) -> str | None:
    """Return the newest source quote timestamp in a normalized Schwab chain."""

    timestamps: list[pd.Timestamp] = []
    for column in ("call_quote_timestamp", "put_quote_timestamp"):
        if column not in chain:
            continue
        for value in chain[column].dropna():
            parsed = pd.Timestamp(value)
            parsed = parsed.tz_localize("UTC") if parsed.tzinfo is None else parsed.tz_convert("UTC")
            timestamps.append(parsed)
    return max(timestamps).isoformat() if timestamps else None


@dataclass(frozen=True)
class SchwabHTTPConfig:
    base_url: str = "https://api.schwabapi.com"
    access_token: str | None = None
    timeout_seconds: float = 10.0

    @classmethod
    def from_env(cls, prefix: str = "SCHWAB") -> "SchwabHTTPConfig":
        return cls(
            base_url=os.getenv(f"{prefix}_BASE_URL", cls.base_url),
            access_token=os.getenv(f"{prefix}_ACCESS_TOKEN"),
            timeout_seconds=float(os.getenv(f"{prefix}_TIMEOUT_SECONDS", cls.timeout_seconds)),
        )


class SchwabHTTPClient:
    """Read-only normalizer for Schwab option chains and underlying quotes."""

    def __init__(
        self,
        config: SchwabHTTPConfig | None = None,
        *,
        token_provider: Callable[[], str] | None = None,
        transport: Callable[[str, Mapping[str, str]], Mapping[str, Any]] | None = None,
    ) -> None:
        self.config = config or SchwabHTTPConfig.from_env()
        self._token_provider = token_provider
        self._transport = transport
        try:
            self._opener = build_https_opener(self.config.base_url)
        except HTTPURLPolicyError as exc:
            raise HTTPAPIError(str(exc)) from None

    def _token(self) -> str:
        token = self._token_provider() if self._token_provider is not None else self.config.access_token
        if not token:
            raise HTTPAPIError("Schwab access token is missing")
        return token

    def _get_json(self, path: str, params: Mapping[str, Any]) -> Mapping[str, Any]:
        query = urlencode({key: value for key, value in params.items() if value is not None})
        try:
            url = resolve_https_url(self.config.base_url, path)
        except HTTPURLPolicyError as exc:
            raise HTTPAPIError(str(exc)) from None
        if query:
            url = f"{url}?{query}"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self._token()}"}
        if self._transport is not None:
            payload = self._transport(url, headers)
            if not isinstance(payload, Mapping):
                raise HTTPAPIError("Schwab transport returned a non-object JSON payload")
            return payload
        request = Request(url, headers=headers)
        try:
            with self._opener.open(request, timeout=max(float(self.config.timeout_seconds), 0.1)) as response:
                raw = response.read()
                status = getattr(response, "status", 200)
        except Exception:  # Never expose provider errors containing request credentials.
            raise HTTPAPIError("Schwab market-data request failed") from None
        if status >= 400:
            raise HTTPAPIError(f"Schwab market-data request returned HTTP {status}")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:  # pragma: no cover
            raise HTTPAPIError("Schwab market-data response was not valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise HTTPAPIError("Schwab market-data response was not a JSON object")
        return payload

    @staticmethod
    def normalize_option_chain(
        payload: Mapping[str, Any],
        *,
        as_of: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        """Convert Schwab ``callExpDateMap``/``putExpDateMap`` to wide rows."""

        asof_date = pd.Timestamp.now(tz="UTC").date() if as_of is None else pd.Timestamp(as_of).date()
        # Schwab emits calls and puts as separate nested records.  Building the
        # wide rows directly avoids a Python callback for every group/column in
        # ``DataFrame.groupby().agg()``, which dominated live capture latency on
        # large index chains.
        rows_by_key: dict[tuple[float, float, str], dict[str, Any]] = {}
        for side, map_name in (("call", "callExpDateMap"), ("put", "putExpDateMap")):
            expiry_map = payload.get(map_name, {})
            if not isinstance(expiry_map, Mapping):
                continue
            for expiry_key, strike_map in expiry_map.items():
                if not isinstance(strike_map, Mapping):
                    continue
                try:
                    expiry_date = pd.Timestamp(str(expiry_key).split(":", 1)[0]).date()
                except (TypeError, ValueError):
                    continue
                expiry_days = max((expiry_date - asof_date).days, 0)
                for strike_key, contracts in strike_map.items():
                    items = contracts if isinstance(contracts, list) else [contracts]
                    for contract in items:
                        if not isinstance(contract, Mapping):
                            continue
                        strike = _float(_first(contract, "strikePrice", "strike", default=strike_key))
                        if not np.isfinite(strike):
                            continue
                        key = (strike, float(expiry_days), expiry_date.isoformat())
                        row = rows_by_key.setdefault(key, {
                            "strike": strike,
                            "expiry_days": float(expiry_days),
                            "expiry_date": expiry_date.isoformat(),
                        })
                        prefix = side
                        fields = {
                            f"{prefix}_symbol": _first(contract, "symbol", "optionSymbol"),
                            f"{prefix}_bid": _float(_first(contract, "bid", "bidPrice")),
                            f"{prefix}_ask": _float(_first(contract, "ask", "askPrice")),
                            f"{prefix}_last": _float(_first(contract, "last", "lastPrice", "mark")),
                            f"{prefix}_volume": _float(_first(contract, "totalVolume", "volume"), 0.0),
                            f"{prefix}_oi": _float(_first(contract, "openInterest", "oi"), 0.0),
                            f"{prefix}_iv": _iv_decimal(_first(contract, "volatility", "impliedVolatility", "iv")),
                            f"{prefix}_delta": _float(_first(contract, "delta")),
                            f"{prefix}_gamma": _float(_first(contract, "gamma")),
                            f"{prefix}_theta": _float(_first(contract, "theta")),
                            f"{prefix}_vega": _float(_first(contract, "vega")),
                            f"{prefix}_rho": _float(_first(contract, "rho")),
                            f"{prefix}_quote_timestamp": _timestamp(_first(contract, "quoteTimeInLong", "quoteTime")),
                            f"{prefix}_trade_timestamp": _timestamp(_first(contract, "tradeTimeInLong", "tradeTime")),
                        }
                        for name, value in fields.items():
                            existing = row.get(name)
                            if existing is None or (isinstance(existing, float) and not np.isfinite(existing)):
                                row[name] = value
        if not rows_by_key:
            return pd.DataFrame(columns=["strike", "expiry_days", "expiry_date"])
        return pd.DataFrame(rows_by_key.values()).sort_values(
            ["strike", "expiry_days", "expiry_date"], ignore_index=True
        )

    @staticmethod
    def normalize_underlying_quote(symbol: str, payload: Mapping[str, Any]) -> MarketState:
        record = payload.get(symbol.upper(), payload)
        if not isinstance(record, Mapping):
            raise HTTPAPIError(f"Schwab returned no quote object for {symbol}")
        quote = record.get("quote", record)
        if not isinstance(quote, Mapping):
            raise HTTPAPIError(f"Schwab returned no quote fields for {symbol}")
        spot = _float(_first(quote, "mark", "lastPrice", "last", "closePrice", "close"))
        if not np.isfinite(spot) or spot <= 0:
            raise HTTPAPIError(f"Schwab returned no positive quote for {symbol}")
        previous_close = _float(_first(quote, "closePrice", "previousClose", "close"))
        high = _float(_first(quote, "highPrice", "high"))
        low = _float(_first(quote, "lowPrice", "low"))
        volume = _float(_first(quote, "totalVolume", "volume"))
        return MarketState(
            spot=spot,
            symbol=symbol.upper(),
            previous_close=previous_close if np.isfinite(previous_close) else None,
            high=high if np.isfinite(high) else None,
            low=low if np.isfinite(low) else None,
            stock_volume=volume if np.isfinite(volume) else None,
            stock_dollar_volume=volume * spot if np.isfinite(volume) else None,
            data_confidence=0.90,
        )

    def fetch_option_chain(
        self,
        symbol: str,
        *,
        as_of: date | pd.Timestamp | str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        strike_count: int | None = None,
    ) -> pd.DataFrame:
        payload = self._get_json("/marketdata/v1/chains", {
            "symbol": symbol.upper(),
            "contractType": "ALL",
            "strategy": "SINGLE",
            "includeUnderlyingQuote": "true",
            "fromDate": from_date,
            "toDate": to_date,
            "strikeCount": strike_count,
        })
        return self.normalize_option_chain(payload, as_of=as_of)

    def fetch_market_snapshot(
        self,
        symbol: str,
        *,
        as_of: date | pd.Timestamp | str | None = None,
        from_date: str | None = None,
        to_date: str | None = None,
        strike_count: int | None = None,
    ) -> tuple[pd.DataFrame, MarketState]:
        """Fetch a chain and its included underlying quote in one request.

        Schwab's chain endpoint includes the current underlying quote when
        ``includeUnderlyingQuote`` is true.  A second quote request is used only
        as a compatibility fallback when that object is missing or incomplete.
        """

        payload = self._get_json("/marketdata/v1/chains", {
            "symbol": symbol.upper(),
            "contractType": "ALL",
            "strategy": "SINGLE",
            "includeUnderlyingQuote": "true",
            "fromDate": from_date,
            "toDate": to_date,
            "strikeCount": strike_count,
        })
        chain = self.normalize_option_chain(payload, as_of=as_of)
        underlying = payload.get("underlying")
        if isinstance(underlying, Mapping):
            try:
                return chain, self.normalize_underlying_quote(symbol, underlying)
            except HTTPAPIError:
                pass
        return chain, self.fetch_underlying_state(symbol)

    def fetch_underlying_state(self, symbol: str) -> MarketState:
        payload = self._get_json("/marketdata/v1/quotes", {
            "symbols": symbol.upper(),
            "fields": "quote,reference",
        })
        return self.normalize_underlying_quote(symbol, payload)
