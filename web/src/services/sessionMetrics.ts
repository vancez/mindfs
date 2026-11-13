export type ContextWindowMetrics = {
  totalTokens: number;
  modelContextWindow: number;
};

export type SessionTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

type ExchangeMetricsSource = {
  model?: string;
  model_display_name?: string;
  effort?: string;
  context_window?: ContextWindowMetrics;
  token_usage?: SessionTokenUsage;
};

export type SessionMetricsSource = {
  model?: string;
  effort?: string;
  context_window?: ContextWindowMetrics;
  exchanges?: ExchangeMetricsSource[];
};

export type SessionMetrics = {
  contextWindow?: ContextWindowMetrics;
  tokenUsage?: SessionTokenUsage;
  model?: string;
  effort?: string;
};

function positiveNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeContextWindow(
  value: ContextWindowMetrics | undefined,
): ContextWindowMetrics | undefined {
  // The model's maximum window is only known after the first turn reports its
  // result. Keep used tokens on their own so the status badge can still show a
  // count (without a percentage) while that is pending.
  const totalTokens = positiveNumber(value?.totalTokens);
  if (!totalTokens) {
    return undefined;
  }
  return {
    totalTokens,
    modelContextWindow: positiveNumber(value?.modelContextWindow),
  };
}

function normalizeTokenUsage(
  value: SessionTokenUsage | undefined,
): SessionTokenUsage | undefined {
  if (!value) {
    return undefined;
  }
  const inputTokens = Math.max(0, Number(value.inputTokens) || 0);
  const outputTokens = Math.max(0, Number(value.outputTokens) || 0);
  if (!inputTokens && !outputTokens) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(value.cacheReadTokens)
      ? { cacheReadTokens: Math.max(0, Number(value.cacheReadTokens)) }
      : {}),
    ...(Number.isFinite(value.cacheWriteTokens)
      ? { cacheWriteTokens: Math.max(0, Number(value.cacheWriteTokens)) }
      : {}),
  };
}

// Prefer session-level metadata (kept current by live context updates and turn
// completion) and fall back to the newest exchange that carries per-turn
// metrics. Only the latest values are used: the status bar is a live
// indicator, not a history view.
export function deriveSessionMetrics(
  session: SessionMetricsSource | null | undefined,
): SessionMetrics | null {
  if (!session) {
    return null;
  }
  let contextWindow = normalizeContextWindow(session.context_window);
  let tokenUsage: SessionTokenUsage | undefined;
  let model = `${session.model || ""}`.trim();
  let effort = `${session.effort || ""}`.trim();

  const exchanges = Array.isArray(session.exchanges) ? session.exchanges : [];
  for (let index = exchanges.length - 1; index >= 0; index -= 1) {
    const exchange = exchanges[index];
    contextWindow ||= normalizeContextWindow(exchange?.context_window);
    tokenUsage ||= normalizeTokenUsage(exchange?.token_usage);
    if (!model) {
      model = `${exchange?.model_display_name || exchange?.model || ""}`.trim();
    }
    if (!effort) {
      effort = `${exchange?.effort || ""}`.trim();
    }
    if (contextWindow && tokenUsage && model && effort) {
      break;
    }
  }

  if (!contextWindow && !tokenUsage && !model) {
    return null;
  }
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function contextUsagePercent(
  contextWindow: ContextWindowMetrics | undefined,
): number | null {
  const used = positiveNumber(contextWindow?.totalTokens);
  const total = positiveNumber(contextWindow?.modelContextWindow);
  if (!used || !total) {
    return null;
  }
  return Math.round(Math.max(0, Math.min(1, used / total)) * 100);
}

export function cacheHitPercent(
  usage: SessionTokenUsage | undefined,
): number | null {
  if (!usage || !Number.isFinite(usage.cacheReadTokens)) {
    return null;
  }
  const input = Math.max(0, Number(usage.inputTokens) || 0);
  if (!input) {
    return null;
  }
  return Math.round(
    Math.min(1, Math.max(0, Number(usage.cacheReadTokens) || 0) / input) * 100,
  );
}

export function formatContextTokens(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  if (tokens >= 1_000_000) {
    return `${Math.round(tokens / 1_000_000)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(Math.round(tokens));
}

export function formatTurnTokens(value: number): string {
  const tokens = Math.max(0, Number(value) || 0);
  const compact = (amount: number, suffix: string) => {
    const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
    return `${Number(amount.toFixed(digits))}${suffix}`;
  };
  if (tokens >= 1_000_000) {
    return compact(tokens / 1_000_000, "m");
  }
  if (tokens >= 1_000) {
    return compact(tokens / 1_000, "k");
  }
  return String(Math.round(tokens));
}
