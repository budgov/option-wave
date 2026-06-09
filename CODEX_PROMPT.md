You are working on the Option Wave Forecast Model v0.8 (ELO First).

Goals:
1. Inspect the existing Python package.
2. Add data adapters for moomoo OpenD and Schwab/thinkorswim CSV/API market data.
3. Implement robust option-chain normalization.
4. Compute the v0.8 research factors:
   - PremiumSentiment_ELO
   - EnergySignal
   - EnergyVelocity
   - EnergyAcceleration
   - WhaleImpact_adj
   - OIConfirm
   - HedgePressure
   - GEXSignal
   - GammaWallSignal
   - SkewSignal
   - TermSignal
   - IVRankSignal
   - StockConfirm
   - penalty terms: WallPressure, CloseDecay, MomentumDivergence, FlowDecay
   - boost term: BreakoutBoost
5. Add tests using synthetic option chains.
6. Add chart outputs for factor contributions and forecast paths.
7. Keep this as a research and analytics package only. Do not add any order execution or account-action code.

Prioritize correctness, traceability, and clear factor-level debugging.
