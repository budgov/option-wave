"""Backward-compatible import for the v0.9 market state.

The old independent factor scorer was removed.  Market state now belongs to
the continuous v0.9 model, but this shim avoids breaking existing notebooks.
"""

from .model import MarketState

__all__ = ["MarketState"]
