# Ocean Wave

Ocean Wave is a research-only, C++17-accelerated forecasting library. Version
1.1.0 combines the existing option-surface model with a separate, causal online
challenger for **QQQ, SPY, TSLA, and AAPL**.

This repository contains model code, market-data normalization, synthetic
examples, benchmarks, and tests. It does **not** include messaging listeners,
private records, desktop monitoring, background supervisors, automatic market
session scheduling, or order execution. Installing the package does not start
live collection or trading.

## What changed in 1.1.0

- A stable, implicit C++ solver replaces explicit PDE stepping and numerical
  clipping. It supports nonuniform strike-distance and expiry grids, bounded
  workloads, and a Python reference for cross-checking.
- `OnlineForecastChallenger` compares stock-only, stock-plus-options, trend,
  and mean-reversion experts. Training is isolated by symbol and forecast horizon.
- Predictions are frozen before outcomes arrive. Mature, eligible labels update
  regularized models, Brier losses, Hedge expert weights, and interval diagnostics.
- Options contribute conditional residual features, rather than duplicating
  information already represented in stock features.
- Contract profitability diagnostics account for spreads, fees, Greeks, and IV
  scenarios. A call's probability of profit is not simply the stock's `P(up)`;
  a put's is not simply `1 - P(up)`.

The challenger and contract-value diagnostics are **shadow-only**. They do not
automatically replace the existing model or promote themselves to production.
Numerical stability is not evidence of predictive accuracy or profitability.

## Quick start

Requirements: Python 3.10 or later, a C++17 compiler, and Python development
headers where required by your operating system. On Windows, install the MSVC
C++ build tools and Windows SDK; use a compiler-enabled shell if your build
environment requires it. The Python package build compiles the native extension.

### Linux or macOS

```bash
git clone https://github.com/budgov/option-wave.git
cd option-wave
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
.venv/bin/python -m examples.run_sample
.venv/bin/python -m unittest discover -s tests -v
```

### Windows PowerShell

```powershell
git clone https://github.com/budgov/option-wave.git
Set-Location option-wave
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m examples.run_sample
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

These commands invoke the environment's executable directly; activating a
PowerShell script or changing the execution policy is unnecessary. Ensure the
Python interpreter selected by `py -3` meets the minimum version.

The sample uses synthetic data, requires no API key, and is not a backtest.

## Existing option-surface model

```python
from examples.run_sample import make_sample_chain
from option_wave import MarketState, OceanWave

model = OceanWave()
forecast = model.predict(
    make_sample_chain(),
    MarketState(
        spot=100.0,
        previous_close=99.5,
        vwap=99.8,
        return_5m=0.001,
        return_15m=0.002,
        rvol=1.2,
        realized_vol=0.25,
    ),
)
print(forecast.direction, forecast.confidence)
print(forecast.expectations[30.0])
```

`OptionWaveV09` remains an alias of `OceanWave` for existing integrations.

The baseline pairs `+d Call` with `-d Put` at the same expiry using a shared,
direction-neutral distance cost. Premium ELO is one factor among option-surface,
stock, liquidity, and externally verified flow observations. Default factor
priors are starting assumptions, not established predictive importance.

The PDE evolves a **signed score field**, not a probability density. Its
implicit, direction-split solve uses nonuniform-grid diffusion, upwind drift,
and zero-normal-gradient boundaries. Field integration feeds the model's return
and variance assumptions; it does not turn an unvalidated score into an
empirically calibrated probability. GEX and public OI do not establish actual
dealer inventory or trading intent.

## Causal online challenger

This is a callable API, not an autonomous service. Your application is
responsible for collecting timestamped observations, defining forecast origins,
waiting for maturity, validating sessions, and persisting receipts and outcomes.

The following standalone example uses invented inputs and an invented outcome
solely to demonstrate the API:

```python
from option_wave.online_forecast import OnlineForecastChallenger

challenger = OnlineForecastChallenger()
receipt = challenger.predict(
    symbol="TSLA",  # Also supports QQQ, SPY, and AAPL.
    horizon=30,      # Whole minutes, from 1 through 390.
    stock_features={
        "return_5m": 0.002,
        "return_15m": 0.004,
        "vwap_gap": 0.001,
        "relative_volume": 1.2,
        "market_return_5m": 0.001,
        "sector_return_5m": None,
        "realized_vol": 0.35,
        "day_return": 0.003,
    },
    option_features={
        "iv_skew": 0.02,
        "iv_level": 0.35,
        "gamma_imbalance": None,
        "oi_imbalance": None,
        "delta_flow": None,
    },
    quality=0.5,
    origin_price=200.0,
    forecast_id="synthetic-tsla-30m-001",
    issued_at="2026-01-05T15:00:00Z",
)
print(receipt["probabilities_up"], receipt["readiness"])

outcome = challenger.learn(
    receipt,
    actual_return=0.003,  # Decimal simple return, not a percentage number.
    event_id="synthetic-tsla-outcome-001",
    eligible=True,
    matured_at="2026-01-05T15:30:00Z",
)
print(outcome["updated"], outcome["trained_samples"])

