const CLOSE_LANGUAGE = /止盈|止损|平仓|清仓|清掉|清了|走掉|走完|跑光|跑完|出掉|卖出|获利了结|出场|盈利自控|翻倍|double|take\s*profit|stop\s*loss|sell\s*to\s*close/i;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function channelSemantics(config, channelKey) {
  return config.channelSemantics?.[channelKey] ?? null;
}

// Channel convention: a percentage attached to an exit is the fraction of the
// currently remaining position to close.  盈利自控 closes half of what remains
// each time it appears.  Final-close language deliberately returns null so the
// workflow completion path consumes the entire remainder.
export function sourceExitFraction(record, luna) {
  if (luna?.lifecycle_action !== "sell_to_close") return null;
  const rawText = String(record.rawText ?? record.raw_text ?? "");
  if (/清掉|清空|清倉|清仓|走完|走光|跑光|跑完|全部.*(?:走|出|清)|all\s*out/i.test(rawText)) return null;
  if (/盈利自控/i.test(rawText)) return 0.5;
  if (/(?:减仓|減倉|卖出|賣出|平(?:仓|倉)|出掉)\s*一半|一半\s*(?:仓位|倉位|持仓|持倉)/i.test(rawText)) return 0.5;
  const explicitPercent = rawText.match(
    /(?:止盈|止损|停损|减仓|減倉|卖出|賣出|平(?:仓|倉)|出掉)\s*(\d+(?:\.\d+)?)\s*%/i
  );
  const rawPercent = Number(explicitPercent?.[1]);
  if (Number.isFinite(rawPercent) && rawPercent > 0 && rawPercent < 100) return rawPercent / 100;

  // Trust a structured size only when the raw message explicitly describes a
  // position/holding percentage.
  if (!/(?:仓位|倉位|持仓|持倉|减仓|減倉|卖出|賣出)/i.test(rawText)) return null;
  const structured = luna?.contract?.size;
  const structuredValue = Number(structured?.value ?? structured?.quantity);
  const structuredUnit = String(structured?.unit ?? structured?.units ?? "").toLowerCase();
  if (Number.isFinite(structuredValue) && /percent|%/.test(structuredUnit)
      && structuredValue > 0 && structuredValue < 100) return structuredValue / 100;
  return null;
}

