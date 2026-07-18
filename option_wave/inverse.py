"""Universal inverse-instrument links for Option Wave v0.9.

An inverse product is an observed companion instrument, not a synthetic
prediction.  The registry therefore stores only explicit relationships and
lets an API adapter or a caller add symbols that are available in its market.
This keeps the model usable for broad index ETFs and single-stock inverse
ETPs without guessing from ticker names or recent correlation.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Iterable, Mapping


@dataclass(frozen=True)
class InverseLink:
    """A daily target relationship from an inverse product to its target."""

    target: str
    inverse: str
    beta: float
    confidence: float = 1.0
    source: str = "explicit"

    def __post_init__(self) -> None:
        if not self.target or not self.inverse:
            raise ValueError("target and inverse symbols are required")
        if self.target.upper() == self.inverse.upper():
            raise ValueError("target and inverse symbols must differ")
        if self.beta >= 0.0:
            raise ValueError("inverse beta must be negative")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0 and 1")

    @property
    def target_symbol(self) -> str:
        return self.target.upper()

    @property
    def inverse_symbol(self) -> str:
        return self.inverse.upper()

    def map_signal(self, native_signal: float) -> float:
        """Map an inverse product's native direction back to the target."""

        if self.beta == 0.0:
            return 0.0
        sign = -1.0 if self.beta < 0.0 else 1.0
        return max(-1.0, min(1.0, sign * float(native_signal)))


# These are conservative, commonly used daily inverse products.  The
# registry is deliberately extensible because single-stock ETP availability
# changes and must be confirmed by the selected market-data API.
DEFAULT_INVERSE_LINKS: tuple[InverseLink, ...] = (
    InverseLink("SPY", "SH", -1.0, source="ProShares"),
    InverseLink("SPY", "SDS", -2.0, source="ProShares"),
    InverseLink("QQQ", "PSQ", -1.0, source="ProShares"),
    InverseLink("QQQ", "QID", -2.0, source="ProShares"),
    InverseLink("QQQ", "SQQQ", -3.0, source="ProShares"),
    InverseLink("DIA", "DOG", -1.0, source="ProShares"),
    InverseLink("IWM", "RWM", -1.0, source="ProShares"),
    InverseLink("TSLA", "TSLS", -1.0, source="Direxion"),
    InverseLink("AAPL", "AAPD", -1.0, source="Direxion"),
    InverseLink("AMD", "AMDD", -1.0, source="Direxion"),
    InverseLink("AMZN", "AMZD", -1.0, source="Direxion"),
    InverseLink("AVGO", "AVS", -1.0, source="Direxion"),
    InverseLink("CSCO", "CSCS", -1.0, source="Direxion"),
    InverseLink("GOOGL", "GGLS", -1.0, source="Direxion"),
    InverseLink("META", "METD", -1.0, source="Direxion"),
    InverseLink("MSFT", "MSFD", -1.0, source="Direxion"),
    InverseLink("MU", "MUD", -1.0, source="Direxion"),
    InverseLink("NFLX", "NFXS", -1.0, source="Direxion"),
    InverseLink("NVDA", "NVDD", -1.0, source="Direxion"),
    InverseLink("PANW", "PALD", -1.0, source="Direxion"),
    InverseLink("PLTR", "PLTD", -1.0, source="Direxion"),
    InverseLink("QCOM", "QCMD", -1.0, source="Direxion"),
    InverseLink("TSM", "TSMZ", -1.0, source="Direxion"),
)


class InverseRegistry:
    """Resolve all explicitly registered inverse products for a target.

    ``available_symbols`` is optional.  When supplied, it prevents requests
    for products that the current data vendor does not list.  Custom mappings
    can be loaded from JSON records with ``target``, ``inverse``, and ``beta``.
    """

    def __init__(self, links: Iterable[InverseLink] | None = None, *, include_defaults: bool = True) -> None:
        self._links: dict[tuple[str, str], InverseLink] = {}
        if include_defaults:
            for link in DEFAULT_INVERSE_LINKS:
                self.register(link)
        for link in links or ():
            self.register(link)

    def register(self, link: InverseLink | str, inverse: str | None = None, beta: float | None = None, **kwargs: object) -> InverseLink:
        """Add or replace one explicit target/inverse relationship."""

        if isinstance(link, InverseLink):
            value = link
        else:
            if inverse is None or beta is None:
                raise ValueError("inverse and beta are required when registering symbols")
            value = InverseLink(link, inverse, float(beta), **kwargs)
        key = (value.target_symbol, value.inverse_symbol)
        self._links[key] = value
        return value

    def resolve(
        self,
        target: str,
        *,
        available_symbols: Iterable[str] | None = None,
    ) -> tuple[InverseLink, ...]:
        """Return every known inverse product for ``target``.

        The returned order is stable and sorted by absolute beta, then ticker.
        It is safe for a caller to pass the full symbol universe returned by a
        reference API; unlisted inverse products are filtered out.
        """

        target_symbol = target.upper()
        available = None if available_symbols is None else {str(item).upper() for item in available_symbols}
        links = [link for link in self._links.values() if link.target_symbol == target_symbol]
        if available is not None:
            links = [link for link in links if link.inverse_symbol in available]
        return tuple(sorted(links, key=lambda item: (-abs(item.beta), item.inverse_symbol)))

    def all(self) -> tuple[InverseLink, ...]:
        return tuple(sorted(self._links.values(), key=lambda item: (item.target_symbol, item.inverse_symbol)))

    @classmethod
    def from_records(cls, records: Iterable[Mapping[str, object]], *, include_defaults: bool = True) -> "InverseRegistry":
        links = []
        for record in records:
            links.append(InverseLink(
                target=str(record["target"]),
                inverse=str(record["inverse"]),
                beta=float(record["beta"]),
                confidence=float(record.get("confidence", 1.0)),
                source=str(record.get("source", "explicit")),
            ))
        return cls(links, include_defaults=include_defaults)

    @classmethod
    def from_json(cls, path: str | Path, *, include_defaults: bool = True) -> "InverseRegistry":
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
        records = payload["links"] if isinstance(payload, Mapping) else payload
        return cls.from_records(records, include_defaults=include_defaults)


@dataclass(frozen=True)
class InverseMarketData:
    """One independently fetched inverse chain/state pair for the model."""

    symbol: str
    chain: object | None
    state: object | None
    beta: float
    confidence: float = 1.0
    source: str = "http"

    def __post_init__(self) -> None:
        if not self.symbol:
            raise ValueError("inverse market symbol is required")
        if self.beta >= 0.0:
            raise ValueError("inverse beta must be negative")
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError("confidence must be between 0 and 1")
