# Option Wave Forecast Model v0.9

This repository contains a compact research implementation of the Option Wave
model. v0.9 replaces the old fixed-weight factor scorer with one continuous
pipeline:

```text
wide option chain
  -> +d Call / -d Put symmetric pairs
  -> variance-aware ELO surface
  -> expiry x distance PDE field
  -> time integral
  -> expected return, price, variance, and P(up)
```

For example, with spot `100`, `105 Call` is paired with `95 Put`, not with a
`95 Call` or with the put at the same strike. The same mapping is repeated
for every expiry, including same-day and future expiries.

The package is for research and decision support only. It does not place
orders or connect to brokerage accounts.

## Quick start

```bash
cd option-wave
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .
python -m examples.run_sample
python -m unittest discover -s tests -v
```

## Input schema

The core accepts a pandas DataFrame with one row per strike and expiry:

```text
strike, expiry_days
call_bid, call_ask, call_last
put_bid, put_ask, put_last
call_volume, put_volume, call_oi, put_oi
```

Optional uncertainty and volatility fields are `call_variance`,
`put_variance`, `call_iv`, `put_iv`, `call_delta`, and `put_delta`.
Bid/ask spread is used as the default observation variance when explicit
variance is not supplied.

## Minimal usage

```python
from option_wave import MarketState, OptionWaveV09

model = OptionWaveV09()
result = model.predict(chain, MarketState(spot=100.0, realized_vol=0.25))

print(result.trend_score, result.direction)
print(result.expectations[30.0].expected_price)
print(result.expectations[30.0].probability_up)
```

The result also exposes `elo_surface`, `field_grid`, `distance_grid`, and
`expiry_grid` for plotting a 3D surface. Reusing the same model instance
keeps the online ELO state; call `reset()` to start a fresh session.

## Data integration

Recommended sources are moomoo OpenD/OpenAPI and the Schwab Developer API.
They should feed the normalized schema above. Live whale-flow data is not a
required input in v0.9: when supplied, it must be trade-level data with an
observable aggressor side or bid/ask placement. Unknown direction is ignored,
not guessed from the underlying price.

### Large-money flow

The optional flow table accepts `timestamp` (or `age_minutes`), `right`,
`aggressor`, `contracts`, and `trade_price`. Optional fields include
`bid`, `ask`, `is_opening`, `oi_change`, and `multiplier`. The C++ backend
applies notional sizing, confidence, half-life decay, large-trade threshold,
and recent-versus-prior velocity. Example:

```python
result = model.predict(
    chain,
    MarketState(spot=100.0, symbol="QQQ"),
    flow=flow_trades,
    flow_asof="2026-07-18T15:00:00Z",
)
print(result.diagnostics["large_flow_notional"])
print(result.diagnostics["flow_velocity"])
```

### Inverse index confirmation

Pass a corresponding inverse option chain and state when available. For QQQ,
SQQQ is a daily approximately `-3x` exposure, so set `inverse_beta=-3.0`;
the inverse signal is mapped back to QQQ direction before entering the
confidence-weighted composite source field:

```python
result = model.predict(
    qqq_chain,
    MarketState(spot=720.0, symbol="QQQ"),
    inverse_chain=sqqq_chain,
    inverse_state=MarketState(spot=sqqq_spot, symbol="SQQQ"),
    inverse_beta=-3.0,
)
```

The composite signal uses confidence—not fixed hand-tuned factor weights—to
combine the ELO field, premium/energy confirmation, verified large flow, and
the inverse instrument. The diagnostics expose each component for audit.

## Performance design

`pip install -e .` builds the C++17 extension in `cpp/option_wave_core.cpp`.
It owns pair construction/interpolation, variance-aware ELO updates, and PDE
time stepping, plus time-decayed large-flow aggregation. Python remains at the
boundary for DataFrame normalization, online rating-key management, charting,
and result objects. A small Python
reference path remains only as a portability/debug fallback when the extension
has not been built.

On the reference machine, a 2,010-row chain completed in about 2.8 ms through
the compiled path versus about 21.0 ms through the reference path.