// This is a disclosed source convention, not a model guess.  The original
// Luna response remains immutable in the analysis history; this function only
// creates the policy-normalized version consumed by research/backtests.
export function applySourceSemantics(config, record, luna, deterministicHint = null) {
  const semantics = channelSemantics(config, record.channelKey);
  if (!semantics || !luna || typeof luna !== "object") return luna;
  if (luna.source_semantics?.schema_version === "channel-semantics.v3" && luna.source_semantics.channel_key === record.channelKey &&
      luna.source_semantics.entry_action === semantics.entryAction && luna.source_semantics.exit_action === semantics.exitAction &&
      luna.source_semantics.entry_at_price_meaning === (semantics.entryAtPriceMeaning ?? null) &&
      luna.source_semantics.missing_expiry_policy === (semantics.missingExpiryPolicy ?? null) &&
      luna.source_semantics.profit_control_policy === (semantics.profitControlPolicy ?? null)) return luna;
  const output = clone(luna);
  const applied = {
    schema_version: "channel-semantics.v3",
    channel_key: record.channelKey,
    entry_action: semantics.entryAction,
    exit_action: semantics.exitAction,
    entry_at_price_meaning: semantics.entryAtPriceMeaning ?? null,
    missing_expiry_policy: semantics.missingExpiryPolicy ?? null,
    profit_control_policy: semantics.profitControlPolicy ?? null,
    rule: semantics.rule,
    applied_fields: []
  };
  // The local detector is deliberately high precision and runs before any AI
  // queue.  Preserve its explicit option lifecycle decision if a transient
  // model response overlooks terse channel language such as “清掉@0.94”.
  if (deterministicHint?.explicit === true) {
    output.classification = deterministicHint.classification;
    applied.applied_fields.push(`classification=${deterministicHint.classification}:deterministic_hint`);
    const hintedContract = deterministicHint.contract ?? null;
    if (hintedContract) {
      output.contract = {
        ...(output.contract ?? {}),
        ...Object.fromEntries(Object.entries(hintedContract).filter(([, value]) => value != null))
      };
      applied.applied_fields.push("contract=deterministic_hint");
    }
    if (deterministicHint.action === "sell_to_close") {
      output.lifecycle_action = "sell_to_close";
      output.lifecycle = {
        ...(output.lifecycle ?? {}),
        kind: deterministicHint.action_kind ?? output.lifecycle?.kind ?? "exit",
        reference_exit_price: deterministicHint.reference_exit_price ?? output.lifecycle?.reference_exit_price ?? null,
        execution_state: deterministicHint.execution_state ?? output.lifecycle?.execution_state ?? null
      };
      applied.applied_fields.push("lifecycle_action=sell_to_close:deterministic_hint");
    }
  }
  if (output.classification === "options_signal" && semantics.entryAction === "buy_to_open") {
    output.contract = { ...(output.contract ?? {}), side: "buy", open_action: "buy_to_open" };
    applied.applied_fields.push("contract.side=buy", "contract.open_action=buy_to_open");
    const rawText = String(record.rawText ?? record.raw_text ?? "");
    const atPrice = Number(rawText.match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/)?.[1]);
    if (semantics.entryAtPriceMeaning === "source_reported_fill" && Number.isFinite(atPrice) && atPrice > 0) {
      const prior = output.contract.entry_price;
      output.contract.entry_price = typeof prior === "object" && prior !== null
        ? { ...prior, value: atPrice, kind: "source_reported_fill", raw: prior.raw ?? `@${atPrice}` }
        : { value: atPrice, kind: "source_reported_fill", raw: `@${atPrice}` };
      output.contract.entry_execution_state = "claimed_fill";
      applied.applied_fields.push("contract.entry_price.kind=source_reported_fill", "contract.entry_execution_state=claimed_fill");
    }
    if (!output.contract.expiry && semantics.missingExpiryPolicy === "nearest_listed_expiry") {
      output.contract.expiry_resolution = { policy: "nearest_listed_expiry", resolved_expiry: null, source: "channel_semantics" };
      applied.applied_fields.push("contract.expiry_resolution.policy=nearest_listed_expiry");
    }
  }
  const rawText = String(record.rawText ?? record.raw_text ?? "");
  const profitControl = /盈利自控/i.test(rawText)
    && (record.replyToMessageId != null || record.reply_to_message_id != null || rawText.trim().length <= 40);
  if (profitControl && semantics.profitControlPolicy === "half_remaining_each_signal") {
    output.classification = "outcome";
    output.lifecycle = {
      ...(output.lifecycle ?? {}),
      kind: "profit_control",
      execution_state: "partial_exit",
      exit_fraction_of_remaining: 0.5
    };
    applied.applied_fields.push("classification=outcome", "lifecycle.kind=profit_control", "lifecycle.execution_state=partial_exit", "lifecycle.exit_fraction_of_remaining=0.5");
  }
  const contextualClose = CLOSE_LANGUAGE.test(rawText)
    && output.classification !== "non_signal"
    && (record.replyToMessageId != null || record.reply_to_message_id != null || rawText.trim().length <= 40);
  if ((output.classification === "outcome" || contextualClose) && semantics.exitAction === "sell_to_close") {
    output.lifecycle_action = "sell_to_close";
    applied.applied_fields.push("lifecycle_action=sell_to_close");
    const atExitPrice = Number(rawText.match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/)?.[1]);
    if (semantics.entryAtPriceMeaning === "source_reported_fill"
      && Number.isFinite(atExitPrice) && atExitPrice > 0) {
      output.lifecycle = {
        ...(output.lifecycle ?? {}),
        reference_exit_price: atExitPrice,
        execution_state: "claimed_fill"
      };
      applied.applied_fields.push(
        "lifecycle.reference_exit_price=source_reported_fill",
        "lifecycle.execution_state=claimed_fill"
      );
    }
  }
  if (output.classification === "update" && deterministicHint?.action_kind === "add") {
    const rawAverage = Number(rawText.match(/(?:成本价|成本價|均价|均價)\s*@?\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1]);
    const averageCost = Number.isFinite(deterministicHint.average_cost) && deterministicHint.average_cost > 0
      ? deterministicHint.average_cost : rawAverage;
    output.lifecycle_action = "buy_to_open";
    output.lifecycle = {
      ...(output.lifecycle ?? {}),
      kind: "add",
      average_cost: Number.isFinite(averageCost) && averageCost > 0 ? averageCost : null,
      execution_state: "reported_position_update"
    };
    applied.applied_fields.push("lifecycle_action=buy_to_open:update", "lifecycle.kind=add", "lifecycle.average_cost=latest_reported_position_cost");
  }
  output.source_semantics = applied;
  return output;
}