# JSON-compatible state; the caller handles durable storage.
checkpoint = challenger.export_state()
restored = OnlineForecastChallenger.from_state(checkpoint)
```

Returns and price gaps are decimal fractions, volatility is annualized decimal
volatility, and relative volume is a ratio. Gamma/OI imbalance and delta flow
must be normalized features; unverified delta flow must remain `None`. `quality`
describes option evidence quality, not confidence in stock direction.

### Learning and audit rules

- `predict()` does not update the model. It returns a versioned receipt containing
  issue-time features, expert predictions, training watermark, and integrity digest.
- `learn()` requires an eligible outcome observed no earlier than the receipt's
  maturity. The caller must verify actual data timestamps and session validity;
  a supplied timestamp is not independent proof that a price was observed then.
- Non-tied mature direction outcomes contribute `+1` for a correct direction
  and `-1` for an incorrect direction. The challenger's diagnostic accumulator
  does not count a zero return or an exactly 0.5 prediction as a direction win
  or loss. Brier losses still update and drive expert-weight learning separately.
- State is isolated by symbol and horizon. The API caps the number of model keys
  at 64, keeps 512 recent deduplication entries per key, and uses fixed-size native
  learning and interval buffers. Watermarks reject stale or out-of-order labels.
- Cold-start outputs are marked `warmup`. The 32-sample readiness threshold is
  not a validation or production-promotion threshold.
- Use original frozen receipts to score historical predictions. If invalid
  sessions require a checkpoint rebuild, `learn_replay()` retrains from valid
  mature labels while retaining original issue-time predictions for scoring.
  Recomputed historical forecasts are a separate experiment, not forecasts that
  were actually issued at those times.
- Missing prices, ambiguous timestamps, and unavailable inputs stay unknown or
  `None`/JSON `null`. Do not invent a price or a direction score to fill a gap.

The challenger uses a stock-only logistic baseline plus a gated options
increment in log-odds space. Its conditioning regressions, normalizers, and
expert weights learn only from eligible mature feedback. Rolling adaptive
intervals provide diagnostics, not guaranteed coverage in changing markets.

## Market data and option profitability

Normalize an option chain to one row per strike and expiry. Required and
optional field conventions are documented in the
[data integration contract](docs/data_integration.md). `MassiveHTTPClient` is a
reference HTTPS adapter; live and historical availability depend on the
provider and your entitlements. Credentials belong in runtime secrets, never
in code, examples, or committed datasets.

Use observations available at or before a forecast's issue time. A later API
response is not proof of the earlier executable bid or ask. Retain source and
observation timestamps outside the model so missing or delayed data can be
excluded rather than silently substituted.

Contract-value diagnostics use an approximate delta/gamma/theta/vega model with
explicit quote, Greek, IV, fee, and contract-unit assumptions. The C++ probability
calculation estimates profit under those assumptions and the forecast return
distribution; it is not an observed fill probability. Missing unit declarations
or required inputs produce an unavailable diagnostic. Large moves, jumps,
near-expiry nonlinearities, and changing spreads can invalidate the approximation.

## Tests and performance

The Python suite covers the public model, numerical reference parity, PDE
stability, causal online learning, bounded checkpoints, and option-value
semantics. Run it after rebuilding the extension using the quick-start commands.

Standalone C++ tests additionally require CMake 3.20 or later. CTest also runs
the Python suite; explicitly select the environment containing the extension.

Linux or macOS:

```bash
cmake -S . -B build/native-tests -DPython_EXECUTABLE="$PWD/.venv/bin/python"
cmake --build build/native-tests --config Release
ctest --test-dir build/native-tests -C Release --output-on-failure
```

Windows PowerShell:

```powershell
cmake -S . -B build/native-tests -DPython_EXECUTABLE="$PWD/.venv/Scripts/python.exe"
cmake --build build/native-tests --config Release
ctest --test-dir build/native-tests -C Release --output-on-failure
```

Benchmark the installed extension with your own compiler, hardware, and inputs:

```bash
python -m benchmarks.benchmark_ocean_wave --iterations 100
```

Use the virtual environment's Python executable if it is not active. Results
measure a synthetic numerical workload, not network latency, live throughput,
or forecast accuracy. Linux builds may opt into machine-specific compiler
optimization with `OCEAN_WAVE_NATIVE=1`; those binaries are not portable.

Numerical hot paths run in C++. Python provides data normalization, API and
object boundaries, receipt validation, and checkpoint orchestration. The PDE
reuses factorized line solves and does not retain every intermediate score
unless requested. The online core keeps no process-global model state.

## Validation boundary

Evaluate models on the same point-in-time data, against simple baselines, with
time-ordered out-of-sample splits and separation of overlapping forecast
horizons. Report direction accuracy, Brier loss, interval coverage, data coverage,
and transaction-cost-aware option results separately. Do not count recomputed
history as original live predictions or promote a model from warmup performance.

No accuracy, return, or profitability guarantee is made. This is research
software, not investment advice or an execution system.

See [model equations and assumptions](docs/model.md),
[data integration](docs/data_integration.md), and the [changelog](CHANGELOG.md).
