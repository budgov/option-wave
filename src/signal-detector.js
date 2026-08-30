const EXIT_LANGUAGE = /止盈|止损|停损|平仓|清仓|清掉|清了|全部走掉|全走掉|走完|跑光|跑完|全部出掉|全出掉|卖出|賣出|获利了结|獲利了結|离场|離場|出场|出場|盈利自控|翻倍|落袋|take\s*profit|stop\s*loss|sell\s*to\s*close|\bSTC\b/i;
const ADD_LANGUAGE = /加仓|加倉|补仓|補倉|追加|新的?均价|新的?均價|average\s*down|add(?:ed|ing)?\s+(?:to\s+)?(?:the\s+)?position/i;
const CANCEL_LANGUAGE = /取消|撤销|撤銷|不要进|不要進|作废|作廢|cancel(?:led|ed)?/i;
const HOLD_LANGUAGE = /过夜|過夜|继续持有|繼續持有|留仓|留倉|hold\s+overnight/i;
const ENTRY_LANGUAGE = /\bbuy\b|买入|買入|建仓|建倉|开仓|開倉|进场|進場|\bBTO\b/i;
const OPTION_TYPE = /\b(CALL|PUT)S?\b/i;
const RESERVED_SYMBOLS = new Set(["BUY", "CALL", "PUT", "BTO", "STC", "AT", "MARKET"]);
const MAX_FAST_SIGNAL_LENGTH = 180;

function normalize(text) {
  return String(text ?? "").normalize("NFKC").replace(/[，；]/g, " ").replace(/\s+/g, " ").trim();
}

// These channels sometimes discuss multi-week option-writing ideas inside
// research prose. They are archived as secondary context, never opened as
// intraday option workflows. A deterministic, fully specified concise signal
// remains eligible.
export function isResearchOnlyOptionCommentary(record, hint = null) {
  if (hint?.explicit === true) return false;
  const text = normalize(record?.rawText ?? record?.raw_text);
  const proseOptionWriting = /\bsell\s+puts?\b|\bSP\s*@/i.test(text);
  const longOptionDiscussion = text.length > 80
    && /\b(?:call|put|options?|SP)\b|期权|期權/i.test(text);
  return proseOptionWriting || longOptionDiscussion;
}

function isoExpiry(text, publishedAt) {
  const match = text.match(/(?:^|\s)(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(\d{2,4}))?(?=\s|$|@)/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const asOf = new Date(publishedAt);
  let year = match[3] ? Number(match[3]) : asOf.getUTCFullYear();
  if (year < 100) year += 2000;
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  if (!match[3] && candidate.getTime() < asOf.getTime() - 183 * 86400_000) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate.toISOString().slice(0, 10);
}

function optionSymbol(text, typeMatch) {
  const before = text.slice(0, typeMatch.index);
  const tokens = before.match(/\$?[A-Za-z]{1,6}\b/g) ?? [];
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const symbol = tokens[index].replace(/^\$/, "").toUpperCase();
    if (!RESERVED_SYMBOLS.has(symbol)) return symbol;
  }
  const tagged = text.match(/\$?([A-Za-z]{1,6})(?=\s*@)/);
  return tagged && !RESERVED_SYMBOLS.has(tagged[1].toUpperCase()) ? tagged[1].toUpperCase() : null;
}

function optionStrike(text, typeMatch) {
  const after = text.slice(typeMatch.index + typeMatch[0].length);
  const afterMatch = after.match(/^\s*\$?([0-9]+(?:\.[0-9]+)?)(?=\s|@|$)/);
  if (afterMatch) return Number(afterMatch[1]);
  const before = text.slice(0, typeMatch.index)
    .replace(/\d{1,2}\s*[\/-]\s*\d{1,2}(?:\s*[\/-]\s*\d{2,4})?/g, " ");
  const numbers = [...before.matchAll(/\$?([0-9]+(?:\.[0-9]+)?)/g)];
  return numbers.length ? Number(numbers.at(-1)[1]) : null;
}

function contractFromText(text, publishedAt) {
  const typeMatch = OPTION_TYPE.exec(text);
  if (!typeMatch) return null;
  const symbol = optionSymbol(text, typeMatch);
  const strike = optionStrike(text, typeMatch);
  const expiry = isoExpiry(text, publishedAt);
  const price = text.match(/@\s*(?:\$\s*)?([0-9]+(?:\.[0-9]+)?|市价|市價|market)/i);
  return {
    symbol,
    expiry,
    strike,
    option_type: typeMatch[1].toLowerCase(),
    entry_price: price && /^\d/.test(price[1]) ? Number(price[1]) : null,
    entry_price_raw: price?.[1] ?? null,
    price_kind: price && /市价|市價|market/i.test(price[1]) ? "market" : price ? "source_reported_fill" : null,
    entry_execution_state: price ? "claimed_fill" : null,
    expiry_resolution: expiry
      ? { policy: "explicit", resolved_expiry: expiry }
      : { policy: "nearest_listed_expiry", resolved_expiry: null }
  };
}

function referencedSymbol(text) {
  const candidates = [...text.matchAll(/\$?([A-Z]{1,6})(?=@|\b)/g)]
    .map((match) => match[1])
    .filter((symbol) => !RESERVED_SYMBOLS.has(symbol));
  return candidates.at(-1) ?? null;
}

