# Ocean Wave mathematical specification

## 1. State domain and symmetric contracts

Let spot be \(S_t\), relative distance \(d\ge 0\), time to expiry \(\tau\),
and market time \(t\). Each expiry is paired independently:

\[
K_c=S_t(1+d),\qquad K_p=S_t(1-d).
\]

Thus a `+5% Call` competes with a `-5% Put`; different expiries are never
mixed during interpolation.

Both sides use the same direction-neutral distance cost:

\[
R(d)=d^p.
\]

IV skew and liquidity remain separate evidence or risk modifiers; they do
not alter the Call/Put energy denominator.

The equalized premium forces are

\[
F_c=\frac{C(K_c,\tau,t)}{R(d)+\epsilon},\qquad
F_p=\frac{P(K_p,\tau,t)}{R(d)+\epsilon},
\]

and the observed Call score is \(s=F_c/(F_c+F_p+\epsilon)\).

## 2. Variance-aware ELO field

Relative quote variance is estimated from bid/ask unless an explicit variance
is supplied:

\[
v_c=\left(\frac{Ask_c-Bid_c}{2Mid_c}\right)^2+v_{c,explicit},\qquad
v_{pair}=v_c+v_p.
\]

Confidence and the shrunk observation are

\[
q=\frac{1}{1+v_{pair}/v_0},\qquad
s_v=\frac12+q\left(s-\frac12\right).
\]

For ratings \(R_c,R_p\),

\[
e_c=\frac{1}{1+10^{(R_p-R_c)/400}},\quad
\Delta R=Kq(s_v-e_c),
\]

\[
R_c'=R_c+\Delta R,\qquad R_p'=R_p-\Delta R,
\]

and the bounded local field is

\[
\psi_{ELO}(d,\tau,t)=\tanh\left(\frac{R_c-R_p}{400}\right).
\]

## 3. IV surface as a weighted matrix regression

With log-moneyness \(k=\log(K/S_t)\), the executable surface fit is

\[
\sigma(k,\tau)=\beta_0+\beta_1k+\beta_2k^2+\beta_3\sqrt{\tau}+\varepsilon,
\]

\[
\boxed{\beta=(X^TWX+\lambda I)^{-1}X^TW\boldsymbol\sigma}.
\]

Here \(W\) combines distance, expiry, quote liquidity, and activity. The
engine retains level, moneyness slope, curvature, and time slope. Directional
IV pressure compares weighted OTM Call and Put IV:

\[
f_{IV}=\tanh\left(\frac{\overline\sigma_{call,OTM}-\overline\sigma_{put,OTM}}{0.05}\right).
\]

The volatility risk premium

\[
VRP_t=\sigma_{ATM,t}-\sigma_{realized,t}
\]

is a risk/variance modifier, not a forced directional vote.

## 4. Diagnostic option structure, not institutional positions

Chain volume, open interest and unsigned Greeks do not identify an observed
aggressor, opening trade, dealer inventory or beneficial owner. Their quality,
coverage, changes and unsigned exposure remain diagnostics and uncertainty
inputs. They no longer supply separate institutional-flow, short-pressure,
OI-direction, dealer-hedge or option-energy directional votes.

The retired nine-factor coefficients must not be restored by missing-data
fallbacks. Historical diagnostic records remain evidence; they are not new
training features merely because their old names still appear in an archive.

## 5. Explicit, aligned inverse observations

For an inverse product with stated daily leverage \(\beta<0\), use the same
causal window \([t-h,t]\) as the target and map log return to target units:

\[
r_{inverse,h}^{target}=
\frac{\log(P_{inverse,t}/P_{inverse,t-h})}{\beta}.
\]

The production pairs are QQQ/SQQQ (-3x daily), SPY/SH (-1x), TSLA/TSLS (-1x)
and AAPL/AAPD (-1x). Daily leverage is a stated target, not an assumption of
perfect intraday or multi-day tracking. Quotes must be fresh, timestamped,
non-delayed and no later than the forecast cutoff. Reference observations
must match the same session/window; missing windows remain missing.

