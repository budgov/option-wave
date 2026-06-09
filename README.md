# Option Wave Forecast Model v0.8 (ELO First)

This package contains the v0.8 design and starter implementation for the Option Wave Forecast Model.

Core idea:

- Step 1: Build an **Option ELO Rating Surface** from call/put premiums by strike and expiry.
- Step 2: Convert option flow into continuous bullish/bearish energy fields.
- Step 3: Aggregate premium, energy, GEX, hedge pressure, stock confirmation, and penalty/boost terms.
- Step 4: Output a bounded `TrendScore` in `[-1, 1]`.

This repo is intended for local Codex / Codex app work. It does **not** place trades. Use it for research, charting, and decision support only.

## Quick start

```bash
cd option-wave
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python examples/run_sample.py
```

## Dashboard app

The repo now includes a research dashboard at `app.py`.

```bash
streamlit run app.py
```

The dashboard supports:

1. `moomoo live`: live option chain and Greeks through moomoo OpenD / OpenAPI
2. `CSV upload`: normalized or long-form option chain CSV
3. `sample`: built-in synthetic data

## moomoo live setup

The app is wired to **moomoo OpenD** as the primary live data source.

1. Install and log in to OpenD locally.
2. Install the Python SDK:

```bash
pip install moomoo-api
```

3. Start the app and point it at your OpenD host and port. The common local default is `127.0.0.1:11111`.

The dashboard fetches:

- underlying snapshot
- option expiration dates
- option chain contracts
- option snapshots including bid/ask/last, volume, open interest, IV, delta, gamma, vega, and theta

## Codex prompt

Open this folder in Codex and use `CODEX_PROMPT.md` as the first task prompt.

## Data integration plan

Recommended sources:

1. moomoo OpenD / OpenAPI for option chain, quote, IV, Greeks, volume, OI.
2. Schwab Developer API for thinkorswim/Schwab market data.
3. Manual CSV export from thinkorswim or moomoo when APIs are not ready.

## Model output

The model returns:

- `trend_score`
- `direction`
- `confidence`
- factor contributions
- key trigger levels
- optional chart-ready surfaces

## Important limitation

Live whale flow requires real option tape or a specialized flow provider. If verified whale data is unavailable, `WhaleImpact` is confidence-adjusted or set to zero.
