"""Provider-neutral HTTPS market-data boundary.

The numerical engine is local and fast; this module is the I/O edge.  It uses
only the Python standard library for HTTP so there is no broker SDK, desktop
daemon, or moomoo/OpenD dependency.  The default adapter targets the Massive
(formerly Polygon) REST shape, while ``normalize_option_snapshots`` can also
be used with a different vendor's JSON response.

API credentials must be supplied at runtime.  They are never read from a
checked-in file and should be exposed to a Cloudflare Worker as a secret.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import json
import os
import re
from typing import Any, Callable, Iterable, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

import numpy as np
import pandas as pd

from .inverse import InverseMarketData, InverseRegistry
from .factors import ShortData
from .model import MarketState


class HTTPAPIError(RuntimeError):
    """An HTTP market-data request failed or returned an invalid payload."""


@dataclass(frozen=True)
class HTTPAPIConfig:
    """Runtime configuration for a REST provider."""

    base_url: str = "https://api.massive.com"
    api_key: str | None = None
    api_key_parameter: str = "apiKey"
    timeout_seconds: float = 10.0
    max_pages: int = 8
    page_limit: int = 250

    @classmethod
    def from_env(cls, prefix: str = "MASSIVE") -> "HTTPAPIConfig":
        """Create runtime configuration without placing secrets in source."""

        return cls(
            base_url=os.getenv(f"{prefix}_BASE_URL", cls.base_url),
            api_key=os.getenv(f"{prefix}_API_KEY"),
            api_key_parameter=os.getenv(f"{prefix}_API_KEY_PARAMETER", cls.api_key_parameter),
            timeout_seconds=float(os.getenv(f"{prefix}_TIMEOUT_SECONDS", cls.timeout_seconds)),
            max_pages=int(os.getenv(f"{prefix}_MAX_PAGES", cls.max_pages)),
            page_limit=int(os.getenv(f"{prefix}_PAGE_LIMIT", cls.page_limit)),
        )


@dataclass(frozen=True)
class MarketBundle:
    """A target chain/state plus every inverse product fetched successfully."""

    symbol: str
    chain: pd.DataFrame
    state: MarketState
    inverses: tuple[InverseMarketData, ...]
    missing_inverse_symbols: tuple[str, ...] = ()


def _first(mapping: Mapping[str, Any], *names: str, default: Any = None) -> Any:
    for name in names:
        value = mapping.get(name)
        if value is not None:
            return value
    return default


def _float(value: Any, default: float = np.nan) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if np.isfinite(result) else default


def _timestamp(value: Any) -> pd.Timestamp | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 1e18:
            unit = "ns"
        elif number > 1e15:
            unit = "us"
        elif number > 1e12:
            unit = "ms"
        else:
            unit = "s"
        return pd.to_datetime(number, unit=unit, utc=True, errors="coerce")
    parsed = pd.to_datetime(value, utc=True, errors="coerce")
    return parsed if not pd.isna(parsed) else None


def _append_query(url: str, params: Mapping[str, Any]) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.update({key: value for key, value in params.items() if value is not None})
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


class MassiveHTTPClient:
    """Small REST client for option snapshots, quotes, and trades.

    The class deliberately returns the project's normalized wide chain and
    long-form flow tables.  The same interface can be implemented for another
    HTTP provider without changing the C++ numerical core.
    """

    def __init__(
        self,
        config: HTTPAPIConfig | None = None,
        *,
        transport: Callable[[str], Mapping[str, Any]] | None = None,
    ) -> None:
        self.config = config or HTTPAPIConfig()
        self._transport = transport

    def _url(self, path: str, params: Mapping[str, Any] | None = None) -> str:
        url = path if path.startswith("http://") or path.startswith("https://") else self.config.base_url.rstrip("/") + "/" + path.lstrip("/")
        query = dict(params or {})
        if self.config.api_key:
            query.setdefault(self.config.api_key_parameter, self.config.api_key)
        return _append_query(url, query)

    def _get_json(self, path: str, params: Mapping[str, Any] | None = None) -> Mapping[str, Any]:
        url = self._url(path, params)
        if self._transport is not None:
            payload = self._transport(url)
            if not isinstance(payload, Mapping):
                raise HTTPAPIError("transport returned a non-object JSON payload")
            return payload
        request = Request(url, headers={"Accept": "application/json", "User-Agent": "ocean-wave/1.0"})
        try:
            with urlopen(request, timeout=max(float(self.config.timeout_seconds), 0.1)) as response:
                status = getattr(response, "status", 200)
                raw = response.read()
        except Exception as exc:  # pragma: no cover - depends on network/provider
            raise HTTPAPIError(f"market-data request failed: {exc}") from exc
        if status >= 400:
            raise HTTPAPIError(f"market-data request returned HTTP {status}")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:  # pragma: no cover
            raise HTTPAPIError("market-data response was not valid JSON") from exc
        if not isinstance(payload, Mapping):
            raise HTTPAPIError("market-data response was not a JSON object")
        return payload

    def _paged_results(self, path: str, params: Mapping[str, Any]) -> list[Mapping[str, Any]]:
        next_url: str | None = self._url(path, params)
        results: list[Mapping[str, Any]] = []
        for _ in range(max(int(self.config.max_pages), 1)):
            if next_url is None:
                break
            payload = self._get_json(next_url)
            page = payload.get("results", [])
            if isinstance(page, list):
                results.extend(item for item in page if isinstance(item, Mapping))
            raw_next = payload.get("next_url")
            next_url = str(raw_next) if raw_next else None
            if next_url and self.config.api_key and self.config.api_key_parameter not in dict(parse_qsl(urlsplit(next_url).query)):
                next_url = _append_query(next_url, {self.config.api_key_parameter: self.config.api_key})
        return results

    @staticmethod
    def normalize_option_snapshots(
        payload: Mapping[str, Any] | Iterable[Mapping[str, Any]],
        *,
        as_of: date | pd.Timestamp | str | None = None,
    ) -> pd.DataFrame:
        """Normalize contract snapshot JSON into the model's wide chain.

        Each contract becomes a call or put side of a ``strike x expiry`` row.
        Missing quote fields remain NaN and are handled by the ELO layer.
        """

        records = payload.get("results", []) if isinstance(payload, Mapping) else payload
        if not isinstance(records, Iterable):
            return pd.DataFrame()
        if as_of is None:
            asof_date = pd.Timestamp.now(tz="UTC").date()
        else:
            parsed = pd.Timestamp(as_of)
            asof_date = parsed.date()
        rows: list[dict[str, Any]] = []
        for item in records:
            if not isinstance(item, Mapping):
                continue
            details = item.get("details") if isinstance(item.get("details"), Mapping) else item
            contract_type = str(_first(details, "contract_type", "option_type", default="")).lower()
            side = "call" if contract_type in {"call", "c"} else "put" if contract_type in {"put", "p"} else ""
            if not side:
                continue
            strike = _float(_first(details, "strike_price", "strike"))
            expiration = _first(details, "expiration_date", "expiration", "expiry")
            if not np.isfinite(strike) or expiration is None:
                continue
            expiry_date = pd.Timestamp(expiration).date()
            expiry_days = max((expiry_date - asof_date).days, 0)
            quote = item.get("last_quote") if isinstance(item.get("last_quote"), Mapping) else {}
            trade = item.get("last_trade") if isinstance(item.get("last_trade"), Mapping) else {}
            day = item.get("day") if isinstance(item.get("day"), Mapping) else {}
            greeks = item.get("greeks") if isinstance(item.get("greeks"), Mapping) else {}
            prefix = side
            rows.append({
                "strike": strike,
                "expiry_days": float(expiry_days),
                f"{prefix}_bid": _float(_first(quote, "bid", "bid_price")),
                f"{prefix}_ask": _float(_first(quote, "ask", "ask_price")),
                f"{prefix}_last": _float(_first(trade, "price", "last", "close"), _first(day, "close")),
                f"{prefix}_volume": _float(_first(day, "volume", "vol"), 0.0),
                f"{prefix}_oi": _float(_first(item, "open_interest", "oi"), 0.0),
                f"{prefix}_iv": _float(_first(item, "implied_volatility", "iv")),
                f"{prefix}_delta": _float(_first(greeks, "delta")),
                f"{prefix}_gamma": _float(_first(greeks, "gamma")),
                f"{prefix}_vega": _float(_first(greeks, "vega")),
                f"{prefix}_theta": _float(_first(greeks, "theta")),
                f"{prefix}_vanna": _float(_first(greeks, "vanna")),
                f"{prefix}_charm": _float(_first(greeks, "charm")),
                f"{prefix}_timestamp": _timestamp(_first(trade, "sip_timestamp", "timestamp")),
            })
        if not rows:
            return pd.DataFrame(columns=["strike", "expiry_days"])
        frame = pd.DataFrame(rows)
        value_columns = [column for column in frame.columns if column not in {"strike", "expiry_days"}]

        def first_valid(series: pd.Series) -> Any:
            valid = series.dropna()
            return valid.iloc[0] if len(valid) else np.nan

        normalized = frame.groupby(["strike", "expiry_days"], as_index=False, sort=True)[value_columns].agg(first_valid)
        return normalized

    @staticmethod
    def normalize_short_data(payload: Mapping[str, Any], *, confidence: float = 1.0) -> ShortData:
        """Normalize a provider's short-interest/borrow JSON object.

        This is intentionally endpoint-neutral because short interest, daily
        short volume, and securities-lending data often come from different
        HTTPS vendors. Percent-like values above one are converted to decimal
        units when they are at most 100.
        """

        result = payload.get("results") if isinstance(payload.get("results"), Mapping) else payload

        def decimal(*names: str) -> float | None:
            value = _float(_first(result, *names))
            if not np.isfinite(value):
                return None
            return value / 100.0 if 1.0 < abs(value) <= 100.0 else value

        days = _float(_first(result, "days_to_cover", "short_ratio"))
        return ShortData(
            short_interest_ratio=decimal("short_interest_ratio", "short_percent_float", "short_float"),
            short_interest_change=decimal("short_interest_change", "short_change", "short_interest_delta"),
            short_volume_ratio=decimal("short_volume_ratio", "short_volume_percent", "short_volume_pct"),
            borrow_fee=decimal("borrow_fee", "cost_to_borrow", "borrow_rate"),
            utilization=decimal("utilization", "borrow_utilization"),
            days_to_cover=days if np.isfinite(days) else None,
            confidence=float(np.clip(confidence, 0.0, 1.0)),
            as_of=_first(result, "as_of", "date", "timestamp"),
        )

    def fetch_option_chain(
        self,
        symbol: str,
        *,
        as_of: date | pd.Timestamp | str | None = None,
        active: bool = True,
    ) -> pd.DataFrame:
        """Fetch the option-contract snapshot chain for one underlying."""

        records = self._paged_results(
            f"/v3/snapshot/options/{symbol.upper()}",
            {"limit": self.config.page_limit, "active": str(active).lower()},
        )
        return self.normalize_option_snapshots(records, as_of=as_of)

    def fetch_underlying_state(self, symbol: str) -> MarketState:
        """Fetch a last-trade snapshot and convert it to ``MarketState``."""

        payload = self._get_json(f"/v2/last/trade/{symbol.upper()}")
        result = payload.get("results") if isinstance(payload.get("results"), Mapping) else payload
        price = _float(_first(result, "price", "p", "last"))
        if not np.isfinite(price) or price <= 0:
            raise HTTPAPIError(f"no positive last price returned for {symbol}")
        previous_close = _float(_first(result, "previous_close", "prev_close", "prevDayClose"))
        return MarketState(
            spot=price,
            high=_float(_first(result, "high", "h")),
            low=_float(_first(result, "low", "l")),
            vwap=_float(_first(result, "vwap", "vw")),
            symbol=symbol.upper(),
            previous_close=previous_close if np.isfinite(previous_close) else None,
        )

    @staticmethod
    def normalize_option_quotes(
        payload: Mapping[str, Any] | Iterable[Mapping[str, Any]],
    ) -> pd.DataFrame:
        """Normalize historical OPRA bid/ask events for executable backtests.

        Invalid or crossed markets stay in the audit trail but are marked
        non-executable; they are never replaced with a trade or theoretical price.
        """

        records = payload.get("results", []) if isinstance(payload, Mapping) else payload
        rows: list[dict[str, Any]] = []
        for item in records if isinstance(records, Iterable) else ():
            if not isinstance(item, Mapping):
                continue
            bid = _float(_first(item, "bid_price", "bid", "bp"))
            ask = _float(_first(item, "ask_price", "ask", "ap"))
            timestamp = _timestamp(_first(item, "sip_timestamp", "participant_timestamp", "timestamp"))
            executable = bool(
                timestamp is not None
                and np.isfinite(bid)
                and np.isfinite(ask)
                and bid >= 0.0
                and ask >= bid
            )
            rows.append({
                "timestamp": timestamp,
                "bid": bid,
                "ask": ask,
                "bid_size": _float(_first(item, "bid_size", "bs"), 0.0),
                "ask_size": _float(_first(item, "ask_size", "as"), 0.0),
                "bid_exchange": _first(item, "bid_exchange", "bx"),
                "ask_exchange": _first(item, "ask_exchange", "ax"),
                "sequence_number": _first(item, "sequence_number", "q"),
                "mid": 0.5 * (bid + ask) if executable else np.nan,
                "spread": ask - bid if executable else np.nan,
                "executable": executable,
            })
        return pd.DataFrame(rows, columns=[
            "timestamp", "bid", "ask", "bid_size", "ask_size",
            "bid_exchange", "ask_exchange", "sequence_number", "mid", "spread", "executable",
        ]).sort_values("timestamp", kind="stable", na_position="last").reset_index(drop=True)

    def fetch_option_quotes(
        self,
        options_ticker: str,
        *,
        start: date | pd.Timestamp | str | None = None,
        end: date | pd.Timestamp | str | None = None,
        limit: int | None = None,
    ) -> pd.DataFrame:
        """Fetch historical OPRA quotes for one exact option contract."""

        def stamp(value: date | pd.Timestamp | str | None) -> str | None:
            return pd.Timestamp(value).isoformat() if value is not None else None

        records = self._paged_results(
            f"/v3/quotes/{options_ticker}",
            {
                "limit": limit or self.config.page_limit,
                "sort": "timestamp",
                "order": "asc",
                "timestamp.gte": stamp(start),
                "timestamp.lte": stamp(end),
            },
        )
        return self.normalize_option_quotes(records)

    def fetch_stock_quotes(
        self,
        symbol: str,
        *,
        start: date | pd.Timestamp | str | None = None,
        end: date | pd.Timestamp | str | None = None,
        limit: int | None = None,
    ) -> pd.DataFrame:
        """Fetch historical NBBO quotes for an underlying symbol."""

        records = self._paged_results(
            f"/v3/quotes/{symbol.upper()}",
            {
                "limit": limit or self.config.page_limit,
                "sort": "timestamp",
                "order": "asc",
                "timestamp.gte": pd.Timestamp(start).isoformat() if start is not None else None,
                "timestamp.lte": pd.Timestamp(end).isoformat() if end is not None else None,
            },
        )
        return self.normalize_option_quotes(records)

    def fetch_news(
        self,
        symbol: str,
        *,
        start: date | pd.Timestamp | str | None = None,
        end: date | pd.Timestamp | str | None = None,
        limit: int | None = None,
    ) -> pd.DataFrame:
        """Fetch timestamped news available inside a bounded as-of window."""

        records = self._paged_results(
            "/v2/reference/news",
            {
                "ticker": symbol.upper(),
                "limit": limit or self.config.page_limit,
                "sort": "published_utc",
                "order": "asc",
                "published_utc.gte": pd.Timestamp(start).isoformat() if start is not None else None,
                "published_utc.lte": pd.Timestamp(end).isoformat() if end is not None else None,
            },
        )
        rows: list[dict[str, Any]] = []
        for item in records:
            publisher = item.get("publisher") if isinstance(item.get("publisher"), Mapping) else {}
            insights = item.get("insights") if isinstance(item.get("insights"), list) else []
            rows.append({
                "id": _first(item, "id"),
                "published_at": _timestamp(_first(item, "published_utc", "published_at")),
                "title": _first(item, "title"),
                "description": _first(item, "description"),
                "publisher": _first(publisher, "name"),
                "article_url": _first(item, "article_url"),
                "tickers": tuple(item.get("tickers", ())) if isinstance(item.get("tickers"), list) else (),
                "insights": tuple(
                    {
                        "ticker": _first(insight, "ticker"),
                        "sentiment": _first(insight, "sentiment"),
                        "reasoning": _first(insight, "sentiment_reasoning"),
                    }
                    for insight in insights if isinstance(insight, Mapping)
                ),
            })
        return pd.DataFrame(rows, columns=[
            "id", "published_at", "title", "description", "publisher", "article_url", "tickers", "insights",
        ]).sort_values("published_at", kind="stable", na_position="last").reset_index(drop=True)

    def fetch_option_trades(
        self,
        options_ticker: str,
        *,
        start: date | pd.Timestamp | str | None = None,
        end: date | pd.Timestamp | str | None = None,
        limit: int | None = None,
    ) -> pd.DataFrame:
        """Fetch raw contract trades for flow classification.

        The trades endpoint does not establish aggressor direction by itself.
        Join these rows with quotes (or use a provider that supplies an
        observed side) before passing them to ``aggregate_large_flow``.
        """

        records = self._paged_results(
            f"/v3/trades/{options_ticker}",
            {
                "limit": limit or self.config.page_limit,
                "sort": "timestamp",
                "order": "asc",
                "timestamp.gte": pd.Timestamp(start).isoformat() if start is not None else None,
                "timestamp.lte": pd.Timestamp(end).isoformat() if end is not None else None,
            },
        )
        right_match = re.search(r"([CP])\d{8}\d{8}$", options_ticker.upper())
        right = right_match.group(1) if right_match else None
        rows = []
        for item in records:
            timestamp = _timestamp(_first(item, "sip_timestamp", "participant_timestamp", "timestamp"))
            rows.append({
                "timestamp": timestamp,
                "right": right,
                "contracts": _float(_first(item, "size", "contracts", "quantity"), 0.0),
                "trade_price": _float(_first(item, "price", "p"), 0.0),
                "options_ticker": options_ticker,
            })
        return pd.DataFrame(rows, columns=["timestamp", "right", "contracts", "trade_price", "options_ticker"])

    def fetch_market_bundle(
        self,
        symbol: str,
        *,
        registry: InverseRegistry | None = None,
        available_inverse_symbols: Iterable[str] | None = None,
        as_of: date | pd.Timestamp | str | None = None,
        strict: bool = False,
    ) -> MarketBundle:
        """Fetch a target plus all registered, available inverse products."""

        target = symbol.upper()
        target_chain = self.fetch_option_chain(target, as_of=as_of)
        target_state = self.fetch_underlying_state(target)
        inverse_registry = registry or InverseRegistry()
        links = inverse_registry.resolve(target, available_symbols=available_inverse_symbols)
        inverses: list[InverseMarketData] = []
        missing: list[str] = []
        for link in links:
            try:
                inverse_chain = self.fetch_option_chain(link.inverse_symbol, as_of=as_of)
                inverse_state = self.fetch_underlying_state(link.inverse_symbol)
            except (HTTPAPIError, ValueError):
                if strict:
                    raise
                missing.append(link.inverse_symbol)
                continue
            inverses.append(InverseMarketData(
                symbol=link.inverse_symbol,
                chain=inverse_chain,
                state=inverse_state,
                beta=link.beta,
                confidence=link.confidence,
                source=link.source,
            ))
        return MarketBundle(target, target_chain, target_state, tuple(inverses), tuple(missing))