A bounded signal and observed confidence summarize the aligned inverse
returns. Correlation with the underlying is explicitly penalized by section 8;
another ticker is not automatically independent evidence.

## 6. Macro context and risk

The four macro channels are gold, U.S. 10-year Treasury yield, the dollar
index and VIX. No fixed sign such as "gold up means stocks down" is imposed.

Retain observed instrument, source, timestamp, units and proxy status. GLD is
a gold-ETF proxy, not spot gold. UUP is a dollar-futures ETF diagnostic, not a
silent dollar-index replacement. Schwab uses $NYICDX for the ICE U.S. Dollar
Index. A Treasury price is not a yield; $TNX requires verified provider identity
and the explicit Cboe 10-times-yield unit contract, with verified historical
references. Unverified units make the yield feature missing rather than
numerically plausible.

Raw macro observations can widen forecast uncertainty through a bounded risk
multiplier and enter mature supervised context learning. Main-model macro
direction is missing until a validated directional mapping is supplied.
A reserved macro budget is not an instruction to manufacture a sign.

## 7. Maximum-entropy information-group budgets

The main factor order is

\[
\mathbf f_t=
\begin{bmatrix}
f_{ELO}&f_{IV}&f_S&f_{inverse}&f_{gold}&f_{10y}&f_{USD}&f_{VIX}
\end{bmatrix}^{T}.
\]

The budget vector is

\[
\mathbf b=
\begin{bmatrix}
.125&.125&.25&.25&.0625&.0625&.0625&.0625
\end{bmatrix}^{T}.
\]

With no validated comparative skill estimates, four information groups each
receive 25%: options, underlying, inverse confirmation and macro context.
Maximizing \(-\sum_{g=1}^{4}b_g\log b_g\) subject to \(b_g\ge0\) and
\(\sum_gb_g=1\) yields equal group allocations. Options are split evenly
between ELO/IV; macro is split four ways. This is a transparent initial prior,
**not** the optimum for future predictive accuracy.

For confidence \(q_i\in[0,1]\), define a hard upper budget \(u_i=b_iq_i\).
Missing, stale, unaligned or unverified evidence has \(q_i=0\).

## 8. Bounded convex redundancy allocation

A masked positive-semidefinite EWMA covariance \(\Sigma_t\) uses
\(\alpha=.08\). Missing observations do not decay their diagonal variance
toward zero. Let \(C_t=\operatorname{corr}(\Sigma_t)\); the redundancy matrix is

\[
R_t=(1-s)(C_t\odot C_t)+sI,\qquad s=.25,
\]

where \(\odot\) is elementwise multiplication. Both positive and negative
correlation represent redundant evidence. The Schur product preserves positive
semidefiniteness; shrinkage keeps the penalty well-conditioned.

With \(H_t=(1-\lambda)I+\lambda R_t\), \(\lambda=.25\), solve

\[
\boxed{
\min_{\mathbf w}\ \frac12\mathbf w^TH_t\mathbf w-\mathbf u^T\mathbf w
\quad\text{subject to }0\le w_i\le u_i
}.
\]

For \(0\le\lambda<1\), the positive-definite quadratic has a unique constrained minimizer.
Its diagonal is one: an isolated fully observed factor retains its own budget,
instead of receiving a penalty for correlation with itself. The
bounded coordinate solver uses at most 512 iterations and a projected-gradient
KKT tolerance of \(10^{-9}\). C++ and the Python numerical reference must agree.

Do **not** divide the resulting weights by their sum. Instead record

\[
w_{neutral}=1-\sum_iw_i,\qquad
z_t=\mathbf w^T\mathbf f_t,\qquad
V_{factor,t}=\mathbf w^T\Sigma_t\mathbf w.
\]

The neutral remainder contributes zero directional score. Removed or missing
evidence cannot inflate the ELO weight; even a fully observed ELO has a 12.5%
budget ceiling. These effective allocations control redundancy and evidence
coverage, not estimated causal truth or guaranteed performance.

Evidence confidence is \(C_t=\sum_iw_i\), not \(\sum_iw_iq_i\): observation
quality already enters the eligible budget. Final confidence applies the
factor-uncertainty discount \(C_t\exp(-V_{factor,t})\); it does not repeat the
option-liquidity penalty across all factors. Liquidity still enters option
observation quality, PDE diffusion, forecast variance and execution costs.
This confidence is evidence coverage, not an empirically calibrated hit rate.


