import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cacheHitPercent,
  contextUsagePercent,
  deriveSessionMetrics,
  formatContextTokens,
  formatTurnTokens,
} from "../src/services/sessionMetrics.ts";

// Session-level context wins; per-turn usage comes from the newest exchange.
const metrics = deriveSessionMetrics({
  model: "claude-sonnet-5",
  effort: "high",
  context_window: { totalTokens: 120_000, modelContextWindow: 200_000 },
  exchanges: [
    {
      token_usage: { inputTokens: 1, outputTokens: 2 },
      context_window: { totalTokens: 10, modelContextWindow: 200_000 },
    },
    {
      model_display_name: "Claude Sonnet 5",
      token_usage: {
        inputTokens: 12_000,
        outputTokens: 3_456,
        cacheReadTokens: 6_000,
      },
    },
  ],
});
assert.deepEqual(metrics?.contextWindow, {
  totalTokens: 120_000,
  modelContextWindow: 200_000,
});
assert.deepEqual(metrics?.tokenUsage, {
  inputTokens: 12_000,
  outputTokens: 3_456,
  cacheReadTokens: 6_000,
});
assert.equal(metrics?.model, "claude-sonnet-5");
assert.equal(metrics?.effort, "high");

// Without session metadata, fall back to the latest exchange that has values.
const fallback = deriveSessionMetrics({
  exchanges: [
    { model: "old-model", effort: "low" },
    {
      model_display_name: "Newest Model",
      effort: "medium",
      context_window: { totalTokens: 50_000, modelContextWindow: 100_000 },
      token_usage: { inputTokens: 900, outputTokens: 100 },
    },
  ],
});
assert.deepEqual(fallback?.contextWindow, {
  totalTokens: 50_000,
  modelContextWindow: 100_000,
});
assert.equal(fallback?.tokenUsage?.inputTokens, 900);
assert.equal(fallback?.model, "Newest Model");
assert.equal(fallback?.effort, "medium");

assert.equal(deriveSessionMetrics(null), null);
assert.equal(deriveSessionMetrics({}), null);
assert.equal(
  deriveSessionMetrics({
    context_window: { totalTokens: 0, modelContextWindow: 200_000 },
    exchanges: [{ token_usage: { inputTokens: 0, outputTokens: 0 } }],
  }),
  null,
);

assert.equal(
  contextUsagePercent({ totalTokens: 120_000, modelContextWindow: 200_000 }),
  60,
);
assert.equal(
  contextUsagePercent({ totalTokens: 999_999, modelContextWindow: 200_000 }),
  100,
);
// Until the first turn reports its result only used tokens are known; keep
// them so the badge can render a count without a percentage.
const pendingWindow = deriveSessionMetrics({
  context_window: { totalTokens: 12_345, modelContextWindow: 0 },
});
assert.deepEqual(pendingWindow?.contextWindow, {
  totalTokens: 12_345,
  modelContextWindow: 0,
});
assert.equal(
  contextUsagePercent({
    totalTokens: 12_345,
    modelContextWindow: 0,
  }),
  null,
);
assert.equal(contextUsagePercent(undefined), null);
assert.equal(cacheHitPercent({ inputTokens: 12_000, outputTokens: 1, cacheReadTokens: 6_000 }), 50);
assert.equal(cacheHitPercent({ inputTokens: 12_000, outputTokens: 1 }), null);
assert.equal(cacheHitPercent(undefined), null);
assert.equal(formatContextTokens(120_000), "120K");
assert.equal(formatContextTokens(2_000_000), "2M");
assert.equal(formatTurnTokens(12_345), "12.3k");
assert.equal(formatTurnTokens(1_234_567), "1.23m");
assert.equal(formatTurnTokens(42), "42");

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
assert.match(
  app,
  /const actionBarSessionMetrics = useMemo\(\s*\(\) =>\s*deriveSessionMetrics\(/,
  "the footer should derive live metrics from the selected session",
);
assert.match(
  app,
  /sessionStatusBadge=\{[\s\S]*?<SessionStatusBadge[\s\S]*?metrics=\{actionBarSessionMetrics\}/,
  "the composer should receive the persistent session status badge",
);

const actionBar = readFileSync(
  new URL("../src/components/ActionBar.tsx", import.meta.url),
  "utf8",
);
assert.match(
  actionBar,
  /sessionStatusBadge\?: React\.ReactNode;/,
  "ActionBar should accept the pinned session status badge",
);
assert.match(
  actionBar,
  /\{sessionStatusBadge\}\s*<AgentMemoryIndicator/,
  "the context badge should stay in the persistent footer indicator row",
);

for (const locale of ["zh-CN", "en-US"]) {
  const source = readFileSync(
    new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url),
    "utf8",
  );
  assert.match(source, /"sessionStatus\.context":/);
  assert.match(source, /"sessionStatus\.contextTitle":/);
  assert.match(source, /"sessionStatus\.contextUsed":/);
  assert.match(source, /"sessionStatus\.contextUsedTitle":/);
  assert.match(source, /"sessionStatus\.tokenTitle":/);
}

const statusBadge = readFileSync(
  new URL("../src/components/SessionStatusBadge.tsx", import.meta.url),
  "utf8",
);
assert.match(
  statusBadge,
  /sessionStatus\.contextUsed/,
  "the footer should fall back to a used-token count when the model window is unknown",
);

console.log("session status badge guard passed");
