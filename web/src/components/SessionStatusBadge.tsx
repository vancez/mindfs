import React from "react";
import { useI18n } from "../i18n";
import {
  cacheHitPercent,
  contextUsagePercent,
  formatContextTokens,
  formatTurnTokens,
  type SessionMetrics,
} from "../services/sessionMetrics";

type SessionStatusBadgeProps = {
  metrics: SessionMetrics | null;
  compact?: boolean;
};

function contextTone(percent: number) {
  if (percent >= 90) {
    return {
      color: "#dc2626",
      background: "linear-gradient(rgba(220, 38, 38, 0.10), rgba(220, 38, 38, 0.10)), var(--mobile-overlay-bg)",
      border: "1px solid rgba(220, 38, 38, 0.28)",
    };
  }
  if (percent >= 75) {
    return {
      color: "#ea580c",
      background: "linear-gradient(rgba(234, 88, 12, 0.10), rgba(234, 88, 12, 0.10)), var(--mobile-overlay-bg)",
      border: "1px solid rgba(234, 88, 12, 0.26)",
    };
  }
  return {
    color: "#0f766e",
    background: "linear-gradient(rgba(15, 118, 110, 0.10), rgba(15, 118, 110, 0.10)), var(--mobile-overlay-bg)",
    border: "1px solid rgba(15, 118, 110, 0.24)",
  };
}

// Always-on session telemetry shown above the composer. The per-message footer
// is easy to scroll away, so the current context pressure and the latest turn's
// token usage stay pinned at the bottom while the conversation scrolls.
export function SessionStatusBadge({ metrics, compact = false }: SessionStatusBadgeProps) {
  const { t, formatNumber } = useI18n();
  const contextWindow = metrics?.contextWindow;
  const usage = metrics?.tokenUsage;
  const percent = contextUsagePercent(contextWindow);
  const cachePercent = cacheHitPercent(usage);
  const contextUsedTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  if (!contextWindow || percent === null) {
    const tokenBadge = usage ? (
      <TokenUsageBadge
        input={usage.inputTokens}
        output={usage.outputTokens}
        cachePercent={cachePercent}
        label={t("sessionStatus.tokenTitle", {
          input: formatNumber(usage.inputTokens),
          cache: cachePercent === null ? "—" : `${cachePercent}%`,
          output: formatNumber(usage.outputTokens),
        })}
        compact={compact}
      />
    ) : null;
    if (!contextUsedTokens) {
      return tokenBadge;
    }
    const used = formatContextTokens(contextUsedTokens);
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "flex-end",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: "5px",
          minWidth: 0,
        }}
      >
        <ContextUsedBadge
          text={compact ? used : t("sessionStatus.contextUsed", { used })}
          title={t("sessionStatus.contextUsedTitle", { used })}
        />
        {tokenBadge}
      </div>
    );
  }

  const tone = contextTone(percent);
  const modelLabel = [metrics?.model || "", metrics?.effort || ""]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" · ");
  const contextLabel = t("sessionStatus.contextTitle", {
    percent,
    used: formatContextTokens(contextWindow.totalTokens),
    total: formatContextTokens(contextWindow.modelContextWindow),
  });
  const title = modelLabel ? `${contextLabel} · ${modelLabel}` : contextLabel;

  return (
    <div
      data-mindfs-session-status="1"
      style={{
        display: "inline-flex",
        alignItems: "flex-end",
        justifyContent: "flex-end",
        flexWrap: "wrap",
        gap: "5px",
        minWidth: 0,
      }}
    >
      <span
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={title}
        title={title}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "5px",
          height: "20px",
          padding: "0 8px",
          borderRadius: "999px",
          ...tone,
          fontSize: "11px",
          fontWeight: 700,
          lineHeight: 1,
          whiteSpace: "nowrap",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {compact ? null : (
          <span
            aria-hidden="true"
            style={{
              width: "30px",
              height: "4px",
              borderRadius: "2px",
              background: "currentColor",
              opacity: 0.2,
              overflow: "hidden",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                display: "block",
                width: `${percent}%`,
                height: "100%",
                borderRadius: "2px",
                background: "currentColor",
              }}
            />
          </span>
        )}
        <span>
          {compact
            ? `${percent}%`
            : `${t("sessionStatus.context")} ${percent}%`}
        </span>
        <span style={{ fontWeight: 600, opacity: 0.72 }}>
          {`${formatContextTokens(contextWindow.totalTokens)}/${formatContextTokens(
            contextWindow.modelContextWindow,
          )}`}
        </span>
      </span>
      {usage ? (
        <TokenUsageBadge
          input={usage.inputTokens}
          output={usage.outputTokens}
          cachePercent={cachePercent}
          label={t("sessionStatus.tokenTitle", {
            input: formatNumber(usage.inputTokens),
            cache: cachePercent === null ? "—" : `${cachePercent}%`,
            output: formatNumber(usage.outputTokens),
          })}
          compact={compact}
        />
      ) : null}
    </div>
  );
}

function TokenUsageBadge({
  input,
  output,
  cachePercent,
  label,
  compact,
}: {
  input: number;
  output: number;
  cachePercent: number | null;
  label: string;
  compact: boolean;
}) {
  return (
    <span
      title={label}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        height: "20px",
        padding: "0 8px",
        borderRadius: "999px",
        border: "1px solid var(--border-color)",
        background: "linear-gradient(rgba(100, 116, 139, 0.08), rgba(100, 116, 139, 0.08)), var(--mobile-overlay-bg)",
        color: "var(--text-secondary)",
        fontSize: "11px",
        fontWeight: 650,
        lineHeight: 1,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>{formatTurnTokens(input)}</span>
      {cachePercent !== null ? (
        <span style={{ opacity: 0.75 }}>{`(${compact ? "" : "♻"}${cachePercent}%)`}</span>
      ) : null}
      <span style={{ opacity: 0.55 }}>→</span>
      <span>{formatTurnTokens(output)}</span>
    </span>
  );
}

// Shown when used tokens are known but the model's maximum window is not yet
// reported (the first turn has not produced its result). Deliberately neutral:
// no percentage or progress bar, so it cannot imply a low usage level.
function ContextUsedBadge({ text, title }: { text: string; title: string }) {
  return (
    <span
      data-mindfs-context-used="1"
      role="status"
      aria-label={title}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: "20px",
        padding: "0 8px",
        borderRadius: "999px",
        border: "1px solid var(--border-color)",
        background: "linear-gradient(rgba(100, 116, 139, 0.08), rgba(100, 116, 139, 0.08)), var(--mobile-overlay-bg)",
        color: "var(--text-secondary)",
        fontSize: "11px",
        fontWeight: 650,
        lineHeight: 1,
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {text}
    </span>
  );
}
