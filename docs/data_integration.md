# Data integration contract

The model is broker-neutral and the live-data boundary is HTTPS-only. A REST
or WebSocket vendor adapter should normalize one observation into this wide
schema. The repository does not depend on moomoo/OpenD or a desktop trading
application:

```text
strike, expiry_days
call_bid, call_ask, call_last
put_bid, put_ask, put_last
call_volume, put_volume
call_oi, put_oi
call_variance, put_variance   # optional
call_iv, put_iv               # optional
call_delta, put_delta         # optional
```

The required fields are strike, expiry, and at least a usable last or bid/ask
price for each side. The core does not require an unusual-flow vendor and does
not infer whale direction from volume alone.

## Recommended feed boundary

```text
HTTPS market-data API
        -> normalized DataFrame
        -> OptionWaveV09.predict(...)
        -> ModelResult + ELO/PDE surfaces
```

`option_wave.http_api.MassiveHTTPClient` is the reference REST adapter. It
uses contract snapshots for the option chain, the underlying last-trade API
for `MarketState`, and the option-trades endpoint for raw flow. A Cloudflare
Worker can perform the same HTTPS fetch with its native `fetch` API; store the
provider key as a Worker secret and pass only normalized JSON into the model.

Keep timestamps and source identifiers in the adapter layer. They are useful
for audit logs, but should not be silently mixed into the numerical pair key.
The model's online state is keyed by expiry and relative distance, so call the
same model instance for sequential snapshots and call `reset()` between
independent sessions.

## Large-money flow feed

Keep trade-level flow in a separate long-form DataFrame and pass it through the
`flow=` argument:

```text
timestamp or age_minutes
right, aggressor, contracts, trade_price
bid, ask, is_opening, oi_change, multiplier   # optional
```

`aggressor` should be an observed buy/sell side. If it is absent, the adapter
may classify trades at bid/ask with reduced confidence; midpoint or unknown
trades contribute zero direction. The model computes contract notional,
time-decay, large-trade threshold, net direction, and recent/prior velocity in
the compiled backend.

## Universal inverse feed

Inverse products are independent instruments. Resolve all registered links for
the target, fetch each chain/state separately, and pass the resulting list:

```python
from option_wave import InverseRegistry, MassiveHTTPClient

registry = InverseRegistry()
registry.register("TSLA", "TSLS", -1.0, source="Direxion")
bundle = MassiveHTTPClient().fetch_market_bundle("TSLA", registry=registry)
result = model.predict(
    bundle.chain,
    bundle.state,
    inverse_markets=bundle.inverses,
)
```

The default registry covers common broad products (`SPY -> SH/SDS`,
`QQQ -> PSQ/QID/SQQQ`, `DIA -> DOG`, `IWM -> RWM`) and several currently listed
single-stock inverse ETPs. Add provider-confirmed relationships for any other
stock. The inverse chain is analyzed in its own ELO surface, then mapped back
to the target by the sign of its explicit daily beta. Do not merge inverse and
target strikes into one chain. Preserve source timestamps and symbol
identifiers for audit.
