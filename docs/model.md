# Option Wave Forecast Model v0.8 (ELO First)

## 1. Continuous market space

Let:

\[
K = \text{strike}, \quad \tau = \text{time to expiry}, \quad t = \text{market time}, \quad S_t = \text{underlying price}
\]

Call and put price fields:

\[
C(K,\tau,t), \quad P(K,\tau,t)
\]

Bullish and bearish energy fields:

\[
e^+(K,\tau,t), \quad e^-(K,\tau,t)
\]

Net wave field:

\[
\psi(K,\tau,t)=e^+(K,\tau,t)-e^-(K,\tau,t)
\]

Total energy field:

\[
\phi(K,\tau,t)=e^+(K,\tau,t)+e^-(K,\tau,t)
\]

## 2. Step 1: ELO first, energy-equalized option premium

Distance functions:

\[
d_c(K,t)=\frac{K-S_t}{S_t}, \quad K>S_t
\]

\[
d_p(K,t)=\frac{S_t-K}{S_t}, \quad K<S_t
\]

Asymmetric energy resistance:

\[
R_c=d_c^{\alpha_c}, \quad R_p=d_p^{\alpha_p}
\]

Usually:

\[
\alpha_c>\alpha_p
\]

because upside often requires sustained buying pressure while downside can accelerate through fear, stop-loss selling, and liquidity gaps.

Energy-equalized premiums:

\[
C^*(K,\tau,t)=\frac{C(K,\tau,t)}{R_c(K,t)+\epsilon}
\]

\[
P^*(K,\tau,t)=\frac{P(K,\tau,t)}{R_p(K,t)+\epsilon}
\]

ELO expected score for a call node versus the matched put node:

\[
P_{call}=\frac{1}{1+10^{(E_p-E_c)/400}}, \quad P_{put}=1-P_{call}
\]

Actual energy-equalized match score:

\[
Score_{call}=\frac{C^*}{C^*+P^*+\epsilon}
\]

\[
Score_{put}=\frac{P^*}{C^*+P^*+\epsilon}
\]

ELO update:

\[
E_c' = E_c + K_f(Score_{call}-P_{call})
\]

\[
E_p' = E_p + K_f(Score_{put}-P_{put})
\]

This creates the ELO surface:

\[
E(K,\tau,t)
\]

## 3. Premium sentiment from ELO aggregation

\[
PS_{ELO}(t)=
\frac{
\iint_{K>S_t} E_c(K,\tau,t)W_c(K,\tau,t)dK d\tau
-
\iint_{K<S_t} E_p(K,\tau,t)W_p(K,\tau,t)dK d\tau
}{
\iint |E_c|W_c dK d\tau
+
\iint |E_p|W_p dK d\tau
+\epsilon
}
\]

`PremiumSentiment_ELO` is the first-priority factor in v0.8.

## 4. Energy field PDE

\[
\frac{\partial e^{\pm}}{\partial t}
+
\frac{\partial}{\partial K}(v_K^{\pm}e^{\pm})
+
\frac{\partial}{\partial \tau}(v_{\tau}^{\pm}e^{\pm})
=
D_K^{\pm}\frac{\partial^2 e^{\pm}}{\partial K^2}
+
D_{\tau}^{\pm}\frac{\partial^2 e^{\pm}}{\partial \tau^2}
-
\lambda^{\pm}e^{\pm}
+
q^{\pm}(K,\tau,t)
\]

## 5. Energy aggregation

\[
\mathcal{E}^{\pm}(t)=\int_{\tau_{min}}^{\tau_{max}}\int_{K_{min}}^{K_{max}}
e^{\pm}(K,\tau,t)W(K,\tau,S_t)dK d\tau
\]

\[
EnergySignal(t)=\frac{\mathcal{E}^{+}(t)-\mathcal{E}^{-}(t)}{\mathcal{E}^{+}(t)+\mathcal{E}^{-}(t)+\epsilon}
\]

\[
EnergyVelocity(t)=\frac{d}{dt}\mathcal{E}_{net}(t), \quad
EnergyAcceleration(t)=\frac{d^2}{dt^2}\mathcal{E}_{net}(t)
\]

## 6. Whale flow confidence adjustment

If verified whale/tape data is unavailable:

\[
WhaleImpact_{adj}=0
\]

Otherwise:

\[
WhaleImpact_{adj}=Confidence_{whale}\cdot WhaleImpact
\]

where `Confidence_whale` depends on data quality:

- 1.0: verified tape with buy/sell aggressor
- 0.6: inferred from volume/OI abnormality
- 0.2: market behavior proxy only
- <0.3: ignore in core model

## 7. Dealer hedge pressure

\[
dH=100[\Delta dN+N\Gamma dS+NVanna dIV+NCharm dt]
\]

\[
HedgePressure(t)=\frac{S_t\int\int dH(K,\tau,t)}{StockDollarVolume(t)+\epsilon}
\]

