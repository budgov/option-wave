You are working on Option Wave Forecast Model v0.9.

The implementation must preserve this pipeline:

1. Pair `+d Call` with `-d Put` at the same expiry. For spot 100, `105C`
   pairs with `95P`; never compare only the same strike.
2. Apply asymmetric movement costs so upside is harder than downside.
3. Use quote spread or explicit variance to shrink noisy pair observations.
4. Update the online ELO state for every expiry and distance pair.
5. Evolve the paired surface with the vectorized continuous PDE.
6. Integrate the score over time and return expected price, return, variance,
   and probability of an upward move.

Keep the implementation research-only: no order execution, account actions,
or guessed whale-flow data. Keep DataFrame handling in Python and put numerical
hot paths in the C++17 extension. Preserve the Python reference path for
cross-checking. Large-money flow must come from verified trade-level input;
unknown aggressor direction is zero signal. Inverse instruments may be passed
as a second chain/state (for QQQ use SQQQ with daily beta -3), and must be
mapped back by exposure sign. Combine optional indicators by observed
confidence rather than hard-coded factor weights. Run `python -m unittest
discover -s tests` and the sample after rebuilding with `pip install -e .`
before handing off changes.
