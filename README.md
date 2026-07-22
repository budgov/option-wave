# Ocean Wave

Ocean Wave is a C++-accelerated, multi-factor option-surface forecasting
engine. It keeps the symmetric premium ELO idea—`+d Call` is matched to
`-d Put` at every expiry—but ELO is now only one layer of a broader financial
engineering model.

The executable pipeline is:

```text
HTTPS market APIs
  -> normalized option, trade, short, stock, and inverse-instrument data
  -> symmetric premium ELO + IV/OI/Greeks/liquidity extraction (C++)
  -> verified institutional flow and dealer hedge pressure (C++)
  -> online EWMA covariance + non-negative ridge-GLS weights (C++)
  -> strike x expiry advection-diffusion-reaction PDE (C++)
  -> time integral
  -> expected return, expected price, variance, and P(up)
```

This package is for research and decision support. It does not place orders.

## Evidence layers and prior importance

The priors sum to one, but they are not permanent output weights. Every update
uses factor confidence and an online covariance matrix to reduce redundant or
unstable evidence.

| Rank | Directional factor | Prior |
|---:|---|---:|
| 1 | Symmetric premium ELO | 22% |
| 2 | Verified institutional / large flow | 16% |
| 3 | Dealer hedge pressure | 14% |
| 4 | IV surface: skew, term, curvature | 12% |
| 5 | Short pressure and squeeze interaction | 10% |
| 6 | OI positioning / opening confirmation | 9% |
| 7 | Underlying momentum, VWAP, RVOL | 8% |
| 8 | Explicit inverse-instrument confirmation | 5% |
| 9 | Liquidity-adjusted option energy | 4% |

GEX regime, volatility risk premium, pair variance, quote liquidity, and data
coverage are risk modifiers. They alter PDE diffusion/source strength,
confidence, and forecast variance instead of being forced into directional
votes.

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e .
python -m examples.run_sample
python -m unittest discover -s tests -v
```

`pip install -e .` compiles the C++17 extension with `-O3` (`/O2` on Windows).
On Linux, set `OCEAN_WAVE_NATIVE=1` before installation to add
`-march=native` for machine-specific builds.

## Minimal use

```python
from option_wave import MarketState, OceanWave, ShortData

model = OceanWave()
result = model.predict(
    chain,
    MarketState(
        spot=100.0,
        previous_close=99.5,
        vwap=99.8,
        return_5m=0.001,
        return_15m=0.002,
        rvol=1.20,
        realized_vol=0.24,
    ),
    previous_chain=previous_chain,
    short_data=ShortData(
        short_interest_ratio=0.08,
        short_interest_change=0.01,
        short_volume_ratio=0.47,
        borrow_fee=0.02,
        utilization=0.55,
        days_to_cover=1.8,
    ),
    flow=verified_option_trades,
    inverse_markets=inverse_observations,
)

print(result.trend_score, result.direction, result.confidence)
print(result.expectations[30.0])
print(result.factor_table)
```

`OptionWaveV09` remains an alias of `OceanWave` so existing integrations do
not break.

## Option-chain schema

One row represents one strike and expiry:

```text
strike, expiry_days
call_bid, call_ask, call_last
put_bid, put_ask, put_last
call_volume, put_volume
call_oi, put_oi
call_oi_change, put_oi_change       # optional; previous_chain can derive it
call_iv, put_iv
call_delta, put_delta
call_gamma, put_gamma
call_vega, put_vega
call_variance, put_variance         # optional explicit observation variance
```

Missing factors receive zero confidence and therefore no effective weight.
The model does not invent large-flow direction, dealer inventory, or short
data.

## Large-money flow

Pass trade-level option flow separately. A usable record has an observed
aggressor side, or a trade price that can be classified against bid/ask:

```text
timestamp or age_minutes
right, aggressor, contracts, trade_price
bid, ask, is_opening, oi_change, multiplier
delta, gamma, spot                  # enables dealer-hedge calculation
```

Unknown direction contributes zero directional signal. Notional, confidence,
half-life decay, large-trade selection, flow velocity, delta hedge shares, and
gamma notional are aggregated in C++.

## Short data

`ShortData` accepts decimal ratios and explicitly tracks data confidence:

```text
short_interest_ratio
short_interest_change
short_volume_ratio
borrow_fee
utilization
days_to_cover
```

High short pressure is normally bearish. When the underlying has strong
positive confirmation, the nonlinear squeeze interaction can neutralize or
reverse that signal.

## Inverse instruments

Every inverse product is fetched and analyzed independently, then direction-
mapped and leverage-normalized through its explicit negative beta. The registry includes common
index pairs such as `SPY -> SH/SDS`, `QQQ -> PSQ/QID/SQQQ`, and supported
single-stock products such as `TSLA -> TSLS`. Custom links can be registered:

```python
from option_wave import InverseRegistry, MassiveHTTPClient

registry = InverseRegistry()
registry.register("TSLA", "TSLS", -1.0, source="provider reference API")
bundle = MassiveHTTPClient().fetch_market_bundle("TSLA", registry=registry)
result = model.predict(bundle.chain, bundle.state, inverse_markets=bundle.inverses)
```

Daily leverage reset, fees, tracking error, and compounding mean inverse ETPs
are same-session confirmation—not exact long-horizon inverses.

## API and deployment boundary

Live inputs come only from HTTPS/WebSocket market-data APIs. The repository has
no moomoo/OpenD or desktop-broker dependency. `MassiveHTTPClient` is a reference
REST normalizer; another vendor can implement the same DataFrame contract.

Cloudflare Workers can fetch, authenticate, cache, and normalize the web APIs.
The current high-performance numerical core is a native pybind11 service. A
Cloudflare-only deployment would compile the same C++ kernels to WebAssembly;
it must not attempt to run the Python extension inside a Worker.

## Performance

The hot path is C++: symmetric interpolation, ELO updates, IV-surface weighted
least squares, OI/GEX/energy extraction, institutional-flow risk, covariance
weighting, and PDE time stepping. Python is limited to API adapters,
DataFrame-to-array normalization, online state keys, and result objects.

Run the benchmark locally:

```bash
python -m benchmarks.benchmark_ocean_wave --iterations 100
```

On the development machine, the compiled warm path processed a synthetic
2,020-row chain with a 30-minute PDE horizon in approximately **5.3 ms
median** and **5.6 ms p95** over 100 iterations. Treat this as a reproducible local
measurement, not a universal latency guarantee.

Full equations and assumptions are in [docs/model.md](docs/model.md).
