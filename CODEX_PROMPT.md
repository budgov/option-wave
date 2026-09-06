# Ocean Wave development guide

You are working on the public Ocean Wave research library. Keep changes within
the model, data-adapter, example, benchmark, and test boundaries. Do not add
private records, credentials, messaging listeners, desktop monitoring,
background supervisors, account actions, or order execution.

## Model invariants

1. Pair `+d Call` with `-d Put` at the same expiry. Do not silently substitute
   same-strike call/put comparisons. Use one direction-neutral distance cost for
   both sides of each symmetric pair.
2. Premium ELO is a contemporaneous factor, not a supervised forecast-accuracy
   rating. Default factor priors are hypotheses, not empirical importance claims.
   Preserve compatibility when changing factor schemas; justify additions or
   removals using point-in-time out-of-sample evaluation and ablations.
3. Do not infer actual dealer inventory, aggressor direction, short positioning,
   institutional intent, or inverse relationships from unavailable evidence.
   Missing inputs remain unknown with appropriately reduced confidence.
4. Treat GEX, IV, liquidity, and public OI primarily as state or risk information
   unless verified evidence supports a directional interpretation. Do not count
   the same underlying information repeatedly through correlated features.
5. The strike-expiry PDE evolves a signed score field, not a probability density.
   Keep explicit coordinate units, nonuniform-grid discretization, boundary
   conditions, and stable implicit stepping. Do not conceal instability through
   output clipping or arbitrary timestep floors.
6. Underlying direction probability is not option-profit probability. Contract
   diagnostics require explicit quote/Greek units, spread and fee assumptions,
   and a declared return-distribution approximation. Return unavailable/null when
   inputs are insufficient; never substitute direction probability.

## Causal learning and evaluation

- Keep `OnlineForecastChallenger` shadow-only. Do not auto-promote it, overwrite
  the existing model, or treat warmup readiness as evidence of production quality.
- Isolate training by symbol and horizon. Keep model counts, calibration buffers,
  duplicate windows, serialized state, and numerical work bounded.
- Freeze predictions, features, model version, and training watermark at issue
  time. `predict()` must not train or advance normalizers.
- Learn only from eligible mature labels. Preserve duplicate protection and
  chronological watermarks across checkpoint round trips. A caller-supplied
  timestamp does not itself establish point-in-time data integrity.
- Score the original frozen prediction. Keep `+1/-1` direction outcomes separate
  from Brier loss, interval coverage, actionability, and net option profitability.
  Missing outcome data must not become invented prices or forced scores.
- Rebuild invalidated training state from an authoritative valid-label ledger.
  Replay may re-encode features for training, but must retain the original frozen
  predictions for historical scoring. Label recomputed history separately.
- Compare candidates against simple baselines on time-ordered holdouts; account
  for overlapping horizons, transaction costs, and data coverage. Do not promise
  accuracy or profitability from code changes alone.

## Implementation and verification

Use C++17 for numerical hot paths: pairing/interpolation, ELO, surface factors,
flow aggregation, covariance weighting, stable PDE solves, horizon integration,
online learning, and contract-profit integration. Prefer bounded buffers, RAII,
validated dimensions, and reusable factorizations. Avoid process-global mutable
model state and unnecessary allocations. Keep a Python numerical reference
where needed for independent parity and convergence checks.

Python provides HTTPS/API adapters, DataFrame normalization, public objects,
receipt validation, and checkpoint orchestration. Preserve `OceanWave` and the
`OptionWaveV09` alias. Changes to public schemas or checkpoint compatibility must
be explicit, documented, and tested.

Live data belongs behind HTTPS/WebSocket adapters. Keep credentials in runtime
secrets. Do not commit provider responses, account identifiers, private paths,
local maintenance logs, compiled artifacts, or private collection history.
Missing optional data must not trigger invented evidence or undocumented fallback.

After rebuilding the native extension, run the complete Python unit suite,
standalone C++ tests, synthetic sample, and benchmark. Test failure paths,
malformed inputs, causality, state recovery, and bounded memory, not just happy
paths. Update the English documentation and changelog for observable changes.
Do not weaken operating-system execution policies or security controls to build
or run the package.
