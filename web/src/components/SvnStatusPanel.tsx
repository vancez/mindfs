import React from "react";
import { useI18n } from "../i18n";
import type { SvnStatusItem, SvnStatusPayload } from "../services/svn";

type SvnStatusPanelProps = {
  stateKey?: string;
  status: SvnStatusPayload | null;
  loading?: boolean;
  error?: string | null;
  onSelectItem?: (item: SvnStatusItem) => void;
  onUpdate?: () => void | Promise<void>;
  onCommit?: (message: string, paths: string[]) => void | Promise<void>;
  onRevert?: (item: SvnStatusItem) => void | Promise<void>;
  onResolve?: (item: SvnStatusItem) => void | Promise<void>;
  onRefresh?: () => void | Promise<unknown>;
  actionBusy?: "" | "update" | "commit" | "revert" | "resolve";
  actionError?: string | null;
  actionOutput?: string | null;
  onDismissAction?: () => void;
};

type PersistedPanelState = {
  selectedPaths: Set<string>;
  commitMessage: string;
  commitOpen: boolean;
};

// The panel is unmounted whenever the user changes project-tree tabs or
// collapses the root. Keep the commit selection/draft per root so that
// switching to Files and back does not discard an in-progress commit.
const panelStateCache = new Map<string, PersistedPanelState>();

const statusColors: Record<string, { color: string; background: string }> = {
  M: { color: "#b45309", background: "rgba(245, 158, 11, 0.12)" },
  A: { color: "#15803d", background: "rgba(34, 197, 94, 0.12)" },
  "??": { color: "#15803d", background: "rgba(34, 197, 94, 0.12)" },
  D: { color: "#b91c1c", background: "rgba(239, 68, 68, 0.12)" },
  "!": { color: "#b91c1c", background: "rgba(239, 68, 68, 0.12)" },
  R: { color: "#7c3aed", background: "rgba(124, 58, 237, 0.12)" },
  C: { color: "#dc2626", background: "rgba(220, 38, 38, 0.14)" },
  "~": { color: "#c2410c", background: "rgba(249, 115, 22, 0.13)" },
};

function displayStatus(status: string): string {
  return status === "??" ? "U" : status;
}

const actionButtonStyle: React.CSSProperties = {
  border: "1px solid var(--border-color)",
  borderRadius: "6px",
  background: "transparent",
  color: "var(--text-secondary)",
  padding: "2px 8px",
  fontSize: "11px",
  lineHeight: "16px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function statusStyle(status: string) {
  return statusColors[status] || {
    color: "var(--text-secondary)",
    background: "rgba(148, 163, 184, 0.14)",
  };
}