export function applyTerraSourceSemantics(config, record, luna, terra, marketSnapshot) {
  const semantics = channelSemantics(config, record.channelKey ?? record.channel_key);
  if (!semantics || semantics.entryAtPriceMeaning !== "source_reported_fill" || !terra || typeof terra !== "object") {
    return terra;
  }
  const rawText = String(record.rawText ?? record.raw_text ?? "");
  const atPrice = Number(rawText.match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/)?.[1]);
  const entry = luna?.classification === "options_signal" && luna?.contract?.open_action === "buy_to_open";
  const exit = luna?.lifecycle_action === "sell_to_close";
  if (!Number.isFinite(atPrice) || atPrice <= 0 || (!entry && !exit) || /盈利自控/i.test(rawText)) return terra;

  const output = clone(terra);
  const matched = marketSnapshot?.target_contract?.matched ?? null;
  output.execution_semantics = {
    schema_version: "source-execution-semantics.v1",
    action: entry ? "buy_to_open" : "sell_to_close",
    source_reported_fill: true,
    source_reported_price: atPrice,
    accepted_as_executable: true,
    independent_broker_verification: "not_established_by_delayed_snapshot",
    delayed_quote_cannot_invalidate_source_fill: true,
    broker_quote: matched ? {
      bid: matched.bid ?? null,
      ask: matched.ask ?? null,
      quote_timestamp: matched.quote_timestamp ?? null
    } : null
  };
  if (exit) {
    output.contract_analysis = output.contract_analysis ?? {};
    output.contract_analysis.observed_facts = {
      ...(output.contract_analysis.observed_facts ?? {}),
      reference_exit_price: atPrice,
      execution_state: "claimed_fill"
    };
    output.contract_analysis.inference = {
      ...(output.contract_analysis.inference ?? {}),
      source_exit_price_verification: "accepted_source_reported_fill",
      reference_price_vs_quote: "Source-reported fill accepted; delayed broker quote retained only as an independent cross-check."
    };
    if (Array.isArray(output.inference?.unverified_alternatives)) {
      output.inference.unverified_alternatives = output.inference.unverified_alternatives.filter((item) =>
        !/desired limit|stated price could be.*limit|whether any sale occurred/i.test(String(item))
      );
    }
    if (Array.isArray(output.risk?.inference?.principal_risks)) {
      output.risk.inference.principal_risks = output.risk.inference.principal_risks.filter((item) =>
        !/stated .*exit.*(?:not executable|not a verified fill)/i.test(String(item))
      );
    }
  }
  output.confidence = { ...(output.confidence ?? {}), source_fill_recognition: 1 };
  output.provenance = {
    ...(output.provenance ?? {}),
    source_execution_policy: "operator_provided_source_reported_fill"
  };
  return output;
}
