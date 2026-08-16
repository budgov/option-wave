You are working on Ocean Wave, a research-only financial-engineering model.

Preserve these invariants:

1. Pair `+d Call` with `-d Put` at the same expiry; never replace this with a
   same-strike Call/Put comparison.
2. Use one direction-neutral distance cost for both sides of every symmetric
   Call/Put pair; IV skew, liquidity, and short pressure remain separate factors.
3. Treat symmetric premium ELO as one factor—not the whole model.
4. Keep verified institutional flow, dealer hedge pressure, IV surface, short
   pressure, OI positioning, stock confirmation, inverse products, and option
   energy in the factor vector.
5. Preserve the published factor priors, but let observed confidence and the
   online covariance matrix determine runtime weights.
6. Keep GEX, VRP, quote liquidity, and factor covariance as risk/PDE modifiers
   rather than arbitrary directional votes.
7. Evolve the strike-expiry field with the PDE and integrate it over time to
   produce expected price, return, variance, and probability.

Numerical hot paths belong in the C++17 extension: pairing/interpolation, ELO,
IV weighted least squares, OI/GEX/energy extraction, flow risk, covariance
weighting, stock confirmation, surface-grid construction, factor projection,
PDE integration, and multi-horizon expectations. Python is the HTTPS/API,
DataFrame normalization, orchestration, and object boundary. Keep the
reference path for portability and numerical cross-checks.

Never guess whale direction, dealer inventory, short data, or inverse products.
Unknown evidence gets zero confidence. Live data must use online HTTPS or
WebSocket APIs; do not add moomoo/OpenD or desktop-broker dependencies. API
credentials belong in runtime secrets.

Run the complete unit suite, sample, and benchmark after rebuilding the C++
extension. Do not add order execution or account actions.