## 8. GEX and Gamma Wall

\[
GEX(t)=\int\int OI(K,\tau,t)\Gamma(K,\tau,t)100S_t^2\eta(K,\tau,t)dK d\tau
\]

\[
GEXSignal(t)=\frac{GEX_{call}-GEX_{put}}{|GEX_{call}|+|GEX_{put}|+\epsilon}
\]

\[
Wall(K,t)=\int OI(K,\tau,t)|\Gamma(K,\tau,t)|Volume(K,\tau,t)W_\tau(\tau)d\tau
\]

\[
K_{wall}(t)=\arg\max_K Wall(K,t)
\]

## 9. Penalty and boost terms

\[
WallPressure(t)=\exp\left(-\frac{|S_t-K_{wall}|}{h}\right)\mathbf{1}_{S_t<K_{wall}}\mathbf{1}_{\mathcal{E}_{net}>0}
\]

\[
CloseDecay(t)=\left(\frac{t-t_{open}}{t_{close}-t_{open}}\right)^p
\mathbf{1}_{S_t<High_t}\frac{High_t-S_t}{High_t-Low_t+\epsilon}
\]

\[
MomentumDivergence(t)=\mathbf{1}_{EnergySignal>0}\mathbf{1}_{dS_t/dt<0}\mathbf{1}_{S_t<High_t}\left|\frac{High_t-S_t}{S_t}\right|
\]

\[
FlowDecay(t)=\mathbf{1}_{EnergySignal>0}\mathbf{1}_{d\mathcal{E}^{+}/dt<0}\mathbf{1}_{d\mathcal{E}^{-}/dt>0}
\]

\[
BreakoutBoost(t)=\mathbf{1}_{S_t>K_{wall}}\mathbf{1}_{dS_t/dt>0}\mathbf{1}_{\mathcal{E}_{net}>0}
\]

## 10. State-space model

State vector:

\[
\mathbf{x}(t)=
\begin{bmatrix}
\mathbf{E}(t)\\
\boldsymbol{\Pi}(t)\\
\mathbf{e}^{+}(t)\\
\mathbf{e}^{-}(t)\\
\boldsymbol{\sigma}(t)\\
\mathbf{o}(t)\\
\mathbf{g}(t)\\
\mathbf{h}(t)\\
\mathbf{s}(t)
\end{bmatrix}
\]

Input vector:

\[
\mathbf{u}(t)=
\begin{bmatrix}
\mathbf{q}^{+}(t)\\
\mathbf{q}^{-}(t)\\
\mathbf{q}_{whale}^{+}(t)\\
\mathbf{q}_{whale}^{-}(t)\\
\mathbf{C}(t)\\
\mathbf{P}(t)\\
\mathbf{v}_{stock}(t)
\end{bmatrix}
\]

State equation:

\[
\frac{d\mathbf{x}(t)}{dt}=\mathbf{A}(t)\mathbf{x}(t)+\mathbf{B}(t)\mathbf{u}(t)+\boldsymbol{\varepsilon}(t)
\]

Discrete form:

\[
\mathbf{x}_{t+\Delta t}=e^{\mathbf{A}_t\Delta t}\mathbf{x}_t+\mathbf{G}_t\mathbf{u}_t+\boldsymbol{\varepsilon}_t
\]

Factor mappings:

\[
\mathbf{f}_t=\mathbf{C}_f\mathbf{x}_t+\mathbf{D}_f\mathbf{u}_t
\]

\[
\mathbf{r}_t=\mathbf{C}_r\mathbf{x}_t+\mathbf{D}_r\mathbf{u}_t
\]

\[
\mathbf{b}_t=\mathbf{C}_b\mathbf{x}_t+\mathbf{D}_b\mathbf{u}_t
\]

Final output:

\[
TrendScore_{v0.8}(t)=\tanh(\mathbf{w}^T\mathbf{f}_t-\boldsymbol{\lambda}^T\mathbf{r}_t+\boldsymbol{\gamma}^T\mathbf{b}_t)
\]

## 11. Suggested starting weights

| Factor | Weight |
|---|---:|
| PremiumSentiment_ELO | 0.25 |
| EnergySignal | 0.15 |
| EnergyVelocity | 0.10 |
| EnergyAcceleration | 0.05 |
| WhaleImpact_adj | 0.08 |
| OIConfirm | 0.08 |
| HedgePressure | 0.07 |
| GEXSignal | 0.07 |
| SkewSignal | 0.05 |
| TermSignal | 0.03 |
| IVRankSignal | 0.02 |
| StockConfirm | 0.08 |

Penalty weights:

| Penalty | Weight |
|---|---:|
| WallPressure | 0.10 |
| CloseDecay | 0.10 |
| MomentumDivergence | 0.08 |
| FlowDecay | 0.05 |

Boost weight:

| Boost | Weight |
|---|---:|
| BreakoutBoost | 0.06 |
