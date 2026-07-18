# Option Wave Forecast Model v0.9

## 1. Symmetric pair space

For spot \(S_t\), define the positive relative distance \(d\). A pair is

\[
K_c=S_t(1+d), \qquad K_p=S_t(1-d)
\]

so `+5% Call` is always compared with `-5% Put` at the same expiry. Prices
that are not quoted exactly at \(K_c\) or \(K_p\) are linearly interpolated
within that expiry. No expiry is mixed with another during pairing.

## 2. Non-symmetric movement difficulty

The model treats an upside move as harder than a downside move through costs,
not through an arbitrary post-hoc sign flip:

\[
U(d)=d^{p}\exp(a_u d), \qquad D(d)=d^{p}\exp(a_d d)
\]

with \(a_u>a_d\). Therefore \(U(d)>D(d)\) for \(d>0\). The two
energy-equalized premiums are

\[
F_c=\frac{C(K_c,\tau,t)}{U(d)+\epsilon}, \qquad
F_p=\frac{P(K_p,\tau,t)}{D(d)+\epsilon}
\]

The equalized price score is

\[
s=\frac{F_c}{F_c+F_p+\epsilon}
\]

This prevents a raw `2.00 Call` versus `1.00 Put` comparison from assuming
that equal percentage moves require equal market energy.

## 3. Variance-aware observation

For a quoted side, the default relative variance is estimated from its spread:

\[
v_c=\left(\frac{Ask_c-Bid_c}{2Mid_c}\right)^2+v_{c,\mathrm{explicit}}
\]

and likewise for the put. Pair variance and confidence are

\[
v_{pair}=v_c+v_p, \qquad
q=\frac{1}{1+v_{pair}/v_0}
\]

The observed score is shrunk toward an uncertain 50/50 result:

\[
s_v=\frac12+q\left(s-\frac12\right)
\]

Wide or stale quotes therefore move the rating less than tight quotes.

## 4. ELO update

Each \((\tau,d,\mathrm{side})\) node has an online rating \(R\). The expected
Call result against its paired Put is

\[
e_c=\frac{1}{1+10^{(R_p-R_c)/400}}
\]

and the variance-aware update is

\[
\Delta R=K q(s_v-e_c),
\qquad R_c'=R_c+\Delta R,
\qquad R_p'=R_p-\Delta R
\]

The rating state is keyed by expiry and relative distance, so repeated market
snapshots update the same pair instead of recreating a fresh model. The
bounded pair field is

\[
\psi_{d,\tau}=\tanh\left(\frac{R_c-R_p}{400}\right)
\]

For the PDE source, an uncertain pair retains some direct premium information:

\[
\psi_0=q\psi_{d,\tau}+(1-q)(2s_v-1)
\]

The surface sentiment is the pair-weighted average of \(\psi\), with expiry
decay and quote activity included in the integration weight.

## 5. Continuous field equation

The observed ELO surface is the source field \(\psi_0(d,\tau)\). Its
semi-discrete LUNA evolution is

\[
\frac{\partial\psi}{\partial t}
=-v_d\frac{\partial\psi}{\partial d}
+D_d\frac{\partial^2\psi}{\partial d^2}
+D_\tau\frac{\partial^2\psi}{\partial\tau^2}
-\lambda\psi+\kappa(\psi_0-\psi)
\]

The first derivative transports the field, the second derivatives diffuse it,
\(\lambda\) is decay, and \(\kappa(\psi_0-\psi)\) is the live quote source/sink
term. The implementation solves this equation with explicit vectorized finite
differences at a configurable minute step.

## 6. Time integration and expectation

For a horizon \(H\), the model integrates the weighted field score:

\[
I_H=\int_0^H\bar\psi(t)\,dt,
\qquad
\bar\psi_H=\frac{I_H}{H}
\]

Let \(\sigma\) be realized volatility when supplied, otherwise the median IV
in the chain, otherwise the configured fallback. With \(Y=252\cdot390\)
trading minutes per year, the directional expected log return is

\[
\mu_H=\bar\psi_H\sigma\sqrt{\frac{H}{Y}}\,g(\bar\psi_H)
\]

where \(g\) slightly reduces positive moves and increases negative moves when
upside difficulty exceeds downside difficulty. Return variance is

\[
V_H=\sigma^2\frac{H}{Y}(1+\bar v_{pair})
\]

The final outputs are

\[
E[S_H]=S_t e^{\mu_H},\qquad
P(S_H>S_t)=\Phi\left(\frac{\mu_H}{\sqrt{V_H}}\right)
\]

and a lognormal price variance derived from \(V_H\). This is an analytical
expectation, not a guarantee or a calibrated risk-neutral option price.

## 7. Output contract

`ModelResult` returns:

- current `trend_score`, `direction`, and data-aware `confidence`;
- the paired ELO surface for auditability;
- the PDE field tensor for 3D visualization;
- one `Expectation` per requested horizon containing integrated signal,
  expected return, expected price, return variance, price variance, and
  probability of an upward move.

The model does not infer whale flow, dealer inventory, or trade aggressor from
price alone. Those values are deliberately excluded from v0.9 unless a
verified data adapter supplies them.
