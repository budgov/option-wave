from __future__ import annotations

from dataclasses import dataclass, field
import numpy as np
import pandas as pd

from .elo import EloConfig, build_elo_surface, premium_sentiment_elo
from .factors import (
    MarketState,
    energy_signal,
    oi_confirm,
    hedge_pressure,
    stock_confirm,
    wall_pressure,
    close_decay,
    momentum_divergence,
    breakout_boost,
)

@dataclass
class ModelConfig:
    elo: EloConfig = field(default_factory=EloConfig)
    weights: dict[str, float] = field(default_factory=lambda: {
        "premium_elo": 0.25,
        "energy_signal": 0.15,
        "energy_velocity": 0.10,
        "energy_acceleration": 0.05,
        "whale_adj": 0.08,
        "oi_confirm": 0.08,
        "hedge_pressure": 0.07,
        "gex_signal": 0.07,
        "skew_signal": 0.05,
        "term_signal": 0.03,
        "ivrank_signal": 0.02,
        "stock_confirm": 0.08,
    })
    penalties: dict[str, float] = field(default_factory=lambda: {
        "wall_pressure": 0.10,
        "close_decay": 0.10,
        "momentum_divergence": 0.08,
        "flow_decay": 0.05,
    })
    boosts: dict[str, float] = field(default_factory=lambda: {
        "breakout_boost": 0.06,
    })

@dataclass
class ModelResult:
    trend_score: float
    direction: str
    confidence: float
    factors: dict[str, float]
    contributions: dict[str, float]
    penalties: dict[str, float]
    boosts: dict[str, float]
    elo_surface: pd.DataFrame

class OptionWaveV08:
    def __init__(self, config: ModelConfig | None = None) -> None:
        self.config = config or ModelConfig()
        self.prev_net_energy: float | None = None
        self.prev_velocity: float | None = None
        self.prev_spot: float | None = None

    def predict(
        self,
        chain: pd.DataFrame,
        state: MarketState,
        *,
        k_wall: float | None = None,
        whale_impact: float = 0.0,
        whale_confidence: float = 0.0,
        gex_signal: float = 0.0,
        skew_signal: float = 0.0,
        term_signal: float = 0.0,
        ivrank_signal: float = 0.0,
        flow_decay: float = 0.0,
    ) -> ModelResult:
        df = chain.copy()
        if "call_mid" not in df.columns:
            df["call_mid"] = (df.get("call_bid", 0) + df.get("call_ask", 0)) / 2
        if "put_mid" not in df.columns:
            df["put_mid"] = (df.get("put_bid", 0) + df.get("put_ask", 0)) / 2

        elo = build_elo_surface(df, state.spot, self.config.elo)
        premium = premium_sentiment_elo(elo, state.spot)
        e_sig = energy_signal(df)

        net_energy = float(e_sig)
        if self.prev_net_energy is None:
            velocity = 0.0
            acceleration = 0.0
        else:
            velocity = net_energy - self.prev_net_energy
            acceleration = 0.0 if self.prev_velocity is None else velocity - self.prev_velocity

        whale_adj = whale_impact * whale_confidence if whale_confidence >= 0.3 else 0.0
        oi = oi_confirm(df)
        hedge = hedge_pressure(df, state)
        stock = stock_confirm(state, self.prev_spot)

        factors = {
            "premium_elo": premium,
            "energy_signal": e_sig,
            "energy_velocity": velocity,
            "energy_acceleration": acceleration,
            "whale_adj": whale_adj,
            "oi_confirm": oi,
            "hedge_pressure": hedge,
            "gex_signal": gex_signal,
            "skew_signal": skew_signal,
            "term_signal": term_signal,
            "ivrank_signal": ivrank_signal,
            "stock_confirm": stock,
        }
        penalties = {
            "wall_pressure": wall_pressure(state, k_wall, e_sig),
            "close_decay": close_decay(state),
            "momentum_divergence": momentum_divergence(state, e_sig, self.prev_spot),
            "flow_decay": flow_decay,
        }
        boosts = {
            "breakout_boost": breakout_boost(state, k_wall, e_sig, self.prev_spot),
        }

        contributions = {k: self.config.weights.get(k, 0.0) * v for k, v in factors.items()}
        penalty_value = sum(self.config.penalties.get(k, 0.0) * v for k, v in penalties.items())
        boost_value = sum(self.config.boosts.get(k, 0.0) * v for k, v in boosts.items())
        raw = sum(contributions.values()) - penalty_value + boost_value
        trend = float(np.tanh(raw))
        direction = self._direction(trend)
        confidence = min(1.0, 0.5 + abs(trend) + 0.1 * min(len(chain) / 20, 1.0))

        self.prev_net_energy = net_energy
        self.prev_velocity = velocity
        self.prev_spot = state.spot

        return ModelResult(
            trend_score=trend,
            direction=direction,
            confidence=confidence,
            factors=factors,
            contributions=contributions,
            penalties=penalties,
            boosts=boosts,
            elo_surface=elo,
        )

    @staticmethod
    def _direction(score: float) -> str:
        if score >= 0.70:
            return "Strong Bullish"
        if score >= 0.30:
            return "Bullish"
        if score > 0.10:
            return "Mild Bullish"
        if score <= -0.70:
            return "Strong Bearish"
        if score <= -0.30:
            return "Bearish"
        if score < -0.10:
            return "Mild Bearish"
        return "Neutral"
