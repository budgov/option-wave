# Data integration contract

The model is broker-neutral. A moomoo OpenD/OpenAPI adapter or Schwab
Developer API adapter should normalize one observation into this wide schema:

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
moomoo OpenD / Schwab API
        -> normalized DataFrame
        -> OptionWaveV09.predict(...)
        -> ModelResult + ELO/PDE surfaces
```

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

## Inverse feed

For QQQ, provide a separately normalized SQQQ chain and state:

```python
result = model.predict(
    qqq_chain,
    qqq_state,
    inverse_chain=sqqq_chain,
    inverse_state=sqqq_state,
    inverse_beta=-3.0,
)
```

The inverse chain is analyzed in its own ELO surface, then mapped to QQQ by
the sign of its exposure. Do not merge QQQ and SQQQ strikes into one chain.
The adapter should preserve source timestamps and symbol identifiers for audit.
