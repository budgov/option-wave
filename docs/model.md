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

IV skew, liquidity, and short pressure remain independent evidence or risk
modifiers; they do not alter the Call/Put energy denominator.

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

## 4. Energy, OI, GEX, and dealer hedge

Liquidity-adjusted option energy is integrated over the chain:

\[
\mathcal E_c=\iint 100\,C\,V_c\,|\Delta_c|\,
e^{-|\log(K/S)|/b}e^{-\tau/T}\,dK\,d\tau,
\]

with the same definition for \(\mathcal E_p\). Its bounded direction is

\[
f_E=\tanh\left(\frac{\mathcal E_c-\mathcal E_p}{\mathcal E_c+\mathcal E_p+\epsilon}\right).
\]

When OI changes are available,

\[
f_{OI}=\tanh\left(
\frac{\iint |\Delta_c|\,dOI_c-\iint |\Delta_p|\,dOI_p}
{\iint |\Delta_c|\,|dOI_c|+\iint |\Delta_p|\,|dOI_p|+\epsilon}
\right).
\]

Otherwise the OI level is used with deliberately lower confidence.

Structural gamma exposure is

\[
GEX_t=100S_t^2\iint\left(OI_c|\Gamma_c|-OI_p|\Gamma_p|\right)W\,dK\,d\tau.
\]

Because public chains do not reveal dealer inventory sign, this is treated as
a regime estimate. Verified trade flow supplies a stronger hedge observation:

\[
dH_i=100N_i|\Delta_i|\delta_i,
\qquad
dG_i=100N_i|\Gamma_i|S_t^2\delta_i,
\]

where \(\delta_i=+1\) for buy Call/sell Put, \(-1\) for sell Call/buy Put,
and zero when aggressor direction is unknown.

## 5. Institutional flow integral

For premium \(P_i\), contracts \(N_i\), confidence \(c_i\), age \(a_i\),
and half-life \(h\), decayed signed notional is

\[
q_i(t)=100N_iP_i c_i\delta_i e^{-\ln(2)a_i/h}.
\]

The large-flow signal and velocity are

\[
f_W=\tanh\left(\frac{\sum_{i\in Whale}q_i}{\sum_{i\in Whale}|q_i|+\epsilon}\right),
\]

\[
v_W=\tanh\left(\frac{Q_{recent}}{|Q_{recent}|}-\frac{Q_{prior}}{|Q_{prior}|}\right).
\]

Unknown trade direction has zero confidence; it is never guessed from stock
price behavior.

## 6. Short pressure and squeeze interaction

Normalized short observations are mapped into bounded features \(z_j\): short
interest/float, change in short interest, short-volume ratio, borrow fee,
utilization, and days to cover. Their internal pressure is

\[
p_s=\frac{\sum_j\rho_jz_j}{\sum_j\rho_j}.
\]

The directional factor includes an interaction with positive stock
confirmation \(f_S\):

\[
f_{short}=\operatorname{clip}\left(-p_s+1.6[p_s]^+[f_S]^+,-1,1\right).
\]

High short pressure is bearish until positive price confirmation creates a
squeeze regime.

For an explicitly registered inverse product with daily beta \(\beta_k<0\),
the native bounded signal is direction-mapped and leverage-normalized:

\[
f_{inverse,k}=\operatorname{sign}(\beta_k)\tanh\left(
\frac{\operatorname{atanh}(s_{inverse,k})}{\max(|\beta_k|,1)}
\right).
\]

Several available inverse products are combined by observed data confidence.

## 7. Factor vector and structural priors

The directional state is

\[
\mathbf f_t=
\begin{bmatrix}
f_{ELO}&f_W&f_H&f_{IV}&f_{short}&f_{OI}&f_S&f_{inverse}&f_E
\end{bmatrix}^T.
\]

The prior importance vector is

\[
\boldsymbol\pi=
\begin{bmatrix}
.22&.16&.14&.12&.10&.09&.08&.05&.04
\end{bmatrix}^T.
\]

Each factor also has observed confidence \(q_i\in[0,1]\). Missing evidence has
\(q_i=0\), so it cannot influence the result.

## 8. Online covariance and adaptive matrix weights

The online mean and covariance use continuous EWMA updates:

\[
\boldsymbol\mu_t=(1-\alpha)\boldsymbol\mu_{t-1}+\alpha\mathbf f_t,
\]

\[
\boldsymbol\Sigma_t=(1-\alpha)\boldsymbol\Sigma_{t-1}
+\alpha(\mathbf f_t-\boldsymbol\mu_{t-1})(\mathbf f_t-\boldsymbol\mu_t)^T.
\]

The non-negative ridge-GLS projection is

\[
\widetilde{\mathbf w}_t=
\left[(\boldsymbol\Sigma_t+\lambda I)^{-1}
(\boldsymbol\pi\odot\mathbf q_t)\right]_+,
\qquad
\mathbf w_t=\frac{\widetilde{\mathbf w}_t}
{\mathbf 1^T\widetilde{\mathbf w}_t}.
\]

The global directional source and its factor uncertainty are

\[
z_t=\mathbf w_t^T\mathbf f_t,qquad
V_{factor,t}=\mathbf w_t^T\boldsymbol\Sigma_t\mathbf w_t.
\]

This preserves the requested importance order as a prior while reducing
correlated or unstable factors at runtime.

## 9. Continuous Ocean Wave PDE and matrix form

The ELO topology and global projection are coupled with the basis

\[
b(d,\tau)=e^{-|d|/0.08}e^{-\tau/45},qquad
u_t=\psi_{ELO}+b(d,\tau)(z_t-\bar\psi_{ELO}).
\]

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

Negative GEX increases source amplification; positive GEX damps it. Wide
spreads and VRP stress increase diffusion/forecast variance.

After finite-difference discretization of \((d,\tau)\),

\[
\dot{\mathbf x}_t=A_t\mathbf x_t+B_t\mathbf f_t+\boldsymbol\varepsilon_t,
\]

and the implemented explicit step is

\[
\boxed{\mathbf x_{n+1}=(I+\Delta t A_t)\mathbf x_n+\Delta t B_t\mathbf f_t}.
\]

The C++ kernel operates directly on contiguous arrays and integrates all
requested horizons in one pass.

## 10. Time integral and complete expectation

For integration weight \(W(d,\tau)\),

\[
\bar\psi(t)=\frac{\iint\psi(d,\tau,t)W(d,\tau)\,dd\,d\tau}
{\iint W(d,\tau)\,dd\,d\tau},
\]

\[
I_H=\int_0^H\bar\psi(t)dt,qquad \bar\psi_H=I_H/H.
\]

Expected log return is

\[
\mu_H=\bar\psi_H\sigma\sqrt{H/Y}\,a_\Gamma(t),
\]

where \(a_\Gamma\) is the GEX regime multiplier. Forecast variance is

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