export function SvnStatusPanel({
  stateKey = "",
  status,
  loading = false,
  error = null,
  onSelectItem,
  onUpdate,
  onCommit,
  onRevert,
  onResolve,
  onRefresh,
  actionBusy = "",
  actionError = null,
  actionOutput = null,
  onDismissAction,
}: SvnStatusPanelProps) {
  const { t } = useI18n();
  const persisted = stateKey ? panelStateCache.get(stateKey) : undefined;
  const [commitOpen, setCommitOpen] = React.useState(persisted?.commitOpen ?? false);
  const [commitMessage, setCommitMessage] = React.useState(persisted?.commitMessage ?? "");
  const [selectedPaths, setSelectedPaths] = React.useState<Set<string>>(
    () => new Set(persisted?.selectedPaths ?? []),
  );
  React.useEffect(() => {
    if (!stateKey) {
      return;
    }
    panelStateCache.set(stateKey, { selectedPaths, commitMessage, commitOpen });
  }, [commitOpen, commitMessage, selectedPaths, stateKey]);
  const selectablePaths = React.useMemo(
    () =>
      (status?.items || [])
        .filter(
          (item) => item.status !== "C" && item.status !== "~",
        )
        .map((item) => item.path),
    [status],
  );
  const selectablePathSet = React.useMemo(
    () => new Set(selectablePaths),
    [selectablePaths],
  );

  React.useEffect(() => {
    // The panel remounts before the first status request finishes; do not
    // discard a restored selection just because the item list is not here yet.
    if (!status?.available) {
      return;
    }
    setSelectedPaths((prev) => {
      if (prev.size === 0) {
        return prev;
      }
      const next = new Set<string>();
      for (const path of prev) {
        if (selectablePathSet.has(path)) {
          next.add(path);
        }
      }
      return next.size === prev.size ? prev : next;
    });
  }, [selectablePathSet, status?.available]);

  const allSelected =
    selectablePaths.length > 0 &&
    selectablePaths.every((path) => selectedPaths.has(path));
  const commitDisabled =
    !!actionBusy ||
    selectablePaths.length === 0 ||
    selectedPaths.size === 0;

  const toggleSelected = (path: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedPaths(allSelected ? new Set() : new Set(selectablePaths));
  };

  const submitCommit = async () => {
    const message = commitMessage.trim();
    const paths = Array.from(selectedPaths).sort();
    if (!message || !onCommit || actionBusy || paths.length === 0) {
      return;
    }
    try {
      await onCommit(message, paths);
      setCommitMessage("");
      setCommitOpen(false);
    } catch {
      // The parent keeps the error and the draft for retry.
    }
  };

  const runUpdate = async () => {
    if (!onUpdate || actionBusy) {
      return;
    }
    try {
      await onUpdate();
    } catch {
      // The parent keeps the error for display.
    }
  };

  const runRevert = async (item: SvnStatusItem) => {
    if (!onRevert || actionBusy) {
      return;
    }
    try {
      await onRevert(item);
    } catch {
      // The parent keeps the error for display.
    }
  };

  const runResolve = async (item: SvnStatusItem) => {
    if (!onResolve || actionBusy) {
      return;
    }
    try {
      await onResolve(item);
    } catch {
      // The parent keeps the error for display.
    }
  };

  if (loading && !status) {
    return (
      <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
        {t("svn.loadingStatus")}
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ padding: "8px 4px", fontSize: "12px", color: "#b91c1c", wordBreak: "break-word" }}>
        <div>
          {t("svn.loadFailed")}
          {error ? `: ${error}` : ""}
        </div>
        {onRefresh ? (
          <button
            type="button"
            onClick={() => void onRefresh()}
            style={{ ...actionButtonStyle, marginTop: "6px" }}
          >
            {t("common.retry")}
          </button>
        ) : null}
      </div>
    );
  }
  if (!status) {
    return null;
  }
  if (!status.available) {
    return (
      <div style={{ padding: "8px 4px", fontSize: "12px", color: "var(--text-secondary)" }}>
        {t("svn.notWorkingCopy")}
      </div>
    );
  }

  const revision = String(status.revision || "").trim();
  const showRevision = /^\d+$/.test(revision) && revision !== "0";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2px", padding: "4px 2px", minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          padding: "2px 6px 4px",
          fontSize: "11px",
          color: "var(--text-secondary)",
          minWidth: 0,
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: "0.02em" }}>SVN</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          {showRevision ? <span>{t("svn.revision", { revision })}</span> : null}
          <span>{t("svn.dirtyCount", { count: status.dirty_count })}</span>
          {loading ? <span style={{ opacity: 0.6 }}>{t("svn.refreshing")}</span> : null}
        </span>
      </div>

      {onUpdate || onCommit ? (
        <div style={{ display: "flex", alignItems: "center", gap: "4px", padding: "0 6px 4px", minWidth: 0 }}>
          {onUpdate ? (
            <button
              type="button"
              disabled={!!actionBusy}
              onClick={() => void runUpdate()}
              style={{
                ...actionButtonStyle,
                cursor: actionBusy ? "not-allowed" : "pointer",
                opacity: actionBusy ? 0.55 : 1,
              }}
            >
              {actionBusy === "update" ? t("svn.updating") : t("svn.update")}
            </button>
          ) : null}
          {onCommit ? (
            <button
              type="button"
              disabled={commitDisabled && !commitOpen}
              onClick={() => setCommitOpen((open) => !open)}
              style={{
                ...actionButtonStyle,
                cursor: commitDisabled && !commitOpen ? "not-allowed" : "pointer",
                opacity: commitDisabled && !commitOpen ? 0.55 : 1,
              }}
            >
              {actionBusy === "commit" ? t("svn.committing") : t("svn.commit")}
            </button>
          ) : null}
          {onCommit && selectablePaths.length > 0 ? (
            <button
              type="button"
              disabled={!!actionBusy}
              onClick={toggleAll}
              style={{
                ...actionButtonStyle,
                cursor: actionBusy ? "not-allowed" : "pointer",
                opacity: actionBusy ? 0.55 : 1,
              }}
            >
              {allSelected ? t("svn.clearSelection") : t("svn.selectAll")}
            </button>
          ) : null}
          {onCommit && selectablePaths.length > 0 ? (
            <span style={{ marginLeft: "auto", fontSize: "10px", color: "var(--text-secondary)", flexShrink: 0 }}>
              {t("svn.selectedCount", { count: selectedPaths.size })}
            </span>
          ) : null}
        </div>
      ) : null}

      {commitOpen && onCommit ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", padding: "0 6px 6px", minWidth: 0 }}>
          <div style={{ fontSize: "10px", color: "var(--text-secondary)" }}>
            {t("svn.selectedCount", { count: selectedPaths.size })}
          </div>
          <textarea
            value={commitMessage}
            disabled={actionBusy === "commit"}
            autoFocus
            rows={3}
            aria-label={t("svn.commitMessagePlaceholder")}
            placeholder={t("svn.commitMessagePlaceholder")}
            onChange={(event) => setCommitMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setCommitOpen(false);
                return;
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                if (event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                void submitCommit();
              }
            }}
            style={{
              width: "100%",
              boxSizing: "border-box",
              minHeight: "54px",
              resize: "vertical",
              border: "1px solid var(--border-color)",
              borderRadius: "7px",
              background: "transparent",
              color: "var(--text-primary)",
              padding: "6px 8px",
              fontFamily: "inherit",
              fontSize: "12px",
              lineHeight: 1.45,
              outline: "none",
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "4px" }}>
            <button
              type="button"
              disabled={actionBusy === "commit"}
              onClick={() => setCommitOpen(false)}
              style={actionButtonStyle}
            >
              {t("svn.cancel")}
            </button>
            <button
              type="button"
              disabled={
                !commitMessage.trim() ||
                selectedPaths.size === 0 ||
                !!actionBusy
              }
              onClick={() => void submitCommit()}
              style={{
                ...actionButtonStyle,
                border: "none",
                background: "var(--accent-color)",
                color: "#fff",
                fontWeight: 600,
                opacity:
                  !commitMessage.trim() ||
                  selectedPaths.size === 0 ||
                  !!actionBusy
                    ? 0.55
                    : 1,
                cursor:
                  !commitMessage.trim() ||
                  selectedPaths.size === 0 ||
                  !!actionBusy
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {actionBusy === "commit"
                ? t("svn.committing")
                : t("svn.commitSelected", { count: selectedPaths.size })}
            </button>
          </div>
        </div>
      ) : null}

      {actionError || actionOutput ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "3px",
            margin: "0 6px 4px",
            minWidth: 0,
          }}
        >
          {onDismissAction ? (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                onClick={onDismissAction}
                style={{
                  ...actionButtonStyle,
                  padding: "1px 7px",
                  fontSize: "10px",
                }}
              >
                {t("common.close")}
              </button>
            </div>
          ) : null}
          {actionError ? (
            <div style={{ fontSize: "11px", color: "#b91c1c", wordBreak: "break-word" }}>
              {actionError}
            </div>
          ) : null}
          {actionOutput ? (
            <pre
              style={{
                margin: 0,
                padding: "4px 6px",
                maxHeight: "110px",
                overflow: "auto",
                borderRadius: "6px",
                background: "rgba(148, 163, 184, 0.10)",
                color: "var(--text-secondary)",
                fontSize: "11px",
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {actionOutput}
            </pre>
          ) : null}
        </div>
      ) : null}

      {status.items.length === 0 ? (
        <div style={{ padding: "8px 6px", fontSize: "12px", color: "var(--text-secondary)" }}>
          {t("svn.emptyChanges")}
        </div>
      ) : (
        status.items.map((item) => {
          const style = statusStyle(item.status);
          // Directory content is not expanded by `svn status`; only a
          // property-only (M) directory has a useful depth-empty diff.
          const clickable = item.is_dir !== true || item.status === "M";
          const canRevert = !!onRevert && item.status !== "??";
          const canResolve = !!onResolve && (item.conflicted === true || item.status === "C");
          const selectable = item.status !== "C" && item.status !== "~";
          return (
            <div key={item.path} style={{ display: "flex", alignItems: "center", gap: "2px", minWidth: 0 }}>
              {selectable ? (
                <input
                  type="checkbox"
                  checked={selectedPaths.has(item.path)}
                  disabled={!!actionBusy}
                  onChange={() => toggleSelected(item.path)}
                  aria-label={t("svn.selectFile", { name: item.path })}
                  style={{
                    flexShrink: 0,
                    width: "13px",
                    height: "13px",
                    margin: 0,
                    accentColor: "var(--accent-color)",
                    cursor: actionBusy ? "not-allowed" : "pointer",
                  }}
                />
              ) : (
                <span aria-hidden="true" style={{ width: "13px", flexShrink: 0 }} />
              )}
              <button
                type="button"
                disabled={!clickable}
                title={item.path}
                onClick={() => {
                  if (clickable) onSelectItem?.(item);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "7px",
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  background: "transparent",
                  borderRadius: "6px",
                  padding: "4px 6px",
                  textAlign: "left",
                  cursor: clickable ? "pointer" : "default",
                  color: "var(--text-primary)",
                  fontSize: "12px",
                }}
                onMouseEnter={(event) => {
                  if (clickable) event.currentTarget.style.background = "rgba(0,0,0,0.04)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: "18px",
                  height: "16px",
                  borderRadius: "4px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "10px",
                  fontWeight: 700,
                  color: style.color,
                  background: style.background,
                }}
              >
                {displayStatus(item.status)}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: item.is_dir ? "var(--text-secondary)" : "inherit",
                }}
              >
                {item.old_path
                  ? `${item.old_path} → ${item.path}`
                  : item.path === "."
                    ? "/"
                    : item.is_dir
                      ? `${item.path}/`
                      : item.path}
              </span>
              {item.conflicted ? (
                <span style={{ flexShrink: 0, fontSize: "10px", fontWeight: 700, color: "#dc2626" }}>
                  {t("svn.conflicted")}
                </span>
              ) : null}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  flexShrink: 0,
                  fontSize: "11px",
                  color: "var(--text-secondary)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span style={{ color: "#15803d" }}>+{item.additions}</span>
                <span style={{ color: "#b91c1c" }}>-{item.deletions}</span>
              </span>
              </button>
              {canRevert ? (
                <button
                  type="button"
                  disabled={!!actionBusy}
                  title={t("svn.revertFile", { name: item.path })}
                  aria-label={t("svn.revertFile", { name: item.path })}
                  onClick={() => void runRevert(item)}
                  style={{
                    flexShrink: 0,
                    border: "none",
                    borderRadius: "5px",
                    background: "transparent",
                    color: "#b45309",
                    padding: "3px 4px",
                    fontSize: "10px",
                    lineHeight: "14px",
                    cursor: actionBusy ? "not-allowed" : "pointer",
                    opacity: actionBusy ? 0.5 : 0.85,
                  }}
                  onMouseEnter={(event) => {
                    if (!actionBusy) event.currentTarget.style.background = "rgba(245, 158, 11, 0.10)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                  }}
                >
                  {t("svn.revert")}
                </button>
              ) : null}
              {canResolve ? (
                <button
                  type="button"
                  disabled={!!actionBusy}
                  title={t("svn.resolveFile", { name: item.path })}
                  aria-label={t("svn.resolveFile", { name: item.path })}
                  onClick={() => void runResolve(item)}
                  style={{
                    flexShrink: 0,
                    border: "none",
                    borderRadius: "5px",
                    background: "transparent",
                    color: "#0f766e",
                    padding: "3px 4px",
                    fontSize: "10px",
                    lineHeight: "14px",
                    cursor: actionBusy ? "not-allowed" : "pointer",
                    opacity: actionBusy ? 0.5 : 0.85,
                  }}
                >
                  {actionBusy === "resolve" ? t("svn.resolving") : t("svn.resolve")}
                </button>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
