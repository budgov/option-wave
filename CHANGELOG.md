# Changelog

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