## 9. Continuous Ocean Wave PDE and matrix form

The ELO topology and global projection are coupled with the basis

\[
b(d,\tau)=e^{-|d|/0.08}e^{-\tau/45},\qquad
u_t=w_{ELO}\psi_{ELO}
+b(d,\tau)(z_t-w_{ELO}\bar\psi_{ELO}).
\]

The source receives an independent copy of the ELO topology scaled by its
effective factor allocation. The raw ELO surface stays available for audit;
it cannot silently become a full-strength second path around the budget.

The field is a signed score in \([-1,1]\), not a price probability density.
Distance \(d\) is a return fraction (0.01 means 1%), expiry \(\tau\) is in
days, and evolution time \(t\) is in minutes. Thus \(D_d\) has units of
return-fraction squared/minute, \(D_\tau\) days squared/minute, \(v_d\)
return-fraction/minute, and \(\lambda,\kappa\) inverse minutes. The projected
source basis is normalized by its observed-weight mean, and the initial/source
score \(u_t\) is restricted to \([-1,1]\) before integration.

The field evolves as

\[
\boxed{
\frac{\partial\psi}{\partial t}
=-v_d\frac{\partial\psi}{\partial d}
+D_d(t)\frac{\partial^2\psi}{\partial d^2}
+D_\tau(t)\frac{\partial^2\psi}{\partial\tau^2}
-\lambda(t)\psi+\kappa(t)(u_t-\psi)
}.
\]

Unsigned gamma structure remains an audited diagnostic, not a measured dealer
position or a signed source multiplier. The gamma multiplier is currently 1.
Wide spreads, VRP stress and macro-risk context can increase diffusion or
forecast variance.

Both ends of each coordinate axis use homogeneous Neumann conditions
\(\partial_n\psi=0\): no diffusive boundary flux and a constant ghost value
for advection. For adjacent distances \(h_-=d_i-d_{i-1}\) and
\(h_+=d_{i+1}-d_i\), the nonuniform finite-volume diffusion is

\[
(L_d x)_i=\frac{D_d}{(h_-+h_+)/2}
\left[\frac{x_{i+1}-x_i}{h_+}-\frac{x_i-x_{i-1}}{h_-}\right].
\]

Endpoint control volumes have half the adjacent spacing and their outer
flux is zero. Expiry diffusion uses the same stencil. Drift uses the upwind
neighbor selected by the sign of \(v_d\); singleton axes have zero spatial
operator. This diffusion conserves the control-volume-weighted score, while
the signed-score advection is not a density-conservation equation.

The implemented step is a product of backward-Euler solves:

\[
\boxed{\mathbf x_{n+1}=(I-\Delta t L_\tau)^{-1}
(I-\Delta t L_d)^{-1}
\frac{\mathbf x_n+\Delta t\kappa\mathbf u}{1+\Delta t(\lambda+\kappa)}}.
\]

Each tridiagonal system has nonnegative inverse entries and preserves
constants. For nonnegative diffusion, decay and source strength, the combined
step obeys the score maximum principle without output clipping. It is
first-order accurate in time; implicit stability does not remove the need for
step-size and grid-convergence checks. Coefficients retain their configured
values and require out-of-sample calibration; numerical stability alone does
not validate predictive accuracy.

The C++ kernel operates directly on contiguous arrays. The Thomas factors and
normalized aggregation weights are reused across equal-sized steps. Working
storage is linear in grid size, and each step is linear work; there are no
adaptive substep loops. Scores are retained only on explicit request. Invalid
coefficients, unordered/duplicate coordinates, non-finite values, negative
weights, more than one million grid cells/steps, more than 10,000 horizons, or
more than 100 million cell-steps are rejected before integration.
It constructs the
strike-expiry grid, projects the global factor signal, evolves the PDE, and
integrates all requested horizons in one call. The Python implementation is a
portable numerical reference rather than the production hot path.

## 10. Time integral and complete expectation

