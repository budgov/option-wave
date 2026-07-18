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
