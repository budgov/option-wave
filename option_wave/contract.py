"""Contract-level overlays for an Ocean Wave underlying forecast.

The executable-contract score in :func:`assess_contract` is intentionally
small and backwards compatible.  The value overlay added here is a separate,
shadow-only diagnostic.  It never changes the Ocean Wave direction, factor
weights, or online calibration state.

Option vendors do not use one universal convention for IV and Greeks.  The
value overlay therefore refuses to calculate unless the caller explicitly
supplies the supported unit schema.  Returning an unavailable diagnostic is
safer than silently treating, for example, vega-per-volatility-point as
vega-per-unit-decimal-IV.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import exp, isfinite
from typing import Any, Mapping


STANDARD_EQUITY_OPTION_UNIT_ASSUMPTIONS: dict[str, str] = {
    "underlying_price": "usd_per_share",
    "option_quote": "usd_per_option_share",
    "delta": "option_usd_per_underlying_usd",
    "gamma": "delta_per_underlying_usd",
    "theta": "option_usd_per_trading_day",
    "vega": "option_usd_per_iv_percentage_point",
    "iv": "decimal",
    "forecast_expected_return": "decimal_simple_return",
    "forecast_return_variance": "decimal_return_squared",
    "iv_stress": "decimal_iv_change",
    "fees": "usd_per_contract_round_trip",
    "contract_multiplier": "option_shares_per_contract",
}

_DEFAULT_IV_STRESS_DECIMAL: dict[str, float] = {
    "base": 0.0,
    "bull": 0.02,
    "bear": -0.02,
}


@dataclass(frozen=True)
class ContractValueScenario:
    """One IV scenario, in option-premium USD per option share."""

    iv_change_decimal: float
    delta_component: float
    gamma_component: float
    theta_component: float
    vega_component: float
    expected_option_change: float
    round_trip_spread_cost: float
    round_trip_fee_per_share: float
    net_edge_after_spread: float


@dataclass(frozen=True)
class ContractValueOverlay:
    """Auditable, shadow-only delta/gamma/theta/vega value diagnostic."""

    schema_version: str
    deployment_status: str
    status: str
    decision: str
    horizon_minutes: float | None
    expected_underlying_return: float | None
    underlying_return_variance: float | None
    underlying_price: float | None
    current_iv_decimal: float | None
    data_completeness: float
    unit_assumptions: Mapping[str, str]
    formula: str
    net_edge_after_spread: float | None
    base_iv_stress: ContractValueScenario | None
    bull_iv_stress: ContractValueScenario | None
    bear_iv_stress: ContractValueScenario | None
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class ContractAssessment:
    option_type: str | None
    option_exposure: int | None
    directional_alignment: float | None
    spread_ratio: float | None
    theta_burn_ratio: float | None
    data_quality: float
    contract_score: float | None
    decision: str
    reasons: tuple[str, ...]
    value_overlay: ContractValueOverlay | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _contract_number(contract: Mapping[str, Any], *names: str) -> float | None:
    for name in names:
        if name in contract:
            return _number(contract.get(name))
    return None


def _expectation_for_horizon(
    result: Any,
    contract: Mapping[str, Any],
    horizon_minutes: float | None,
) -> tuple[float | None, Any | None]:
    expectations = getattr(result, "expectations", None)
    if not isinstance(expectations, Mapping) or not expectations:
        return None, None

    requested = _number(horizon_minutes)
    if requested is None:
        requested = _number(contract.get("horizon_minutes"))

    available: list[tuple[float, Any]] = []
    for raw_horizon, expectation in expectations.items():
        horizon = _number(raw_horizon)
        if horizon is not None and horizon > 0.0:
            available.append((horizon, expectation))
    if not available:
        return requested, None
    if requested is None:
        return max(available, key=lambda item: item[0])
    for available_horizon, expectation in available:
        if abs(available_horizon - requested) <= 1e-9:
            return available_horizon, expectation
    return requested, None


def _unit_schema(
    contract: Mapping[str, Any],
    supplied: Mapping[str, str] | None,
) -> tuple[dict[str, str], bool]:
    raw = supplied if supplied is not None else contract.get("unit_assumptions")
    if not isinstance(raw, Mapping):
        return {}, False
    normalized = {str(key): str(value) for key, value in raw.items()}
    valid = all(normalized.get(key) == value for key, value in STANDARD_EQUITY_OPTION_UNIT_ASSUMPTIONS.items())
    return normalized, valid


def _iv_stress_schema(
    contract: Mapping[str, Any],
    supplied: Mapping[str, Any] | None,
) -> dict[str, float] | None:
    raw = supplied if supplied is not None else contract.get("iv_stress_decimal")
    if raw is None:
        raw = _DEFAULT_IV_STRESS_DECIMAL
    if not isinstance(raw, Mapping):
        return None
    values = {name: _number(raw.get(name)) for name in ("base", "bull", "bear")}
    if any(value is None for value in values.values()):
        return None
    # These labels refer only to IV stress: bull is IV expansion and bear is IV
    # contraction.  They are deliberately not an underlying-price forecast.
    if values["bull"] < values["base"] or values["bear"] > values["base"]:
        return None
    return {name: float(value) for name, value in values.items() if value is not None}


def assess_contract_value(
    result: Any,
    contract: Mapping[str, Any] | None,
    *,
    exact_match: bool = True,
    horizon_minutes: float | None = None,
    unit_assumptions: Mapping[str, str] | None = None,
    iv_stress_decimal: Mapping[str, Any] | None = None,
    round_trip_fee_per_contract: float | None = None,
    contract_multiplier: float | None = None,
) -> ContractValueOverlay:
    """Estimate option-premium change without feeding it into the model.

    ``expected_return`` is a decimal simple return and ``return_variance`` is
    its dimensionless variance.  With premium quoted in USD per option share,
    the approximation is::

        E[dV] = delta*S*mu
              + 0.5*gamma*S**2*(variance + mu**2)
              + theta*(horizon_minutes/390)
              + vega*dIV

    For the supported vega convention, ``dIV`` is converted from decimal IV to
    percentage points before multiplication.  ``net_edge_after_spread`` uses a
    conservative round trip (buy at ask, sell at bid at the same spread), plus
    the explicitly supplied round-trip fee converted to a per-share amount.
    """

    contract = contract or {}
    reasons: list[str] = []
    checks: list[bool] = []

    def require(valid: bool, reason: str) -> bool:
        checks.append(bool(valid))
        if not valid and reason not in reasons:
            reasons.append(reason)
        return bool(valid)

    horizon, expectation = _expectation_for_horizon(result, contract, horizon_minutes)
    require(horizon is not None and horizon > 0.0, "missing_forecast_horizon")
    require(expectation is not None, "forecast_horizon_unavailable")

    expected_return = _number(getattr(expectation, "expected_return", None))
    return_variance = _number(getattr(expectation, "return_variance", None))
    require(expected_return is not None and expected_return > -1.0, "missing_or_invalid_expected_return")
    require(return_variance is not None and return_variance >= 0.0, "missing_or_invalid_return_variance")

    underlying_price = _contract_number(contract, "underlying_price", "spot")
    if underlying_price is None:
        underlying_price = _number(getattr(result, "spot", None))
    if underlying_price is None and expectation is not None and expected_return is not None and expected_return > -1.0:
        expected_price = _number(getattr(expectation, "expected_price", None))
        if expected_price is not None:
            underlying_price = expected_price / (1.0 + expected_return)
    require(underlying_price is not None and underlying_price > 0.0, "missing_or_invalid_underlying_price")

    bid = _number(contract.get("bid"))
    ask = _number(contract.get("ask"))
    require(
        bid is not None and ask is not None and bid >= 0.0 and ask > 0.0 and ask >= bid,
        "missing_or_invalid_executable_quote",
    )

    delta = _number(contract.get("delta"))
    gamma = _number(contract.get("gamma"))
    theta = _number(contract.get("theta"))
    vega = _number(contract.get("vega"))
    current_iv = _number(contract.get("iv"))
    require(delta is not None, "missing_delta")
    require(gamma is not None, "missing_gamma")
    require(theta is not None, "missing_theta")
    require(vega is not None, "missing_vega")
    require(current_iv is not None and current_iv >= 0.0, "missing_or_invalid_iv")

    units, units_valid = _unit_schema(contract, unit_assumptions)
    require(bool(units), "missing_unit_assumptions")
    require(units_valid, "unsupported_or_ambiguous_unit_assumptions")

    fee = _number(round_trip_fee_per_contract)
    if fee is None:
        fee = _number(contract.get("round_trip_fee_per_contract"))
    multiplier = _number(contract_multiplier)
    if multiplier is None:
        multiplier = _number(contract.get("contract_multiplier"))
    require(fee is not None and fee >= 0.0, "missing_or_invalid_round_trip_fee")
    require(multiplier is not None and multiplier > 0.0, "missing_or_invalid_contract_multiplier")

    stresses = _iv_stress_schema(contract, iv_stress_decimal)
    require(stresses is not None, "missing_or_invalid_iv_stress_scenarios")
    if stresses is not None and current_iv is not None:
        require(all(current_iv + change >= 0.0 for change in stresses.values()), "iv_stress_would_make_iv_negative")
    else:
        checks.append(False)

    require(bool(exact_match), "contract_not_exactly_matched")
    completeness = sum(checks) / len(checks) if checks else 0.0
    formula = (
        "E[dV]=Delta*S*mu+0.5*Gamma*S^2*(variance+mu^2)+"
        "Theta*(H/390)+Vega*dIV; net=E[dV]-(ask-bid)-round_trip_fee/multiplier"
    )

    if reasons:
        return ContractValueOverlay(
            schema_version="ocean-wave-contract-value-shadow.v1",
            deployment_status="shadow_only",
            status="unavailable",
            decision="abstain",
            horizon_minutes=horizon,
            expected_underlying_return=expected_return,
            underlying_return_variance=return_variance,
            underlying_price=underlying_price,
            current_iv_decimal=current_iv,
            data_completeness=completeness,
            unit_assumptions=units,
            formula=formula,
            net_edge_after_spread=None,
            base_iv_stress=None,
            bull_iv_stress=None,
            bear_iv_stress=None,
            reasons=tuple(reasons),
        )

    # The guards above make these values concrete.  Local aliases keep the
    # arithmetic readable without weakening validation or inventing defaults.
    assert horizon is not None
    assert expected_return is not None
    assert return_variance is not None
    assert underlying_price is not None
    assert bid is not None and ask is not None
    assert delta is not None and gamma is not None and theta is not None and vega is not None
    assert current_iv is not None and fee is not None and multiplier is not None and stresses is not None

    delta_component = delta * underlying_price * expected_return
    gamma_component = 0.5 * gamma * underlying_price * underlying_price * (
        return_variance + expected_return * expected_return
    )
    theta_component = theta * (horizon / 390.0)
    spread_cost = ask - bid
    fee_per_share = fee / multiplier

    def scenario(iv_change: float) -> ContractValueScenario:
        # Supported vega is premium USD per one IV percentage point; decimal IV
        # changes are therefore multiplied by 100 before applying vega.
        vega_component = vega * iv_change * 100.0
        gross_change = delta_component + gamma_component + theta_component + vega_component
        return ContractValueScenario(
            iv_change_decimal=iv_change,
            delta_component=delta_component,
            gamma_component=gamma_component,
            theta_component=theta_component,
            vega_component=vega_component,
            expected_option_change=gross_change,
            round_trip_spread_cost=spread_cost,
            round_trip_fee_per_share=fee_per_share,
            net_edge_after_spread=gross_change - spread_cost - fee_per_share,
        )

    base = scenario(stresses["base"])
    bull = scenario(stresses["bull"])
    bear = scenario(stresses["bear"])
    return ContractValueOverlay(
        schema_version="ocean-wave-contract-value-shadow.v1",
        deployment_status="shadow_only",
        status="available",
        decision="diagnostic_only",
        horizon_minutes=horizon,
        expected_underlying_return=expected_return,
        underlying_return_variance=return_variance,
        underlying_price=underlying_price,
        current_iv_decimal=current_iv,
        data_completeness=completeness,
        unit_assumptions=units,
        formula=formula,
        net_edge_after_spread=base.net_edge_after_spread,
        base_iv_stress=base,
        bull_iv_stress=bull,
        bear_iv_stress=bear,
        reasons=(),
    )


def assess_contract(
    result: Any,
    contract: Mapping[str, Any] | None,
    *,
    exact_match: bool = True,
    horizon_minutes: float | None = None,
    unit_assumptions: Mapping[str, str] | None = None,
    iv_stress_decimal: Mapping[str, Any] | None = None,
    round_trip_fee_per_contract: float | None = None,
    contract_multiplier: float | None = None,
) -> ContractAssessment:
    """Map the underlying forecast to the actual long option being considered.

    The continuous score penalizes wide spreads and high daily theta burn. It
    intentionally does not claim an executable edge or fit thresholds from an
    unverified Telegram outcome.
    """

    contract = contract or {}
    option_type = str(contract.get("option_type") or "").lower() or None
    exposure = 1 if option_type == "call" else -1 if option_type == "put" else None
    bid = _number(contract.get("bid"))
    ask = _number(contract.get("ask"))
    theta = _number(contract.get("theta"))
    trend = _number(getattr(result, "trend_score", None))
    confidence = _number(getattr(result, "confidence", None))
    reasons: list[str] = []
    value_overlay = assess_contract_value(
        result,
        contract,
        exact_match=exact_match,
        horizon_minutes=horizon_minutes,
        unit_assumptions=unit_assumptions,
        iv_stress_decimal=iv_stress_decimal,
        round_trip_fee_per_contract=round_trip_fee_per_contract,
        contract_multiplier=contract_multiplier,
    )

    midpoint = None if bid is None or ask is None else 0.5 * (bid + ask)
    spread_ratio = None if midpoint is None or midpoint <= 0.0 or ask < bid else (ask - bid) / midpoint
    theta_burn_ratio = None if theta is None or ask is None or ask <= 0.0 else abs(theta) / ask
    alignment = None if exposure is None or trend is None else exposure * trend

    if not exact_match:
        reasons.append("contract_not_exactly_matched")
    if exposure is None:
        reasons.append("unknown_option_type")
    if spread_ratio is None:
        reasons.append("missing_or_invalid_executable_quote")
    if theta_burn_ratio is None:
        reasons.append("missing_theta")
    if confidence is None:
        reasons.append("missing_model_confidence")

    if reasons:
        return ContractAssessment(option_type, exposure, alignment, spread_ratio, theta_burn_ratio, 0.0, None, "abstain", tuple(reasons), value_overlay)

    data_quality = max(0.0, min(1.0, confidence)) * exp(-spread_ratio) * exp(-theta_burn_ratio)
    contract_score = alignment * data_quality
    # A tiny signed score is not a tradable edge. In particular, same-day long
    # options can lose most of their premium to theta while the underlying
    # forecast remains nearly neutral. Keep collecting the outcome, but mark
    # the prediction as an abstention so it cannot train the online calibrator
    # as if it had been a confident call.
    minimum_contract_edge = 0.02
    theta_dominates = theta_burn_ratio >= 0.50 and abs(alignment) < 0.10
    low_quality = data_quality < 0.20
    if theta_dominates:
        decision = "abstain"
        reasons.append("theta_dominates_weak_directional_edge")
    elif low_quality:
        decision = "abstain"
        reasons.append("insufficient_contract_data_quality")
    elif contract_score >= minimum_contract_edge:
        decision = "support"
    elif contract_score <= -minimum_contract_edge:
        decision = "oppose"
    else:
        decision = "abstain"
        reasons.append("insufficient_contract_edge")
    if decision == "oppose":
        reasons.append("option_direction_conflicts_with_ocean_wave")
    return ContractAssessment(option_type, exposure, alignment, spread_ratio, theta_burn_ratio, data_quality, contract_score, decision, tuple(reasons), value_overlay)