For integration weight \(W(d,\tau)\),

\[
\bar\psi(t)=\frac{\iint\psi(d,\tau,t)W(d,\tau)\,dd\,d\tau}
{\iint W(d,\tau)\,dd\,d\tau},
\]

\[
I_H=\int_0^H\bar\psi(t)dt,\qquad \bar\psi_H=I_H/H.
\]

Trapezoidal quadrature integrates the piecewise-linear score trajectory at
each requested horizon, including fractional steps. The final field stops at
the exact largest horizon; it never advances to a later rounded-up time. The
optional score array contains the initial score, regular step scores, and a
shorter final step when needed. Existing integral/average/field result keys
are unchanged.

Expected log return is

\[
\mu_H=\bar\psi_H\sigma\sqrt{H/Y}\,a_\Gamma(t),
\]

where \(a_\Gamma=1\): the former signed dealer/GEX multiplier is retired.
Forecast variance is

\[
V_H=\sigma^2\frac{H}{Y}\left[
1+\bar v_{pair}+V_{factor,t}+(1-L_t)+c_{VRP}|VRP_t|
\right].
\]

Under \(\log(S_H/S_t)\sim N(\mu_H,V_H)\), the complete outputs are

\[
\boxed{E[S_H]=S_t\exp(\mu_H+\tfrac12V_H)},
\]

\[
\boxed{P(S_H>S_t)=\Phi\left(\frac{\mu_H}{\sqrt{V_H}}\right)},
\]

\[
\boxed{\operatorname{Var}(S_H)=E[S_H]^2(e^{V_H}-1)}.
\]

These are model expectations conditioned on supplied data, not guarantees or
arbitrage-free option prices.

## 11. Causal completeness, calibration, and abstention

The six intraday inputs `VWAP`, `RVOL`, 5-minute return, 15-minute return,
realized volatility, and minutes from the open are treated as observed causal
fields. With source confidence \(c_s\), their completeness is

\[
q_{data}=c_s\frac{1}{6}\sum_{j=1}^{6}\mathbf 1\{x_j\text{ is valid}\}.
\]

For raw probability \(p=\Phi(\mu_H/\sqrt{V_H})\) and evidence quality
\(q_e\), the conservative probability exposed by the model is

\[
p_c=\frac12+\left(p-\frac12\right)q_eq_{data},\qquad
e_c=2\left|p_c-\frac12\right|.
\]

The model abstains when the trading day is invalid, causal completeness or
evidence quality is below its configured floor, or \(e_c\) is too small. Raw
probability and numerical expectations remain available for scoring. An
invalid training day is evaluated against a disposable copy of online state,
so it cannot update ELO ratings or factor covariance.

## 12. Event-risk modifier

Timestamped events modify uncertainty, never direction. Define proximity

\[
g(m;h)=\begin{cases}e^{-m/h},&m\ge0\\0,&\text{otherwise},\end{cases}
\]

with e-folding decay constants of 390 minutes for earnings and 180 minutes for
macro events.
For event confidence \(c\), surprise \(z\), and headline intensity \(n\),

\[
r=.75\max(g_{earn},g_{macro})+.20\min(|z|,3)/3+.15\operatorname{clip}(n,0,1),
\]

\[
V_H^{event}=V_H(1+cr),\qquad q_e^{event}=q_e/(1+cr).
\]

## 13. Shadow contract-value approximation

Contract selection is a separate diagnostic and does not feed back into the
underlying Ocean Wave direction. Under explicitly declared quote and Greek
units, the premium-change approximation is

\[
E[\Delta V]=\Delta S\mu_H+\frac12\Gamma S^2(V_H+\mu_H^2)
+\Theta H/390+100\mathcal V\,\Delta IV.
\]

Here the contract overlay uses **simple-return** mean and variance, unlike the
log-return parameters in section 10. For an Ocean Wave expectation, it converts
\(V_H^{simple}=\operatorname{Var}(S_H)/S_t^2\); an external expectation without
price variance must explicitly declare simple-return variance units. Profit
probability solves the quadratic Delta/Gamma payoff under a normal
approximation to this simple return, conditional on the stated IV scenario.
Theta, spread, and per-share fees shift the payoff threshold. This is an
approximation, not the underlying's favorable-direction probability. Invalid
native ranges or missing required units/Greeks/fees yield an unavailable
overlay; native unavailability never substitutes a direction probability.

