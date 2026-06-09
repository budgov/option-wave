# Data Integration Plan

## moomoo OpenD / OpenAPI

Target fields:

- underlying symbol
- underlying spot price
- option chain by expiry
- strike
- call/put bid, ask, last
- call/put volume
- call/put open interest
- IV
- delta, gamma, vega, theta
- quote timestamp

Implementation target:

```text
data_sources/moomoo_client.py
```

## thinkorswim / Schwab

Recommended routes:

1. Schwab Developer API if API credentials are available.
2. thinkorswim CSV export if API is not ready.
3. Manual paste/screenshot only for quick research.

Implementation target:

```text
data_sources/schwab_client.py
```

## Normalized option chain schema

Required columns:

```text
strike
expiry_days
call_bid
call_ask
call_last
put_bid
put_ask
put_last
call_volume
put_volume
call_oi
put_oi
call_iv
put_iv
call_delta
put_delta
call_gamma
put_gamma
call_vega
put_vega
```

Optional columns:

```text
call_trade_aggressor
put_trade_aggressor
call_oi_change
put_oi_change
call_sweep_flag
put_sweep_flag
```
