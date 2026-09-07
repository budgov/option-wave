# Ocean Wave data integration contract

The model boundary is broker-neutral and web-only. Use HTTPS/WebSocket market
data APIs. This package validates supplied observations; automatic collection,
session scheduling and desktop integrations are outside the public package.

## Data-quality rule

Every source provides a value and a confidence. Missing or unverifiable data
gets confidence zero. In particular:

- option volume alone does not prove buy/sell direction;
- public OI does not prove dealer inventory sign;
- a ticker name does not prove an inverse relationship;
- delayed or post-cutoff quotes cannot validate a live signal-time price;
- a proxy ETF must not be mislabeled as its reference asset or index.

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
change for diagnostics; an OI change is not a directional trade label. Bid/ask is preferred to last price because spread becomes the local
observation variance.

## Native v3 option-feature contract

The candidate learner accepts the following eleven option fields, in this
fixed order. Values must be causal at the forecast cutoff and accompanied by
the relevant source coverage. Pass unavailable measurements as `None`/`null`,
not a numeric zero that falsely claims an observation.

| Field | Meaning and availability |
|---|---|
| `premium_elo_signal` | Signed premium-ELO signal in [-1, 1], with measured `premium_elo_confidence` |
| `premium_elo_confidence` | ELO observation reliability in [0, 1]; missing or zero disables the ELO signal |
| `iv_skew` | Annualized IV difference in decimal units; requires measured two-sided OTM skew coverage |
| `iv_level` | Annualized IV in decimal units; requires valid IV coverage |
| `iv_term_slope` | Near IV minus far IV in decimal units; requires observed near (at most 7 days) and far (over 7 days) expiries |
| `iv_curvature` | Fitted coefficient of squared log-moneyness; requires identifiable strike geometry and IV-fit coverage |
| `volatility_risk_premium` | Annualized IV minus annualized realized volatility, both in decimal units and both observed |
| `gamma_imbalance` | Call-minus-put unsigned chain gamma statistic in [-1, 1]; not dealer inventory direction |
| `gamma_concentration` | Largest strike's gross unsigned gamma exposure divided by total gross exposure, in [0, 1]; requires observed positive gross exposure |
| `liquidity_quality` | Quote-based quality in [0, 1]; requires valid measured bid/ask coverage |
| `option_activity` | `log1p(sum(volume * abs(delta)))` over jointly measured call/put sides; requires activity coverage |

The native chain summary reports `iv_coverage`, `iv_skew_coverage`,
`iv_term_coverage`, `iv_fit_coverage`, `quote_coverage` and
`option_activity_coverage` separately. A diagnostic placeholder of zero with
zero coverage means missing: for example, a chain with only near expiries
does not establish a flat IV term structure. Conversely, measured zero volume
with a measured delta is valid zero activity and must not be dropped. Activity
does not impute an absent delta as 0.5. Valid quote pairs are finite and obey
`bid >= 0`, `ask >= bid` and `ask > 0`; negative bids are not usable liquidity.
Gamma concentration aggregates the same strike across expiries before taking
the maximum. Neither gamma statistic establishes signed dealer positioning.

The learner reports effective observed option count divided by eleven as
`option_feature_coverage`. This is separate from supplied evidence quality:
missing fields already mask their own values, so the option quality gate is
not multiplied by this count fraction again. If no effective option fields
exist, the option gate is zero. ELO confidence gates that specific observation;
its directional coefficient is learned in the option residual, not fixed to
the main-model ELO budget.

Three internal interactions require all parents to be measured: ELO with IV
skew, ELO with gamma concentration, and stock 5-minute return with IV term.
Frozen receipts retain raw fields, observed masks, normalized inputs,
conditional designs and gated logit contributions. These contributions are
not percentage weights. Version `online_forecast.v3` explicitly rejects old
v1/v2 checkpoints and receipts; retain historical observations and outcomes
for audit rather than relabeling an older feature vector as v3. This learner
remains a shadow candidate and cannot promote itself into production.

## Underlying state

Populate as many `MarketState` fields as the API provides:

```text
spot, previous_close, high, low, vwap
return_5m, return_15m, rvol, realized_vol
stock_volume, stock_dollar_volume, data_confidence
```

## Retired inputs

The current model does not accept institutional-flow or short-pressure tables
as directional evidence. Chain activity, OI and unsigned Greeks are diagnostic
inputs, not substitutes for observed institutional positions or signed opening
flow. Do not route retired input schemas into a new factor with the same name.

## Causal inverse and macro observations

The live inverse observations are SQQQ for QQQ (-3x daily), SH for SPY (-1x),
TSLS for TSLA (-1x) and AAPD for AAPL (-1x). Fetch them independently and retain
their stated daily leverage. The target-aligned return over a matching window is
`log(inverse_now / inverse_then) / daily_leverage`. Daily objectives do not
guarantee exact intraday tracking.

Context observations must carry instrument identity, provider timestamps,
freshness/delay status, units and proxy flags. Current context features are:

| Field | Meaning |
|---|---|
| `inverse_return_5m` | Target-aligned inverse 5-minute log return |
| `inverse_return_15m` | Target-aligned inverse 15-minute log return |
| `gold_return_5m` | GLD gold-ETF proxy 5-minute return; not spot gold |
| `treasury_10y_change_bps` | Verified 10-year yield change in basis points |
| `dollar_return_5m` | Dollar-index 5-minute return |
| `vix_change` | Change in VIX index points |
| `vix_level` | Observed VIX index level |

The batch context adapter uses $VIX, $TNX, $NYICDX, GLD and UUP alongside the
inverse quotes. Schwab identifies $NYICDX as the ICE U.S. Dollar Index; $DXY
is not the supported symbol. UUP is diagnostic only, never a silent substitute.
$TNX uses the fixed `cboe_tnx_yield_x10.v1` unit contract: index points divided
by ten give yield percent, so one index point of change is ten basis points.
The adapter verifies the actual provider's index identity and retains the
[Cboe unit-contract source](https://cdn.cboe.com/resources/regulation/rule_book/C1_Exchange_Rule_Book.pdf#page=213).
It does not require a fictional API `quoteUnit` field or infer scale by magnitude.
Historical references must match the verified symbol and completed OHLC data
before inheriting that contract; a price-history close alone is insufficient.

Quotes must be no later than the forecast cutoff and within the configured
freshness limit (15 seconds for this context path). Explicitly delayed values
are rejected. Five/fifteen-minute reference points use the same session and a
bounded reference-time mismatch; incomplete windows stay null. Only same-day
completed candles may warm the bounded cache; subsequent samples use batch
quotes. This must not relabel historical signals or alter old outcomes. The
application must implement these collection rules; no batch collector ships here.

Do not assign permanent directional signs to gold, rates, the dollar or VIX.
Raw context can affect risk diagnostics and mature supervised challengers.
Main-model macro directional allocations remain neutral until a validated
direction mapping is explicitly supplied. Proxy labels and missing masks must
survive serialization into the frozen forecast receipt.

## Optional model-only inverse adapters

The model-only `InverseRegistry` and `InverseMarketData` boundary supports
explicitly declared additional products. Fetch each independently; do not merge
its chain with the target chain. Registry inclusion is not proof of a product's
current availability, quote freshness or tracking quality. Confirm relationships
with issuer/reference data and align observations before using them.