The executable edge subtracts one round-trip spread and per-share fees:

\[
E[\Delta V]_{net}=E[\Delta V]-(Ask-Bid)-Fee/Multiplier.
\]

Missing Greeks, ambiguous units, an unmatched contract, or an unavailable
horizon produces an explicit abstention rather than an imputed value. The
base, IV-expansion, and IV-contraction scenarios remain shadow-only.

## 14. Causal intraday Fourier features

Let \(r_0,\ldots,r_{N-1}\) be only the return prefix observable at the
forecast cut-off. The C++ kernel fits a causal OLS line \(a+bn\), applies a
Hann taper \(w_n=(1-\cos(2\pi n/(N-1)))/2\), and evaluates

\[
A_k=\frac{2}{N\bar w}\sum_{n=0}^{N-1}w_n(r_n-a-bn)\cos(2\pi kn/N),
\]

\[
B_k=\frac{2}{N\bar w}\sum_{n=0}^{N-1}w_n(r_n-a-bn)\sin(2\pi kn/N),
\qquad P_k\propto A_k^2+B_k^2.
\]

Energy is summarized in fixed 2–5, 5–15, 15–60, and 60–120 minute period
bands. The transform never pads from or centers on future observations, and
native-core unavailability yields an abstention rather than a Python spectral
fallback.

## 15. Bounded shadow calibration

For observed outcome \(y\in\{0,1\}\), a shadow bucket uses

\[
\hat p=\sigma(a+b\operatorname{logit}(p)),\qquad
\eta_n=\eta_0/\sqrt{1+n/25},
\]

\[
a\leftarrow\operatorname{clip}(a+\eta_n(y-\hat p),-1.5,1.5),
\quad
b\leftarrow\operatorname{clip}(b+\eta_n(y-\hat p)\operatorname{logit}(p),.5,1.5).
\]

Event identifiers make feedback idempotent. Invalid sessions do not mutate
state. The v4 calibrator blends raw and fitted probability according to
readiness; a fitted direction can cross 0.5 rather than being permanently
locked to the old direction. Its base model is `ocean-wave.group-budget.v4`.
Old mixed-target v1 and retired-model v2/v3 calibration files remain untouched and
are not loaded. Feedback must carry the base-model version frozen at entry;
old or unversioned positions cannot train the new bucket merely because they
close after the upgrade.
Default 500 mature samples and 40 valid trading days are eligibility gates,
not deployment authorization or evidence that calibration improves accuracy.

## 16. Mature supervised option and context challengers

The native `online_forecast.v3` learner compares five bounded experts:
stock-only, fused stock/options, context, trend and reversion. This is a
candidate-only learner, separate from sections 7–8's main-model budgets. It
does not automatically replace or promote the deployed forecast.

