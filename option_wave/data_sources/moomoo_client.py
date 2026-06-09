from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from typing import Any

import pandas as pd

from option_wave.factors import MarketState

from .normalize import normalize_option_chain


@dataclass
class MoomooConfig:
    host: str = "127.0.0.1"
    port: int = 11111
    max_expiries: int = 3
    code: str = "US.AAPL"


class MoomooClient:
    def __init__(self, config: MoomooConfig) -> None:
        self.config = config

    def fetch(self) -> tuple[pd.DataFrame, MarketState, dict[str, Any]]:
        try:
            from moomoo import OpenQuoteContext, RET_OK  # type: ignore
        except Exception as exc:  # pragma: no cover - environment dependent
            raise RuntimeError(
                "moomoo Python SDK is not available. Install `moomoo-api` and make sure OpenD is running."
            ) from exc

        quote_ctx = OpenQuoteContext(host=self.config.host, port=self.config.port)
        try:
            underlying = self._get_underlying_snapshot(quote_ctx, RET_OK)
            expiries = self._get_expiries(quote_ctx, RET_OK)
            static_chain = self._get_static_chain(quote_ctx, RET_OK, expiries)
            option_codes = static_chain["code"].dropna().astype(str).unique().tolist()
            snapshots = self._get_option_snapshots(quote_ctx, RET_OK, option_codes)
            merged = static_chain.merge(snapshots, how="left", on="code", suffixes=("", "_snap"))
            normalized = normalize_option_chain(merged)
            state = self._build_market_state(underlying)
            meta = {
                "underlying": self.config.code,
                "expiries": expiries,
                "row_count": len(normalized),
                "updated_at": underlying.get("update_time"),
            }
            return normalized, state, meta
        finally:
            quote_ctx.close()

    def _get_underlying_snapshot(self, quote_ctx: Any, ret_ok: int) -> dict[str, Any]:
        ret, data = quote_ctx.get_market_snapshot([self.config.code])
        if ret != ret_ok or data is None or data.empty:
            raise RuntimeError(f"Unable to load underlying snapshot for {self.config.code}: {data}")
        row = data.iloc[0].to_dict()

        ret_quote, quote = quote_ctx.get_stock_quote([self.config.code])
        if ret_quote == ret_ok and quote is not None and not quote.empty:
            for key, value in quote.iloc[0].to_dict().items():
                row[key] = value
        return row

    def _get_expiries(self, quote_ctx: Any, ret_ok: int) -> list[str]:
        ret, data = quote_ctx.get_option_expiration_date(code=self.config.code)
        if ret != ret_ok or data is None or data.empty:
            raise RuntimeError(f"Unable to load option expiries for {self.config.code}: {data}")
        column = "strike_time" if "strike_time" in data.columns else data.columns[0]
        expiries = data[column].astype(str).tolist()
        return expiries[: self.config.max_expiries]

    def _get_static_chain(self, quote_ctx: Any, ret_ok: int, expiries: list[str]) -> pd.DataFrame:
        rows: list[pd.DataFrame] = []
        for expiry in expiries:
            ret, data = quote_ctx.get_option_chain(code=self.config.code, start=expiry, end=expiry)
            if ret != ret_ok:
                raise RuntimeError(f"Unable to load option chain for {self.config.code} {expiry}: {data}")
            frame = data.copy()
            if "strike_time" not in frame.columns:
                frame["strike_time"] = expiry
            rows.append(frame)
        if not rows:
            raise RuntimeError(f"No option chain data returned for {self.config.code}")
        return pd.concat(rows, ignore_index=True)

    def _get_option_snapshots(self, quote_ctx: Any, ret_ok: int, codes: list[str]) -> pd.DataFrame:
        if not codes:
            raise RuntimeError("No option contracts returned from moomoo option chain.")

        chunks = [codes[i : i + 400] for i in range(0, len(codes), 400)]
        snapshots: list[pd.DataFrame] = []
        for chunk in chunks:
            ret, data = quote_ctx.get_market_snapshot(chunk)
            if ret != ret_ok:
                raise RuntimeError(f"Unable to load option snapshots: {data}")
            snapshots.append(data)
        snapshot_df = pd.concat(snapshots, ignore_index=True)
        return snapshot_df.rename(
            columns={
                "bid_price": "bid",
                "ask_price": "ask",
                "last_price": "last",
                "option_open_interest": "oi",
                "option_implied_volatility": "iv",
                "option_delta": "delta",
                "option_gamma": "gamma",
                "option_vega": "vega",
                "option_theta": "theta",
                "option_strike_price": "strike",
                "strike_time": "expiry_date",
            }
        )

    def _build_market_state(self, row: dict[str, Any]) -> MarketState:
        spot = float(row.get("last_price") or row.get("cur_price") or 0.0)
        high = float(row.get("high_price") or spot)
        low = float(row.get("low_price") or spot)
        vwap = row.get("avg_price")
        volume = float(row.get("volume") or 0.0)
        turnover = float(row.get("turnover") or 0.0)
        dollar_volume = turnover if turnover > 0 else spot * volume
        return MarketState(
            spot=spot,
            high=high,
            low=low,
            vwap=float(vwap) if vwap not in (None, "") else None,
            rvol=None,
            stock_dollar_volume=dollar_volume if dollar_volume > 0 else None,
            minutes_from_open=float(self._minutes_from_open(row.get("update_time"))),
        )

    @staticmethod
    def _minutes_from_open(update_time: Any) -> int:
        if not update_time:
            return 0
        try:
            ts = pd.to_datetime(update_time)
        except Exception:
            return 0
        naive = ts.to_pydatetime().replace(tzinfo=None)
        market_open = datetime.combine(naive.date(), time(9, 30))
        delta = naive - market_open
        return max(0, int(delta.total_seconds() // 60))
