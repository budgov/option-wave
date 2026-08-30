# Ocean Wave data integration contract

The live boundary is broker-neutral and web-only. Use HTTPS/WebSocket market
data APIs; do not add moomoo/OpenD or a desktop application dependency.

## Historical point-in-time option backtests

`MassiveHTTPClient.fetch_option_quotes()` and `fetch_option_trades()` accept a
bounded start/end window for one exact OCC option ticker. Historical quote rows
preserve OPRA timestamps, sizes, exchanges, sequence numbers, bid/ask, mid,
spread, and an `executable` quality flag. Crossed or incomplete markets stay in
the audit trail but are never substituted with last trades or theoretical values.

For a long option, enter at the first reliable ask at/after the signal timestamp
and exit at a reliable bid. Short-option tests reverse those sides. Apply an
explicit latency policy, fees, slippage stress, stale-quote limit, and trading
calendar before creating outcome labels. Current snapshot endpoints are not
historical reconstruction and must not be used for old Telegram signals.

`fetch_news()` applies the same bounded-window rule to timestamped ticker news.
For a signal explanation, the news window must end at the signal's publication
time. Post-signal articles may be used only for outcome attribution, never as
input features for that signal.

For Schwab retail accounts, `SchwabHTTPClient` normalizes the Trader API option
chain and quote responses. Supply `SCHWAB_ACCESS_TOKEN` at runtime or pass a
secret-managed `token_provider`; never commit OAuth tokens. The adapter is
read-only and does not expose order endpoints.

## Data-quality rule

Every source provides a value and a confidence. Missing or unverifiable data
gets confidence zero. In particular:

- option volume alone does not prove buy/sell direction;
- public OI does not prove dealer inventory sign;
- a ticker name does not prove an inverse relationship;
- stale short interest must not be presented as intraday flow.

## Option snapshot

Normalize the option chain to one row per `strike x expiry`:

```text
strike, expiry_days
call_bid, call_ask, call_last
put_bid, put_ask, put_last
call_volume, put_volume
call_oi, put_oi
call_oi_change, put_oi_change       # optional
call_iv, put_iv
call_delta, put_delta
call_gamma, put_gamma
call_vega, put_vega
call_variance, put_variance         # optional
```

If OI changes are absent, pass the preceding snapshot through
`previous_chain=`. Ocean Wave matches by strike and expiry and derives the
change. Bid/ask is preferred to last price because spread becomes the local
observation variance.

## Underlying state

Populate as many `MarketState` fields as the API provides:

```text
spot, previous_close, high, low, vwap
return_5m, return_15m, rvol, realized_vol
stock_volume, stock_dollar_volume, data_confidence
```

## Institutional option flow

Pass raw trades in a separate long-form table:

```text
timestamp or age_minutes
right, aggressor, contracts, trade_price
bid, ask, is_opening, oi_change, multiplier
delta, gamma, spot
```

An observed aggressor is best. Bid/ask classification receives lower
confidence. Midpoint/unknown trades contribute no direction. Delta and gamma
enable the C++ hedge-pressure calculation.

## Short and securities-lending data

Short inputs commonly require more than one API. Normalize them into
`ShortData` with decimal units:

```text
short_interest_ratio
short_interest_change
short_volume_ratio
borrow_fee
utilization
days_to_cover
confidence, as_of
```

`MassiveHTTPClient.normalize_short_data(...)` can normalize a provider object,
but it does not assume a vendor-specific endpoint. Preserve each source's
timestamp: exchange short volume can be daily while consolidated short
interest may update only twice monthly.

## Inverse products

Resolve an explicit relationship, fetch each product independently, and pass
`InverseMarketData` objects through `inverse_markets=`. Do not merge inverse
and target chains.

```python
from option_wave import InverseRegistry, MassiveHTTPClient, OceanWave

registry = InverseRegistry()
bundle = MassiveHTTPClient().fetch_market_bundle("SPY", registry=registry)
result = OceanWave().predict(
    bundle.chain,
    bundle.state,
    inverse_markets=bundle.inverses,
)
```

The built-in registry covers common broad-index and selected single-stock
inverse products. Add new relationships only after confirming them through a
reference API or issuer data.

## Cloudflare boundary

A Cloudflare Worker is suitable for API authentication, fan-out, caching,
normalization, and scheduling. Store provider credentials in Worker secrets.
The current numerical package is a native C++/Python service; use a separate
native runtime or compile the kernels to WebAssembly for a Worker-only design.