The schema contains eight stock observations, eleven option observations and
seven context observations. In fixed order, the option observations are
`premium_elo_signal`, `premium_elo_confidence`, `iv_skew`, `iv_level`,
`iv_term_slope`, `iv_curvature`, `volatility_risk_premium`, `gamma_imbalance`,
`gamma_concentration`, `liquidity_quality` and `option_activity`. Their units
and availability rules are specified in the
[data contract](data_integration.md#native-v3-option-feature-contract).
Directional OI and unverifiable signed-flow slots remain retired. Gamma
imbalance and concentration describe public unsigned chain structure, not
known dealer inventory or a predefined direction.

The context vector contains aligned inverse returns over 5 and 15 minutes,
gold-proxy 5-minute return, 10-year yield change in basis points, dollar-index
5-minute return, VIX change and VIX level. Conditional coefficients learn from
mature labels instead of hard-coding macro signs.

**Causal standardization and conditional option learning.** Each measured
feature is standardized using statistics from eligible mature observations,
with a feature-specific scale floor and clipping to [-4, 4]. An explicit
missing mask distinguishes an absent measurement from an observed zero;
missing-indicator design terms have scale 0.25. For a standardized option or
context observation `z_j`, the conditional input is
`r_j = clip(z_j - beta_j^T x_stock, -4, 4)`, with bounded, regularized
conditioning coefficients learned only after maturity.

Premium ELO is an explicit learnable option residual, not a fixed 12.5%
allocation in this candidate. Its residual is multiplied by its measured
confidence; absent or zero confidence disables the ELO observation. Three
clipped interaction terms require all measured parents: confidence-gated
ELO residual times normalized IV skew, ELO residual times raw gamma
concentration, and normalized stock 5-minute return times normalized IV term.
No parent observation is synthesized to enable an interaction.

`option_feature_coverage` is the effective observed option count divided by
11. It is a diagnostic, not an additional signal-amplitude penalty. The
option gate is the supplied evidence quality when at least one effective
option observation exists, otherwise zero. The context gate remains its
observed count divided by seven. Gradients are normalized by measured value
and interaction terms, excluding missing-indicator count, so adding absent
columns does not dilute an already valid feature's learning. Stock and
option coefficients have L2 regularization 0.005 and bounded updates; the
stock intercept is exempt from that penalty.

The raw stock logit is clipped to [-4, 4]. Each conditional option/context
increment is separately clipped to [-4, 4], then multiplied by its quality
gate. The fused and context experts apply the logistic function to the stock
logit plus their corresponding increment. Warm-up probabilities shrink
toward 0.5 with factor `n / (n + 32)`, where `n` is the eligible mature sample
count. Receipt explanations retain the normalized inputs, effective designs,
observed masks, individual pre-clip logit contributions and quality gates.
These are conditional log-odds contributions, not percentage allocations or
an exact additive decomposition of the final ensemble probability.

**Frozen proper-loss expert learning.** Initial expert weights are 20% each.
For an eligible mature label `y = 1[actual_return > 0]`, use each expert's
probability frozen at issuance, not a reissued prediction:

```text
loss_e = (p_e_frozen - y)^2
logw_e = (1 - 0.001) * logw_e - 0.05 * loss_e
logw_e = clip(logw_e - max(logw), -8, 0)
weight_e = exp(logw_e) / sum(exp(logw))
```

The former 10% hard expert floor is removed. Bounded log weights keep the
softmax finite, and explicit weak prior reversion permits recovery without
reserving an arbitrary percentage for each expert. This is prequential
out-of-sample-at-issue loss learning, not evidence that weights are optimal
on unseen market regimes.

Each symbol/horizon has fixed numerical state (715 doubles, including a
256-score rolling interval window); the Python boundary additionally bounds
model count, duplicate tracking and checkpoint size. Immutable, digest-checked
v3 receipts freeze inputs, probabilities, issue time, maturity and the
training watermark. Old v1/v2 state and receipts are rejected, not silently
reinterpreted under a wider feature schema. Every valid mature direction
receives +1 when correct and -1 when wrong. A zero return is `not_up`, and a
probability equal to 0.5 also selects `not_up`; Brier/log losses remain
separate probability metrics. Absent or unaligned outcomes stay unscored.
Only eligible mature observations update learning; duplicate receipts do not
train twice. Replay may re-encode gradients under the rebuilt learner, but
retains original issued probabilities and historical scores. Synthetic
feature-learning and replay tests verify behavior, not improved market
accuracy or permission to promote the candidate.

## 17. State and data migration

The main model writes named-factor v3 state with weighting scheme
`bounded-correlation-budget.v2`. Valid old v1/v2 states may retain independent
ELO ratings, but old covariance/means are reset, not reinterpreted under the
new evidence-quality contract. V2's identities and covariance are validated
before migration. Profit calibration uses v4 and accepts only frozen
current-base forecasts. Host-specific minute-lead calibration is not shipped.
Online feature dimensions and model versions are similarly isolated.

This migration does not delete source evidence, market timestamps, frozen
predictions or scored outcomes. An old
record's original factor table is evidence of that forecast, not the current
weight configuration. Host applications must preserve that evidence separately
from disposable build artifacts. Private storage maintenance is not part of
this model-only package.