export function detectSignalHint(record) {
  const text = normalize(record?.rawText ?? record?.raw_text);
  const replyToMessageId = record?.replyToMessageId ?? record?.reply_to_message_id ?? null;
  // The deterministic layer is deliberately high precision. Long commentary
  // often mentions option types, strikes, stops, or adding to positions without
  // issuing an order. Luna can still inspect it asynchronously, but it must not
  // produce an immediate trading alert or a fabricated contract here.
  const concise = text.length <= MAX_FAST_SIGNAL_LENGTH;
  const contract = concise
    ? contractFromText(text, record?.publishedAt ?? record?.published_at ?? new Date().toISOString())
    : null;

  const directExit = /^(?:(?:已|可以|全部|部分)\s*)?(?:止盈|止损|停损|平仓|清仓|清掉|清了|全部走掉|全走掉|走完|跑光|跑完|全部出掉|全出掉|卖出|賣出|离场|離場|出场|出場|盈利自控|翻倍)|^[0-9]+(?:\.[0-9]+)?\s*(?:止盈|止损|停损)|^(?:take\s*profit|stop\s*loss|sell\s*to\s*close|STC)\b/i.test(text);
  const exitIsContextual = replyToMessageId != null || directExit;
  if (concise && EXIT_LANGUAGE.test(text) && exitIsContextual) {
    const price = text.match(/@\s*\$?([0-9]+(?:\.[0-9]+)?)/)
      ?? text.match(/(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s*(?=止盈|止损|停损)/);
    const exitKind = /止损|停损|stop\s*loss/i.test(text)
      ? "stop_loss" : /盈利自控/i.test(text) ? "profit_control"
        : /止盈|翻倍|take\s*profit/i.test(text) ? "take_profit" : "exit";
    return {
      schema_version: "signal-hint.v2",
      classification: "outcome",
      explicit: true,
      action: "sell_to_close",
      action_kind: exitKind,
      contract: contract ?? { symbol: referencedSymbol(text) },
      reference_exit_price: price ? Number(price[1]) : null,
      execution_state: /盈利自控/i.test(text) ? "source_reported_fill_candidate"
        : price ? "claimed_fill"
        : /(?:已|止损了|止盈了|卖了|賣了|出了|平了|清掉|清了|走掉|走完|跑光|跑完|出掉|closed|sold)/i.test(text) ? "claimed_fill" : "instruction",
      reply_to_message_id: replyToMessageId,
      evidence: text,
      missing_fields: price ? [] : ["exit_price"]
    };
  }
  if (concise && CANCEL_LANGUAGE.test(text) && (replyToMessageId != null || CANCEL_LANGUAGE.test(text.slice(0, 24)))) {
    return {
      schema_version: "signal-hint.v2",
      classification: "cancel",
      explicit: true,
      action: null,
      contract,
      reply_to_message_id: replyToMessageId,
      evidence: text
    };
  }
  const directAdd = /^(?:(?:继续|再|已|已经|現在|现在)\s*)?(?:加仓|加倉|补仓|補倉|追加)|^(?:新的?均价|新的?均價|average\s*down|add(?:ed|ing)?\b)/i.test(text);
  if (concise && ADD_LANGUAGE.test(text) && (replyToMessageId != null || directAdd || contract?.symbol)) {
    return {
      schema_version: "signal-hint.v2",
      classification: "update",
      explicit: true,
      action: "buy_to_open",
      action_kind: "add",
      contract,
      average_cost: Number(text.match(/(?:成本价|成本價|均价|均價)\s*@?\s*([0-9]+(?:\.[0-9]+)?)/)?.[1] ?? NaN) || null,
      reply_to_message_id: replyToMessageId,
      evidence: text
    };
  }
  const sufficientlySpecified = Boolean(contract?.symbol && contract?.strike != null);
  if (concise && sufficientlySpecified && (contract.expiry || contract.entry_price_raw || ENTRY_LANGUAGE.test(text))) {
    return {
      schema_version: "signal-hint.v2",
      classification: "options_signal",
      explicit: true,
      action: "buy_to_open",
      action_kind: "entry",
      contract,
      reply_to_message_id: replyToMessageId,
      evidence: text,
      missing_fields: [
        ...(!contract.expiry ? ["expiry"] : []),
        ...(contract.entry_price_raw == null ? ["entry_price"] : [])
      ]
    };
  }
  if (replyToMessageId != null && HOLD_LANGUAGE.test(text)) {
    return {
      schema_version: "signal-hint.v2",
      classification: "update",
      explicit: false,
      action: null,
      contract: null,
      reply_to_message_id: replyToMessageId,
      evidence: text
    };
  }
  const hasMedia = Boolean(record?.raw?.has_media || record?.raw?.media_id || record?.raw?.grouped_id);
  const standaloneMarketClue = OPTION_TYPE.test(text) || /@\s*\$?\d|\b(?:BTO|STC)\b/i.test(text);
  const needsHumanInterpretation = concise && (
    hasMedia
    || standaloneMarketClue
    || (replyToMessageId != null && text.length <= 80)
  );
  const contextSymbol = referencedSymbol(text);
  return {
    schema_version: "signal-hint.v2",
    classification: "non_signal",
    explicit: false,
    action: null,
    contract: needsHumanInterpretation && contextSymbol ? { symbol: contextSymbol } : null,
    reply_to_message_id: replyToMessageId,
    evidence: text,
    needs_human_interpretation: needsHumanInterpretation,
    uncertainty_reason: needsHumanInterpretation
      ? hasMedia ? "unclassified_media" : replyToMessageId != null ? "unclassified_reply" : "unclassified_market_language"
      : null
  };
}
