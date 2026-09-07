# Changelog

## 1.2.0 - 2026-09-07

### Added

- C++ bounded correlation-budget optimization with explicit neutral reserves,
  positive-definite redundancy penalties and KKT convergence checks.
- Timestamped inverse and macro context validation, including SQQQ/SH/AAPD/TSLS,
  GLD proxy labeling, the verified Cboe TNX unit contract, dollar index and VIX.
- Online challenger v3 with eleven measured option features, seven context
  inputs, three masked interactions and named feature/logit attributions.
- Explicit observation coverage for IV geometry, quotes, activity and Gamma;
  absent feature values cannot masquerade as measured zeros.
- Regression tests for factor allocation, state migration, context identities,
  weak-prior Hedge updates, malformed broker data and numeric-boundary parity.

### Changed

- Baseline factor budgets preserve missing mass as neutral instead of allocating
  deleted or unavailable evidence to ELO. These remain initial policy ceilings,
  not empirically optimal weights.
- Removed self-correlation shrinkage and repeated evidence-quality/liquidity
  confidence discounts. Liquidity still affects option quality and risk.
- Five shadow experts use frozen Brier-loss Hedge weights with weak prior
  reversion and no previous 10% floor. No automatic production promotion.
- Valid mature direction scoring uses +1/-1 with explicit not-up tie handling.
- Faster numeric-column access avoids repeated conversion of normalized arrays
  without mutating inputs or changing coercion semantics for other dtypes.
- Main model is `ocean-wave.group-budget.v4`, baseline state schema v3 and
  profit calibration v4. Valid old baseline ELO ratings migrate separately from
  reset covariance; online v1/v2 state and receipts are incompatible with v3.

### Fixed

- Negative bids, zero or absent broker quote timestamps and invalid IV/Greek
  placeholders cannot become valid current training evidence. Collection time
  is no longer substituted for a missing observation time.
- Release C++ tests retain assertions without conflicting MSVC definitions.
- Retained the public adapters' HTTPS, same-origin redirect/pagination and
  credential-safe error handling while updating their model interfaces.

### Removed and scope

- Removed `flow.py`, `FlowConfig`, `FlowSummary`, `aggregate_large_flow`,
  `ShortData`, obsolete short-data/trade-flow methods and retired native APIs.
  Calling removed interfaces is an intentional compatibility break.
- No messaging listeners, private trade records, credentials, supervisor,
  desktop integration or automatic collector are included. Host applications
  remain responsible for collection, scheduling and durable event storage.
- No claim of improved live accuracy, an optimal portfolio or guaranteed return.

## 1.1.0 - 2026-09-06

### Added

- A C++ online forecast challenger with a Python API for QQQ, SPY, TSLA, and AAPL.
  Independent symbol/horizon state compares stock-only, conditionally augmented
  options, trend, and mean-reversion experts.
- Frozen, integrity-checked forecast receipts; mature-label eligibility checks;
  duplicate and chronological-order protection; JSON-compatible checkpoints;
  and valid-ledger replay that preserves original issue-time scoring.
- Regularized stock and options updates, Brier-loss Hedge weights, causal state
  diagnostics, and bounded rolling interval calibration. These remain shadow-only
  and do not automatically replace an existing model.
- Native option-profit probability diagnostics under explicit Greek, IV,
  spread, fee, and return-distribution assumptions. Underlying direction and
  contract profitability are treated as separate quantities.
- Standalone C++ regression tests and CMake/CTest support, alongside expanded
  Python tests for numerical stability, causality, state bounds, and contract
  semantics.

### Changed

- Replaced explicit, clipped PDE updates with a stable implicit, direction-split
  solve on nonuniform grids, using upwind drift and explicit boundary assumptions.
  The PDE remains a signed-score model, not a probability-density equation.
- Reused PDE factorization and working buffers, bounded numerical workloads,
  and made intermediate score retention optional.
- Rejected malformed coordinates, nonfinite inputs, impossible timestamps, and
  oversized state instead of silently continuing with invalid calculations.
- Updated English setup and model documentation. Windows examples use Python
  executables directly and require no PowerShell execution-policy change.
- Raised the supported Python floor to 3.10 and removed the unused plotting
  dependency. C++17 remains the native implementation baseline.

### Fixed

- Source archives include the native headers and test inputs needed to rebuild
  the extension. The installed wheel contains only the library package.
- HTTPS and same-origin checks protect credentials during market-data requests,
  pagination, and redirects; network errors do not expose credential-bearing URLs.
- Automated Linux and Windows checks build the extension, run native/Python
  parity tests, and verify source-archive-to-wheel packaging.

### Compatibility and scope

- `OceanWave` and the `OptionWaveV09` compatibility alias remain available.
- The public package includes model APIs, adapters, synthetic examples, and
  tests, not private collection infrastructure or records. There is no messaging
  listener, supervisor, automatic session scheduler, or order execution.
- Missing evidence remains unknown or null. Retrospective recomputation must be
  labeled separately from original forecasts; missing outcomes are not fabricated
  to create scores.
- New numerical and learning implementations require rebuilding the native
  extension. New checkpoint schemas are validated; do not silently reinterpret
  incompatible or invalid model state.
- No claim of improved live accuracy or profitability is made without subsequent
  out-of-sample evidence.
