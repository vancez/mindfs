import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { defaultRangeExtractor, elementScroll, useVirtualizer } from "@tanstack/react-virtual";
import { useSessionStream, type TimelineItem } from "../hooks/useSessionStream";
import { sessionService, type TaskItem, type TaskListUpdate, type TodoUpdate } from "../services/session";
import { ThinkingBlock } from "./stream/ThinkingBlock";
import { ToolCallCard, renderToolIcon, type ToolCallViewCache } from "./stream/ToolCallCard";
import { AgentIcon } from "./AgentIcon";
import { InlineTokenText } from "./InlineTokenText";
import { MarkdownViewer } from "./MarkdownViewer";
import { fetchProofProtectedBlob } from "../services/file";
import type { ExchangeAux, RelatedFile, TokenUsage, ToolCall } from "../services/session";
import { savePrompt } from "../services/prompts";
import { reportError } from "../services/error";
import { copyText } from "../services/clipboard";
import type { AgentStatus } from "../services/agents";
import { useI18n, type Locale } from "../i18n";
import { formatSessionDuration } from "../services/sessionDuration";
import { DEFAULT_REPLY_INFO_PREFERENCES, useReplyInfoPreferences } from "../services/replyInfoPreferences";
import { ReplyInfoMenu } from "./ReplyInfoMenu";
import { ForkSessionButton } from "./ForkSessionButton";
import { SessionHeader, type SessionHeaderActions } from "./SessionHeader";

type SessionItem = {
  key?: string;
  session_key?: string;
  type?: string;
  name?: string;
  agent?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  search_seq?: number;
  scope?: string;
  purpose?: string;
  exchanges?: Array<{
    seq?: number;
    role?: string;
    agent?: string;
    model?: string;
    model_display_name?: string;
    effort?: string;
    fast_service?: string;
    content?: string;
    timestamp?: string;
    context_window?: {
      totalTokens: number;
      modelContextWindow: number;
    };
    token_usage?: TokenUsage;
  }>;
  closed_at?: string;
  source?: string;
  parent_session_key?: string;
  related_files?: RelatedFile[];
  exchange_aux?: Record<string, ExchangeAux[]>;
};

type SessionViewerProps = SessionHeaderActions & {
  session: SessionItem | null;
  loading?: boolean;
  slashCommandResult?: {
    sessionKey?: string;
    command: string;
    content: string;
    status: "running" | "complete" | "failed";
    error?: string;
    loginNotice?: {
      status?: string;
      loginId?: string;
      verificationUrl?: string;
      userCode?: string;
      error?: string;
      authMode?: string;
      planType?: string;
    };
  } | null;
  rootId?: string | null;
  rootPath?: string | null;
  interactionMode?: "main" | "drawer";
  targetSeq?: number;
  onFileClick?: (file: RelatedFile & { name?: string }) => void;
  onRootClick?: (rootId: string) => void;
  onRemoveRelatedFile?: (path: string, head?: string, repoPath?: string, repoKind?: string) => void;
  onAskUserAnswer?: (input: {
    rootId: string;
    sessionKey: string;
    agent?: string;
    toolUseId: string;
    answers: Record<string, string>;
  }) => boolean | void | Promise<boolean | void>;
  onEditUserMessage?: (content: string) => void;
  onForkAgentMessage?: (seq: number, independent: boolean) => void | Promise<void>;
  targetSeqRequestKey?: string | number;
  agents?: AgentStatus[];
  composerOverlayInset?: number;
};

type AskUserQuestionOption = {
  label?: string;
  description?: string;
};

type AskUserQuestionItem = {
  question?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
};

type AskUserQuestionDraft = {
  selected: string[];
  custom: string;
};

type UploadAttachment = {
  path: string;
  name: string;
  isImage: boolean;
};

function AttachmentImage({
  rootId,
  path,
  name,
}: {
  rootId: string;
  path: string;
  name: string;
}) {
  const [url, setURL] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectURL = "";
    async function run() {
      try {
        const blob = await fetchProofProtectedBlob({ rootId, path });
        if (cancelled) return;
        objectURL = URL.createObjectURL(blob);
        setURL(objectURL);
      } catch {
        if (!cancelled) {
          setURL("");
        }
      }
    }
    if (rootId && path) {
      void run();
    }
    return () => {
      cancelled = true;
      if (objectURL) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [rootId, path]);

  return (
    <img
      src={url}
      alt={name}
      style={{
        display: "block",
        width: "100%",
        maxHeight: "220px",
        objectFit: "cover",
        background: "rgba(15,23,42,0.06)",
      }}
    />
  );
}

const uploadTokenPattern = /\[(?:read file|file):\s*([^\]]+)\]/g;

function basename(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function extractUploadAttachments(content: string): UploadAttachment[] {
  const attachments: UploadAttachment[] = [];
  uploadTokenPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = uploadTokenPattern.exec(content || "")) !== null) {
    const path = match[1].trim();
    attachments.push({
      path,
      name: basename(path),
      isImage: isImagePath(path),
    });
  }
  return attachments;
}

function stripImageAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  const stripped = content.replace(
    uploadTokenPattern,
    (fullMatch, rawPath: string) => {
      const path = String(rawPath || "").trim();
      if (!isImagePath(path)) {
        return fullMatch;
      }
      return "";
    },
  );
  return stripped.replace(/\n{3,}/g, "\n\n").replace(/^[\n\s]+|[\n\s]+$/g, "");
}

function stripUploadAttachmentTokens(content: string): string {
  if (!content) {
    return "";
  }
  return content
    .replace(uploadTokenPattern, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\n\s]+|[\n\s]+$/g, "");
}

function formatContextWindowPercent(contextWindow?: {
  totalTokens: number;
  modelContextWindow: number;
}) {
  const usedTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  const modelContextWindow = Math.max(
    0,
    Number(contextWindow?.modelContextWindow || 0),
  );
  if (!usedTokens || !modelContextWindow) {
    return null;
  }
  const usedRatio = Math.max(0, Math.min(1, usedTokens / modelContextWindow));
  return {
    usedTokens,
    usedRatio,
    percent: Math.round(usedRatio * 100),
  };
}

function formatCompactTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}M`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`;
  }
  return String(Math.round(value));
}

function formatTurnTokenCount(value: number) {
  const tokens = Math.max(0, Number(value || 0));
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

function TurnTokenUsage({ usage, totalUsage }: { usage?: TokenUsage; totalUsage: TokenUsage }) {
  if (!usage) {
    return null;
  }
  const inputTokens = Math.max(0, Number(usage.inputTokens || 0));
  const outputTokens = Math.max(0, Number(usage.outputTokens || 0));
  if (!inputTokens && !outputTokens) {
    return null;
  }
  const cacheReadReported = Number.isFinite(usage.cacheReadTokens);
  const cacheReadTokens = Math.max(0, Number(usage.cacheReadTokens || 0));
  const hitPercent = inputTokens > 0 && cacheReadReported
    ? Math.round(Math.min(1, cacheReadTokens / inputTokens) * 100)
    : null;
  const cacheLabel = hitPercent === null ? "—" : `${hitPercent}%`;
  return (
    <span
      title={`${inputTokens}(♻${cacheLabel}·Σ${totalUsage.inputTokens})→${outputTokens}(Σ${totalUsage.outputTokens})`}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        minWidth: 0,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      <span>{formatTurnTokenCount(inputTokens)}</span>
      <span>
        {`(♻${cacheLabel}·Σ${formatTurnTokenCount(totalUsage.inputTokens)})`}
      </span>
      <span>→</span>
      <span>{formatTurnTokenCount(outputTokens)}</span>
      <span>{`(Σ${formatTurnTokenCount(totalUsage.outputTokens)})`}</span>
    </span>
  );
}

function modelDisplayName(
  agents: AgentStatus[] | undefined,
  agentName?: string,
  modelID?: string,
): string {
  const model = `${modelID || ""}`.trim();
  if (!model) {
    return "";
  }
  const agent = (agents || []).find(
    (item) => item.name === `${agentName || ""}`.trim(),
  );
  const match = (agent?.models || []).find((item) => item.id === model);
  return `${match?.name || ""}`.trim() || model;
}

function formatAssistantExchangeMeta(
  item: TimelineItem,
  agents?: AgentStatus[],
): string {
  if (item.type !== "assistant_text") {
    return "";
  }
  const parts = [
    `${item.modelDisplayName || ""}`.trim() ||
      modelDisplayName(agents, item.agent, item.model),
    item.effort,
  ]
    .map((value) => `${value || ""}`.trim())
    .filter(Boolean);
  if (`${item.fastService || ""}`.trim().toLowerCase() === "on") {
    parts.push("fast");
  }
  return parts.join("·").replace(/\s+/g, "");
}

function ContextWindowBadge({
  contextWindow,
}: {
  contextWindow?: { totalTokens: number; modelContextWindow: number };
}) {
  const metrics = formatContextWindowPercent(contextWindow);
  const usedTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  if (!metrics && !usedTokens) {
    return null;
  }
  const hue = !metrics
    ? "var(--text-secondary)"
    : metrics.percent >= 90
      ? "#dc2626"
      : metrics.percent >= 75
        ? "#ea580c"
        : "#0f766e";
  return (
    <span
      title={
        metrics
          ? `Context Window ${metrics.percent}% used (${metrics.usedTokens}/${contextWindow?.modelContextWindow} used)`
          : `Context used ${formatCompactTokenCount(usedTokens)} (model window not reported yet)`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
        minWidth: 0,
        color: hue,
        lineHeight: 1.1,
        fontSize: "10px",
        fontWeight: 700,
        letterSpacing: "0.01em",
        fontVariantNumeric: "tabular-nums",
        overflowWrap: "anywhere",
      }}
    >
      {metrics ? (
        <>
          <span>{metrics.percent}%</span>
          <span>&middot;used</span>
          <span>
            {`(${formatCompactTokenCount(metrics.usedTokens)}/${formatCompactTokenCount(
              contextWindow?.modelContextWindow || 0,
            )})`}
          </span>
        </>
      ) : (
        <span>{formatCompactTokenCount(usedTokens)}</span>
      )}
    </span>
  );
}

const formatTime = (isoString: string | undefined, locale: Locale) => {
  if (!isoString) return "";
  try {
    const date = new Date(isoString);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const isThisYear = date.getFullYear() === now.getFullYear();
    const timeStr = date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    if (isToday) return timeStr;
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    if (isThisYear) return `${month}-${day} ${timeStr}`;
    return `${date.getFullYear()}-${month}-${day} ${timeStr}`;
  } catch {
    return "";
  }
};

const formatToolCallFallbackResult = (toolCall: Partial<ToolCall>): string => {
  const kind = (toolCall.kind || "").toLowerCase();
  if (kind === "read") return "";
  const rawInput = toolCall.meta?.input;
  if (typeof rawInput === "string" && rawInput.trim() !== "") {
    const todoMarkdown = formatTodoToolCallInput(rawInput);
    if (todoMarkdown) return todoMarkdown;
    return rawInput;
  }
  const rawOutput = toolCall.meta?.output;
  if (typeof rawOutput === "string" && rawOutput.trim() !== "")
    return rawOutput;
  return "";
};

const formatTodoToolCallInput = (rawInput: string): string => {
  try {
    const parsed = JSON.parse(rawInput) as {
      todos?: Array<{
        content?: string;
        status?: string;
        activeForm?: string;
      }>;
    };
    if (!Array.isArray(parsed?.todos) || parsed.todos.length === 0) {
      return "";
    }
    const lines = parsed.todos
      .map((todo) => {
        const content = `${todo?.content || ""}`.trim();
        const activeForm = `${todo?.activeForm || ""}`.trim();
        const status = `${todo?.status || ""}`.trim().toLowerCase();
        if (status === "completed") {
          const label = content || activeForm;
          return label ? `- [x] ${label}` : "";
        }
        if (status === "in_progress") {
          const label = activeForm || content;
          return label ? `- [ ] ${label} _(in progress)_` : "";
        }
        const label = content || activeForm;
        return label ? `- [ ] ${label}` : "";
      })
      .filter(Boolean);
    return lines.join("\n");
  } catch {
    return "";
  }
};

function isAuxiliaryTimelineItem(item: TimelineItem | null): boolean {
  return (
    item?.type === "tool" ||
    item?.type === "thought" ||
    item?.type === "todo" ||
    item?.type === "tasks" ||
    item?.type === "plan" ||
    item?.type === "compact"
  );
}

function PlanUpdateCard({ content, rootId }: { content: string; rootId?: string | null }) {
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(59, 130, 246, 0.24)",
        background: "linear-gradient(180deg, rgba(59, 130, 246, 0.08), rgba(59, 130, 246, 0.03))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 8px",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        Plan
      </div>
      <div style={{ padding: "10px" }}>
        <MarkdownViewer content={content || ""} root={rootId || undefined} />
      </div>
    </div>
  );
}

function CompactNoticeCard({
  status,
  summary,
}: {
  status?: string;
  summary?: string;
}) {
  const normalizedStatus = `${status || ""}`.toLowerCase();
  const label =
    normalizedStatus === "running"
      ? "Compacting context"
      : normalizedStatus === "error"
        ? "Context compaction failed"
        : "Context compacted";
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(148, 163, 184, 0.28)",
        background: "rgba(148, 163, 184, 0.08)",
        padding: "10px",
        color: "var(--text-secondary)",
        fontSize: "13px",
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{label}</div>
      {summary ? <div style={{ marginTop: "6px" }}>{summary}</div> : null}
    </div>
  );
}

function TodoUpdateCard({ todoUpdate }: { todoUpdate: TodoUpdate }) {
  const items = Array.isArray(todoUpdate?.items) ? todoUpdate.items : [];
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(16, 185, 129, 0.22)",
        background:
          "linear-gradient(180deg, rgba(16, 185, 129, 0.08), rgba(16, 185, 129, 0.03))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 8px",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        ✅ todos
      </div>
      <div
        style={{
          padding: "10px",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        {items.map((item, index) => {
          const status = `${item?.status || ""}`.trim().toLowerCase();
          const content = `${item?.content || ""}`.trim();
          const activeForm = `${item?.activeForm || ""}`.trim();
          const label =
            status === "in_progress" && activeForm
              ? activeForm
              : content || activeForm;
          const checked = status === "completed";
          return (
            <div
              key={`${index}-${label}`}
              style={{
                fontSize: "13px",
                color: "var(--text-primary)",
                opacity: checked ? 0.78 : 1,
                textDecoration: checked ? "line-through" : "none",
              }}
            >
              {checked ? "☑" : "☐"} {label}
              {status === "in_progress" ? " (in progress)" : ""}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskListCard({ tasksUpdate }: { tasksUpdate: TaskListUpdate }) {
  const { t } = useI18n();
  const items = Array.isArray(tasksUpdate?.items) ? tasksUpdate.items : [];
  if (!items.length) {
    return null;
  }
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(14, 165, 233, 0.24)",
        background:
          "linear-gradient(180deg, rgba(14, 165, 233, 0.08), rgba(14, 165, 233, 0.03))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          padding: "6px 8px",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--text-primary)",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        {renderToolIcon("task")}
        {t("taskList.title")}
      </div>
      <div style={{ padding: "10px" }}>
        <TaskListRows items={items} />
      </div>
    </div>
  );
}

function TaskListRows({ items }: { items: TaskItem[] }) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      {items.map((item, index) => {
        const status = `${item?.status || ""}`.trim().toLowerCase();
        const completed = status === "complete" || status === "completed";
        const running =
          status === "running" ||
          status === "in_progress" ||
          status === "inprogress";
        const failed =
          status === "failed" ||
          status === "cancelled" ||
          status === "canceled";
        const subject = `${item?.subject || ""}`.trim();
        const activeForm = `${item?.activeForm || ""}`.trim();
        const label =
          running && activeForm
            ? activeForm
            : subject || activeForm || `#${item?.id || index + 1}`;
        return (
          <div
            key={`${item?.id || index}-${label}`}
            title={item?.description || undefined}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "6px",
              fontSize: "13px",
              lineHeight: 1.55,
              color: "var(--text-primary)",
              opacity: completed ? 0.75 : 1,
              textDecoration: completed ? "line-through" : "none",
            }}
          >
            <span
              style={{
                flexShrink: 0,
                width: "1em",
                textAlign: "center",
                color: failed
                  ? "#b91c1c"
                  : running
                    ? "#0369a1"
                    : completed
                      ? "#15803d"
                      : "var(--text-secondary)",
              }}
            >
              {completed ? "☑" : failed ? "✕" : running ? "◐" : "☐"}
            </span>
            <span style={{ minWidth: 0 }}>
              {label}
              {running ? (
                <span
                  style={{ color: "var(--text-secondary)", fontSize: "11px" }}
                >
                  {" "}
                  ({t("taskList.inProgress")})
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getAskUserQuestions(toolCall: Partial<ToolCall>): AskUserQuestionItem[] {
  const raw = toolCall.meta?.questions;
  if (Array.isArray(raw)) {
    return raw as AskUserQuestionItem[];
  }
  const input = toolCall.meta?.input;
  if (typeof input !== "string" || input.trim() === "") {
    return [];
  }
  try {
    const parsed = JSON.parse(input) as { questions?: AskUserQuestionItem[] };
    return Array.isArray(parsed.questions) ? parsed.questions : [];
  } catch {
    return [];
  }
}

function getAskUserAnswers(toolCall: Partial<ToolCall>): Record<string, string> {
  const raw = toolCall.meta?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const cleanKey = `${key || ""}`.trim();
    const cleanValue = `${value || ""}`.trim();
    if (cleanKey && cleanValue) {
      answers[cleanKey] = cleanValue;
    }
  }
  return answers;
}

function askUserQuestionOptionLabels(question?: AskUserQuestionItem): string[] {
  if (!Array.isArray(question?.options)) {
    return [];
  }
  return question.options
    .map((option) => `${option.label || ""}`.trim())
    .filter(Boolean);
}

// Answers travel as one comma-separated string per question. Entries matching an
// option label are selections; everything else is the custom answer text.
function parseAskUserAnswer(
  value: string,
  optionLabels: string[],
  multiSelect: boolean,
): AskUserQuestionDraft {
  const parts = `${value || ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (multiSelect) {
    return {
      selected: optionLabels.filter((label) => parts.includes(label)),
      custom: parts.filter((part) => !optionLabels.includes(part)).join(", "),
    };
  }
  const selected = parts.find((part) => optionLabels.includes(part));
  return {
    selected: selected ? [selected] : [],
    custom: parts.filter((part) => part !== selected).join(", "),
  };
}

function askUserAnswerFromDraft(
  draft: AskUserQuestionDraft,
  optionLabels: string[],
): string {
  const selected = optionLabels.filter((label) => draft.selected.includes(label));
  const custom = draft.custom.trim();
  return [...selected, custom].filter(Boolean).join(", ");
}

function askUserQuestionDrafts(
  questions: AskUserQuestionItem[],
  answers: Record<string, string>,
): Record<string, AskUserQuestionDraft> {
  const drafts: Record<string, AskUserQuestionDraft> = {};
  questions.forEach((question, index) => {
    drafts[`q_${index}`] = parseAskUserAnswer(
      answers[`q_${index}`] || "",
      askUserQuestionOptionLabels(question),
      question.multiSelect === true,
    );
  });
  return drafts;
}

function askUserQuestionTitle(question?: AskUserQuestionItem): string {
  const questionText = `${question?.question || ""}`.trim();
  const header = `${question?.header || ""}`.trim();
  if (header && questionText) {
    return `${header}：${questionText}`;
  }
  return questionText || header;
}

function AskUserIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: "#ef4444", flexShrink: 0 }}
    >
      <g fill="currentColor">
        <path d="M8 11a.75.75 0 1 1 0 1.5a.75.75 0 0 1 0-1.5m0-7c1.262 0 2.25.988 2.25 2.25c0 1.083-.566 1.648-1.021 2.104c-.408.407-.729.728-.729 1.396a.5.5 0 0 1-1 0c0-1.083.566-1.648 1.021-2.104c.408-.407.729-.728.729-1.396C9.25 5.538 8.712 5 8 5s-1.25.538-1.25 1.25a.5.5 0 0 1-1 0C5.75 4.988 6.738 4 8 4" />
        <path
          fillRule="evenodd"
          d="M8 1a7 7 0 0 1 6.999 7.001a7 7 0 0 1-10.504 6.06l-2.728.91a.582.582 0 0 1-.744-.714l.83-2.906A7 7 0 0 1 8 1m.001 1.001c-3.308 0-6 2.692-6 6c0 1.003.252 1.996.73 2.871l.196.36l-.726 2.54l1.978-.659l.428-.143l.39.226A6 6 0 0 0 8 14l.001.001c3.308 0 6-2.692 6-6s-2.692-6-6-6"
          clipRule="evenodd"
        />
      </g>
    </svg>
  );
}

function ForkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ transform: "rotate(180deg) scaleX(-1)" }}
    >
      <path d="M0 0h24v24H0z" fill="none" />
      <path
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        d="M17 7a2 2 0 1 0 0-4a2 2 0 0 0 0 4M7 7a2 2 0 1 0 0-4a2 2 0 0 0 0 4m0 14a2 2 0 1 0 0-4a2 2 0 0 0 0 4M7 7v10M17 7v1c0 2.5-2 3-2 3l-6 2s-2 .5-2 3v1"
      />
      <circle cx="17" cy="5" r="2" fill="currentColor" />
    </svg>
  );
}

// Ask-user cards are virtualized and can unmount while the server is still
// persisting an accepted answer. Keep submitted answers for the lifetime of
// the page so a remount does not reopen the form and invite a duplicate answer.
const submittedAskUserAnswers = new Map<string, Record<string, string>>();
const submittedAskUserAnswersLimit = 200;

function submittedAskUserAnswersFor(key: string): Record<string, string> | undefined {
  return key ? submittedAskUserAnswers.get(key) : undefined;
}

function rememberSubmittedAskUserAnswers(key: string, answers: Record<string, string>) {
  if (!key) {
    return;
  }
  submittedAskUserAnswers.set(key, { ...answers });
  if (submittedAskUserAnswers.size > submittedAskUserAnswersLimit) {
    const oldest = submittedAskUserAnswers.keys().next().value;
    if (oldest) {
      submittedAskUserAnswers.delete(oldest);
    }
  }
}

function AskUserQuestionCard({
  toolCall,
  rootId,
  sessionKey,
  agent,
  active,
  onAnswer,
}: {
  toolCall: ToolCall;
  rootId?: string | null;
  sessionKey?: string | null;
  agent?: string;
  active: boolean;
  onAnswer?: SessionViewerProps["onAskUserAnswer"];
}) {
  const { t } = useI18n();
  const questions = getAskUserQuestions(toolCall);
  const [focusedCustomAnswerKey, setFocusedCustomAnswerKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const status = `${toolCall.status || ""}`.toLowerCase();
  const isCurrent =
    status === "running" || status === "pending" || status === "in_progress";
  const [expanded, setExpanded] = useState(isCurrent);
  const toolUseId =
    toolCall.callId ||
    (typeof toolCall.meta?.toolUseId === "string" ? toolCall.meta.toolUseId : "");
  const persistedAnswers = getAskUserAnswers(toolCall);
  const persistedAnswersKey = JSON.stringify(persistedAnswers);
  const hasPersistedAnswers = Object.keys(persistedAnswers).length > 0;
  const answerStateKey =
    rootId && sessionKey && toolUseId
      ? `${rootId}::${sessionKey}::${toolUseId}`
      : "";
  const cachedAnswers = submittedAskUserAnswersFor(answerStateKey);
  const [drafts, setDrafts] = useState<Record<string, AskUserQuestionDraft>>(() =>
    askUserQuestionDrafts(questions, cachedAnswers || persistedAnswers),
  );
  const [submitted, setSubmitted] = useState(hasPersistedAnswers || !!cachedAnswers);
  const answerStateKeyRef = useRef(answerStateKey);
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const key = `q_${index}`;
    const value = askUserAnswerFromDraft(
      drafts[key] || { selected: [], custom: "" },
      askUserQuestionOptionLabels(question),
    ).trim();
    if (value) {
      answers[key] = value;
    }
  });
  const firstQuestionTitle = askUserQuestionTitle(questions[0]);
  const title =
    firstQuestionTitle ||
    `${toolCall.title || ""}`.trim() ||
    (typeof toolCall.meta?.title === "string" ? toolCall.meta.title : "") ||
    "ask user";
  const canSubmit =
    !!rootId &&
    !!sessionKey &&
    !!toolUseId &&
    !!onAnswer &&
    questions.length > 0 &&
    questions.every((_, index) => (answers[`q_${index}`] || "").trim() !== "") &&
    !submitting &&
    !submitted;

  useEffect(() => {
    const keyChanged = answerStateKeyRef.current !== answerStateKey;
    answerStateKeyRef.current = answerStateKey;
    if (hasPersistedAnswers) {
      rememberSubmittedAskUserAnswers(answerStateKey, persistedAnswers);
      setDrafts(askUserQuestionDrafts(questions, persistedAnswers));
      setSubmitted(true);
      setExpanded(false);
      return;
    }
    const cached = submittedAskUserAnswersFor(answerStateKey);
    if (cached) {
      setDrafts(askUserQuestionDrafts(questions, cached));
      setSubmitted(true);
      setExpanded(false);
      return;
    }
    if (keyChanged) {
      setDrafts({});
      setSubmitted(false);
      setSubmitError("");
    }
  }, [answerStateKey, persistedAnswersKey, hasPersistedAnswers]);

  useEffect(() => {
    if (submitted) {
      setExpanded(false);
      return;
    }
    setExpanded(active && isCurrent);
  }, [active, isCurrent, submitted, toolUseId]);

  const updateDraft = (
    index: number,
    update: (draft: AskUserQuestionDraft) => AskUserQuestionDraft,
  ) => {
    const key = `q_${index}`;
    setDrafts((prev) => ({
      ...prev,
      [key]: update(prev[key] || { selected: [], custom: "" }),
    }));
  };
  const toggleAnswer = (
    index: number,
    label: string,
    optionLabels: string[],
    multiSelect: boolean,
  ) => {
    updateDraft(index, (draft) => {
      const selected = optionLabels.filter((item) => draft.selected.includes(item));
      if (selected.includes(label)) {
        return { ...draft, selected: selected.filter((item) => item !== label) };
      }
      // Single-select options stay mutually exclusive; the custom text is kept.
      return { ...draft, selected: multiSelect ? [...selected, label] : [label] };
    });
  };
  const setCustomAnswer = (index: number, value: string) => {
    updateDraft(index, (draft) => ({ ...draft, custom: value }));
  };

  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        borderRadius: "10px",
        border: "1px solid rgba(239, 68, 68, 0.28)",
        background:
          "linear-gradient(180deg, rgba(239, 68, 68, 0.08), rgba(239, 68, 68, 0.03))",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          padding: "6px 8px",
          background: "rgba(239, 68, 68, 0.04)",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border-color)" : "none",
          cursor: "pointer",
          fontSize: "12px",
          gap: "6px",
          minWidth: 0,
        }}
        title={title}
      >
        <AskUserIcon />
        <span
          style={{
            minWidth: 0,
            flex: 1,
            fontWeight: 500,
            color: "var(--text-primary)",
            whiteSpace: expanded ? "normal" : "nowrap",
            overflow: expanded ? "visible" : "hidden",
            textOverflow: expanded ? "clip" : "ellipsis",
            textAlign: "left",
            overflowWrap: "anywhere",
            lineHeight: 1.35,
          }}
        >
          {title}
        </span>
        <span
          style={{
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 0.2s",
            color: "var(--text-secondary)",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      </button>
      {expanded ? (
        <div style={{ padding: "10px", display: "flex", flexDirection: "column", gap: "12px" }}>
          {questions.map((question, index) => {
            const key = `q_${index}`;
            const options = Array.isArray(question.options) ? question.options : [];
            const optionLabels = askUserQuestionOptionLabels(question);
            const draft = drafts[key] || { selected: [], custom: "" };
            const selectedSet = new Set(draft.selected);
            const customAnswer = draft.custom;
            const customAnswerActive =
              customAnswer.trim() !== "" || focusedCustomAnswerKey === key;
            const itemTitle = askUserQuestionTitle(question);
            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {itemTitle ? (
                  <div
                    style={{
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "var(--text-primary)",
                      lineHeight: 1.45,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {itemTitle}
                  </div>
                ) : null}
                {options.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {options.map((option) => {
                      const label = `${option.label || ""}`.trim();
                      if (!label) return null;
                      const checked = selectedSet.has(label);
                      return (
                        <label
                          key={label}
                          style={{
                            display: "flex",
                            gap: "8px",
                            alignItems: "flex-start",
                            padding: "7px 8px",
                            borderRadius: "8px",
                            border: checked
                              ? "1px solid rgba(239, 68, 68, 0.42)"
                              : "1px solid var(--border-color)",
                            background: checked ? "rgba(239, 68, 68, 0.10)" : "var(--content-bg)",
                            cursor: submitted ? "default" : "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            name={`${toolUseId}-${key}`}
                            checked={checked}
                            disabled={submitted}
                            onChange={() =>
                              toggleAnswer(
                                index,
                                label,
                                optionLabels,
                                question.multiSelect === true,
                              )
                            }
                            style={{ marginTop: "2px" }}
                          />
                          <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                            <span style={{ fontSize: "13px", color: "var(--text-primary)" }}>{label}</span>
                            {option.description ? (
                              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                                {option.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                    <textarea
                      value={customAnswer}
                      disabled={submitted}
                      onFocus={() => setFocusedCustomAnswerKey(key)}
                      onBlur={() => setFocusedCustomAnswerKey((current) => (current === key ? "" : current))}
                      onChange={(event) => setCustomAnswer(index, event.target.value)}
                      placeholder={t("session.askCustomAnswer")}
                      rows={2}
                      style={{
                        width: "100%",
                        resize: "vertical",
                        borderRadius: "8px",
                        border: customAnswerActive
                          ? "1px solid rgba(239, 68, 68, 0.42)"
                          : "1px solid var(--border-color)",
                        outline: "none",
                        background: "var(--content-bg)",
                        color: "var(--text-primary)",
                        padding: "8px",
                        fontSize: "13px",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                ) : (
                  <textarea
                    value={customAnswer}
                    disabled={submitted}
                    onChange={(event) => setCustomAnswer(index, event.target.value)}
                    placeholder={t("session.askAnswer")}
                    rows={3}
                    style={{
                      width: "100%",
                      resize: "vertical",
                      borderRadius: "8px",
                      border: "1px solid var(--border-color)",
                      background: "var(--content-bg)",
                      color: "var(--text-primary)",
                      padding: "8px",
                      fontSize: "13px",
                      boxSizing: "border-box",
                    }}
                  />
              )}
            </div>
          );
        })}
        <button
          type="button"
          disabled={!canSubmit}
          onClick={async () => {
            if (!canSubmit || !rootId || !sessionKey || !toolUseId || !onAnswer) return;
            setSubmitting(true);
            setSubmitError("");
            try {
              const accepted = await onAnswer({
                rootId,
                sessionKey,
                agent,
                toolUseId,
                answers,
              });
              if (accepted === false) {
                setSubmitError(t("session.askSubmitFailed"));
                return;
              }
              rememberSubmittedAskUserAnswers(answerStateKey, answers);
              setSubmitted(true);
              setExpanded(false);
            } catch (err) {
              setSubmitError(
                String((err as Error)?.message || "") || t("session.askSubmitFailed"),
              );
            } finally {
              setSubmitting(false);
            }
          }}
          style={{
            alignSelf: "flex-start",
            border: "none",
            borderRadius: "999px",
            padding: "6px 12px",
            background: canSubmit ? "#ef4444" : "var(--border-color)",
            color: canSubmit ? "#fff" : "var(--text-secondary)",
            fontSize: "12px",
            fontWeight: 700,
            cursor: canSubmit ? "pointer" : "default",
          }}
        >
          {submitted ? t("session.askSubmitted") : submitting ? t("session.askSubmitting") : t("session.askSubmit")}
        </button>
        {submitError ? (
          <span style={{ fontSize: "12px", color: "#dc2626" }}>{submitError}</span>
        ) : null}
        </div>
      ) : null}
    </div>
  );
}

function timelineItemSpacing(
  previous: TimelineItem | null,
  current: TimelineItem,
): string {
  if (!previous) {
    return "0";
  }
  if (isAuxiliaryTimelineItem(previous) && isAuxiliaryTimelineItem(current)) {
    return "6px";
  }
  return "16px";
}

// Row height used by the virtualizer until a row is measured. An estimate far
// from the real height shows up as a blank band between rows, inflates the
// scroll range, and — on iOS, where the virtualizer defers its scrollTop
// corrections until the finger lifts — makes the transcript visibly slide
// under the gesture. The old estimate assumed 90 characters per 22px line,
// which is ~4x too small for a phone-width (390px) transcript: a 1,500
// character reply measured ~2,100px but was estimated at ~450px, so every row
// entering from the top during an upward drag shifted the content by more than
// a screen and the deferred correction yanked it back after the swipe.
//
// Estimate from the rendered layout instead: measure the text with the
// transcript's own font, wrap it at the real column width, then add the line
// height and the 1em paragraph margin MarkdownViewer applies. Collapsed tool
// cards and thinking blocks are ~36-40px; todo/plan cards are ~64px.
const TRANSCRIPT_ESTIMATE_HORIZONTAL_PADDING = 32;
const ASSISTANT_ESTIMATE_FONT_SIZE = 15;
const ASSISTANT_ESTIMATE_LINE_HEIGHT = 1.75;
const USER_ESTIMATE_FONT_SIZE = 14;
const USER_ESTIMATE_LINE_HEIGHT = 1.5;
const USER_ESTIMATE_HORIZONTAL_PADDING = 32;
const USER_ESTIMATE_MAX_WIDTH_RATIO = 0.8;
const CODE_ESTIMATE_LINE_HEIGHT = 20.8;
const CODE_ESTIMATE_BLOCK_OVERHEAD = 77;
const LIST_ESTIMATE_INDENT_EM = 1.4;
const HEADING_ESTIMATE_FONT_SCALES = [1.6, 1.333, 1.133, 1, 1, 1];

type EstimateTextMetrics = {
  fontFamily: string;
  fontScale: number;
  context: CanvasRenderingContext2D | null;
  configuredFont: string;
};

function createEstimateTextMetrics(
  fontFamily: string,
  fontScale: number,
): EstimateTextMetrics {
  let context: CanvasRenderingContext2D | null = null;
  if (typeof document !== "undefined") {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  return { fontFamily, fontScale, context, configuredFont: "" };
}

function isWideEstimateCharacter(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function estimateFallbackTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const character of text) {
    if (character === "\t") {
      width += fontSize * 1.2;
    } else if (character === " ") {
      width += fontSize * 0.3;
    } else if (isWideEstimateCharacter(character.codePointAt(0) || 0)) {
      width += fontSize;
    } else {
      width += fontSize * 0.5;
    }
  }
  return width;
}

function measureEstimateTextWidth(
  text: string,
  fontSize: number,
  metrics?: EstimateTextMetrics | null,
): number {
  const context = metrics?.context;
  if (metrics && context) {
    const font = `${fontSize}px ${metrics.fontFamily || "sans-serif"}`;
    if (metrics.configuredFont !== font) {
      context.font = font;
      metrics.configuredFont = font;
    }
    return context.measureText(text).width;
  }
  return estimateFallbackTextWidth(text, fontSize);
}

// Inline Markdown tokens do not consume width when rendered. Strip the common
// ones so a link target or emphasis marker does not add phantom lines.
function stripMarkdownTokensForEstimate(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)/g, "")
    .replace(/^\s{0,3}(>\s?)+/, "")
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/, "");
}

function estimateWrappedLineCount(
  line: string,
  width: number,
  fontSize: number,
  metrics?: EstimateTextMetrics | null,
): number {
  if (!line) {
    return 1;
  }
  const textWidth = measureEstimateTextWidth(line, fontSize, metrics);
  if (width <= 0) {
    return Math.max(1, Math.ceil(textWidth / (fontSize * 14)));
  }
  // Word-wrapped Latin text leaves part of each line unused; CJK breaks
  // between characters and fills the line.
  const effectiveWidth = /\s/.test(line.trim()) ? width * 0.96 : width;
  return Math.max(1, Math.ceil(textWidth / effectiveWidth));
}

function estimateAssistantTextHeight(
  content: string,
  width: number,
  metrics?: EstimateTextMetrics | null,
): number {
  const fontScale = metrics?.fontScale || 1;
  const fontSize = ASSISTANT_ESTIMATE_FONT_SIZE * fontScale;
  const lineHeight = fontSize * ASSISTANT_ESTIMATE_LINE_HEIGHT;
  const paragraphMargin = fontSize;
  let height = 0;
  let paragraphLines = 0;
  let inCodeBlock = false;
  const flushParagraph = () => {
    if (paragraphLines > 0) {
      height += paragraphLines * lineHeight + paragraphMargin;
      paragraphLines = 0;
    }
  };
  for (const rawLine of content.split("\n")) {
    if (rawLine.trim().startsWith("```")) {
      flushParagraph();
      if (inCodeBlock) {
        // Code blocks carry their own padding and 1.5em margins.
        height += CODE_ESTIMATE_BLOCK_OVERHEAD * fontScale;
      }
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      // Code blocks render at a smaller monospace size with one line box per
      // source line.
      height += CODE_ESTIMATE_LINE_HEIGHT * fontScale;
      continue;
    }
    if (!rawLine.trim()) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine);
    if (heading) {
      flushParagraph();
      const headingFontSize =
        fontSize *
        HEADING_ESTIMATE_FONT_SCALES[Math.min(heading[1].length, 6) - 1];
      const headingLines = estimateWrappedLineCount(
        stripMarkdownTokensForEstimate(heading[2]),
        width,
        headingFontSize,
        metrics,
      );
      height += headingLines * headingFontSize * ASSISTANT_ESTIMATE_LINE_HEIGHT;
      continue;
    }
    const isListItem = /^\s{0,3}([-*+]|\d+[.)])\s+/.test(rawLine);
    paragraphLines += estimateWrappedLineCount(
      stripMarkdownTokensForEstimate(rawLine),
      isListItem ? Math.max(40, width - fontSize * LIST_ESTIMATE_INDENT_EM) : width,
      fontSize,
      metrics,
    );
  }
  flushParagraph();
  return height;
}

function estimateUserTextHeight(
  content: string,
  width: number,
  metrics?: EstimateTextMetrics | null,
): number {
  const fontScale = metrics?.fontScale || 1;
  const fontSize = USER_ESTIMATE_FONT_SIZE * fontScale;
  const lineHeight = fontSize * USER_ESTIMATE_LINE_HEIGHT;
  let lines = 0;
  for (const rawLine of content.split("\n")) {
    lines += estimateWrappedLineCount(rawLine, width, fontSize, metrics);
  }
  return lines * lineHeight;
}

function estimateTimelineRowSize(
  item: TimelineItem | undefined,
  layoutWidth = 0,
  metrics?: EstimateTextMetrics | null,
  rowSpacing = 0,
): number {
  if (!item) {
    return 40 + rowSpacing;
  }
  if (item.type === "tool" || item.type === "thought") {
    // Collapsed header rows: 6px vertical padding, a 12px/1.5 title line and
    // a border. Isolated rows add the 16px transcript spacing, auxiliary runs
    // only 6px. 40px overestimated a dense think/tool sequence by ~8px per
    // row, which is exactly the kind of accumulated delta iOS applies in a
    // burst after an upward drag.
    return 32 + rowSpacing;
  }
  if (item.type === "todo" || item.type === "tasks" || item.type === "plan" || item.type === "compact") {
    return 64 + rowSpacing;
  }
  const content = item.content || "";
  if (!content.trim()) {
    return 56 + rowSpacing;
  }
  const innerWidth = Math.max(
    0,
    layoutWidth - TRANSCRIPT_ESTIMATE_HORIZONTAL_PADDING,
  );
  if (item.type === "user_text") {
    const bubbleWidth = Math.max(
      80,
      innerWidth * USER_ESTIMATE_MAX_WIDTH_RATIO - USER_ESTIMATE_HORIZONTAL_PADDING,
    );
    // 20px bubble padding + the timestamp line under the bubble.
    return 40 + estimateUserTextHeight(content, bubbleWidth, metrics) + rowSpacing;
  }
  // Assistant meta row (when visible) plus the measured row spacing.
  return 22 + estimateAssistantTextHeight(content, innerWidth, metrics) + rowSpacing;
}

function shouldDefaultCollapseRelatedFiles(
  isMobile: boolean,
  relatedFileCount: number,
): boolean {
  if (isMobile) {
    return relatedFileCount > 0;
  }
  return relatedFileCount > 5;
}

const USER_MESSAGE_SUMMARY_LENGTH = 48;

function normalizeUserMessageSummary(content: string, emptyLabel: string): string {
  const text = stripUploadAttachmentTokens(content || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    return emptyLabel;
  }
  return text.length > USER_MESSAGE_SUMMARY_LENGTH
    ? `${text.slice(0, USER_MESSAGE_SUMMARY_LENGTH)}...`
    : text;
}

function UserMessageListIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M0 0h32v32H0z" fill="none" />
      <path fill="currentColor" d="M4.082 4.083v3h22.835v-3zm0 16.223h22.835v-3H4.082zm0-6.612h22.835v-3H4.082zm0 13.223h22.835v-3H4.082z" />
    </svg>
  );
}

// The summary/jump controls float over the lower-right corner of the
// transcript. Reserve enough tail padding for the last message to clear them
// when the view is scrolled to the bottom; while scrolling, content stays
// visible around the controls.
const SESSION_TAIL_CONTROLS_OFFSET = 16;
const SESSION_TAIL_CONTROLS_SIZE = 34;
const SESSION_TAIL_CONTROLS_BADGE_OVERHANG = 7;
const SESSION_TAIL_CONTROLS_GAP = 8;

function SessionViewerInner({
  session,
  loading = false,
  slashCommandResult = null,
  rootId,
  rootPath,
  interactionMode = "main",
  targetSeq = 0,
  targetSeqRequestKey = "",
  onFileClick,
  onRootClick,
  onRemoveRelatedFile,
  onAskUserAnswer,
  onEditUserMessage,
  onForkAgentMessage,
  agents,
  composerOverlayInset = 0,
  onRenameSession,
  onDeleteSession,
  onDetachSession,
  onHandoffPack,
  onScheduledTask,
}: SessionViewerProps) {
  const { locale, t } = useI18n();
  const sessionTailPaddingBottom =
    SESSION_TAIL_CONTROLS_OFFSET +
    composerOverlayInset +
    SESSION_TAIL_CONTROLS_SIZE +
    SESSION_TAIL_CONTROLS_BADGE_OVERHANG +
    SESSION_TAIL_CONTROLS_GAP;
  const [relatedFilesCollapsed, setRelatedFilesCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return window.matchMedia("(max-width: 767px)").matches;
  });
  const replyInfoPreferences = useReplyInfoPreferences();
  const visibleReplyInfo = isMobile ? replyInfoPreferences : DEFAULT_REPLY_INFO_PREFERENCES;
  const [savedPromptKeys, setSavedPromptKeys] = useState<Record<string, true>>(
    {},
  );
  const [copiedMessageKeys, setCopiedMessageKeys] = useState<
    Record<string, true>
  >({});
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onFileClickRef = useRef(onFileClick);
  const copyResetTimersRef = useRef<Record<string, number>>({});
  const relatedFilesDefaultStateRef = useRef<string>("");
  const userSummaryRootRef = useRef<HTMLDivElement | null>(null);
  const userSummaryListRef = useRef<HTMLDivElement | null>(null);
  // The transcript swaps between the regular list and the virtualizer at 100
  // items. That swap rebuilds the scroll body from size estimates; keep the
  // measured row heights and the reading offset so the viewport survives it.
  const nonVirtualItemHeightsRef = useRef<Map<number, number> | null>(null);
  // Text estimates scan the whole message, and the virtualizer re-estimates
  // every unmeasured row whenever one row is measured. Cache by stable item id
  // and layout width so scrolling through a long history does not re-scan
  // every message on each frame.
  const estimateRowSizeCacheRef = useRef<Map<string, number>>(new Map());
  const estimateTextMetricsRef = useRef<EstimateTextMetrics | null>(null);
  const lastKnownScrollTopRef = useRef(0);
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const pendingScrollRestoreDeadlineRef = useRef(0);
  const previousVirtualizedRef = useRef<boolean | null>(null);
  // The virtualizer compensates row-height corrections by writing scrollTop.
  // Remember the last write so the scroll listener can tell that movement
  // apart from a reading gesture.
  const virtualizerScrollWriteRef = useRef({ at: 0, offset: 0 });
  const sessionStickSettleTimersRef = useRef<number[]>([]);
  const previousLoadingRef = useRef(loading);
  const sessionKey = session?.key || session?.session_key || null;
  const [editingMessage, setEditingMessage] = useState<{ seq: number; original: string; timestamp: string; content: string } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState("");
  const editSubmitting = useRef(false);
  const editVersion = useRef(0);
  const editComposing = useRef(false);
  useEffect(() => {
    ++editVersion.current;
    editSubmitting.current = false;
    editComposing.current = false;
    setSavingEdit(false);
    return () => { ++editVersion.current; };
  }, [rootId, sessionKey]);
  const submitEdit = async () => {
    if (!rootId || !sessionKey || !editingMessage?.content.trim() || editSubmitting.current) return;
    const version = editVersion.current;
    editSubmitting.current = true;
    setSavingEdit(true);
    setEditError("");
    try {
      await sessionService.editMessage(rootId, sessionKey, editingMessage.seq, editingMessage.content, editingMessage.original, editingMessage.timestamp);
      if (version === editVersion.current) {
        setEditingMessage(null);
        // Editing restarts the conversation from the edited message, and the
        // regenerated reply streams at the tail. Unlike a normal send there
        // is no optimistic pending_ack row to re-arm following, so the edit
        // taps or the scroll used to reach the message could leave the
        // reader paused above the new reply. Return to the tail like a send.
        resumeFollowing();
        window.requestAnimationFrame(() => {
          if (shouldStickToBottomRef.current) {
            stickSessionToBottom("auto");
          }
        });
      }
    } catch (error) {
      if (version === editVersion.current) setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === editVersion.current) { editSubmitting.current = false; setSavingEdit(false); }
    }
  };
  useEffect(() => { setEditingMessage(null); setEditError(""); }, [rootId, sessionKey]);
  const exchanges = Array.isArray(session?.exchanges) ? session.exchanges : [];
  const isAwaiting = !!(session as any)?.pending;
  const { timeline, isStreaming, streamVersion, streamStatusText, latestTaskList } = useSessionStream(
    sessionKey,
    exchanges,
    session?.exchange_aux || {},
    session?.context_window,
    isAwaiting,
  );
  const shouldStickToBottomRef = useRef(true);
  // Set when the reader explicitly pauses tail-following (wheel up, upward
  // touch drag, expanded card, summary/search jump). While set, the tail-slop
  // rule must not silently re-enable following: a streamed append can land
  // while the viewport is still within a few pixels of the tail, and
  // re-arming there drags the reader back down on every chunk.
  const userPausedFollowingRef = useRef(false);
  // scrollTop where the current reading pause began. The transcript reserves
  // tall tail space for the floating controls, so the newest message can be
  // fully visible long before the hard scroll bottom. Comparing against this
  // origin (instead of the content height, which keeps growing while the
  // reply streams) tells the settle check whether the reader actually moved
  // up or simply stopped where the tail was when they touched.
  const pauseOriginTopRef = useRef(0);
  // The pause was an explicit navigation (expanded card, summary/search jump),
  // not a reading gesture. The settle check may re-arm a stray gesture pause,
  // but it must never undo one of these: the reader asked to stay there.
  const intentionalPauseRef = useRef(false);
  // The current pause began with a finger drag, which on a phone can be a
  // 2-3px tap drift rather than a reading scroll. Wheel pauses are explicit
  // even when the view did not move, so only touch pauses may re-arm purely
  // because the position did not change.
  const touchPauseRef = useRef(false);
  // Last time the reader moved toward the tail (wheel down, finger up). Only
  // explicit downward intent may resume following from the reserved tail
  // area; virtualizer/layout corrections must not re-arm it by themselves.
  const lastDownwardIntentAtRef = useRef(0);
  const lastPendingUserKeyRef = useRef("");
  const latestUserIndex = timeline.reduce((last, item, index) => item.type === "user_text" ? index : last, -1);
  const latestCompletedReplyIndex = useMemo(() => {
    for (let index = timeline.length - 1; index >= 0; index--) {
      if (timeline[index].type === "assistant_text" &&
          (timeline[index + 1]?.type === "user_text" || (index === timeline.length - 1 && !isStreaming))) return index;
    }
    return -1;
  }, [timeline, isStreaming]);
  const lastSessionKeyRef = useRef<string | null>(null);
  const targetSeqScrollKeyRef = useRef("");
  const targetSeqFrameRef = useRef<number | null>(null);
  const targetSeqTimerRefs = useRef<number[]>([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [userSummaryHoverOpen, setUserSummaryHoverOpen] = useState(false);
  const [userSummaryPinnedOpen, setUserSummaryPinnedOpen] = useState(false);
  const [taskPanelHoverOpen, setTaskPanelHoverOpen] = useState(false);
  const [taskPanelPinnedOpen, setTaskPanelPinnedOpen] = useState(false);
  const taskPanelOpen = taskPanelHoverOpen || taskPanelPinnedOpen;
  const taskItems = latestTaskList?.items || [];
  const completedTaskCount = taskItems.filter((item) => {
    const status = `${item?.status || ""}`.trim().toLowerCase();
    return status === "complete" || status === "completed";
  }).length;
  const [currentUserMessageIndex, setCurrentUserMessageIndex] = useState(0);
  const viewportStickFrameRef = useRef<number | null>(null);
  // Completion re-syncs the transcript with the persisted exchanges. Rows
  // above the reader (a transient optimistic user copy, thought/tool exchanges
  // folded into exchange_aux) can disappear or be re-keyed in one commit, and
  // the virtualizer does not compensate for rows removed above the viewport:
  // the text under the reader jumps. Pin the top visible row's screen offset
  // for a short settle window instead.
  const previousStreamingRef = useRef(isStreaming);
  const previousAwaitingRef = useRef(isAwaiting);
  const previousCompletionSessionRef = useRef(sessionKey);
  // The completion update can render in the same commit that flips the
  // stream flag, so the post-commit effect is already too late to see the
  // pre-update layout. Track the reader's top row on every paused scroll.
  const liveReadingAnchorRef = useRef<{
    itemId: string;
    contentHint: string;
    type: string;
    index: number;
    offset: number;
    sessionKey: string;
  } | null>(null);
  const readingAnchorRef = useRef<{
    itemId: string;
    contentHint: string;
    type: string;
    index: number;
    offset: number;
    sessionKey: string;
  } | null>(null);
  const readingAnchorFrameRef = useRef<number | null>(null);
  const readingAnchorDeadlineRef = useRef(0);
  const readingAnchorWriteRef = useRef({ at: 0, offset: 0 });
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  const readingSessionKeyRef = useRef(sessionKey);
  readingSessionKeyRef.current = sessionKey;
  const toolViewCache = useMemo<ToolCallViewCache>(
    () => ({ expanded: new Map(), details: new Map() }),
    [rootId, sessionKey],
  );
  // Tool timeline ids include the exchange index because a call persisted in
  // two exchanges renders twice. That index is not stable across a live turn:
  // a call starts in a transient role:"tool" exchange and moves into the agent
  // exchange's aux list when the finished turn is re-synced, so the card is
  // remounted under a new key. Use the callId as the expansion key whenever it
  // is unambiguous, otherwise an expanded card closed itself on completion.
  const duplicatedToolCallIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of timeline) {
      if (item.type !== "tool") continue;
      const callId = item.toolCall?.callId || "";
      if (!callId) continue;
      counts.set(callId, (counts.get(callId) || 0) + 1);
    }
    return new Set(
      Array.from(counts)
        .filter(([, count]) => count > 1)
        .map(([callId]) => callId),
    );
  }, [timeline]);
  // Thoughts move from a transient role:"thought" exchange into the agent
  // exchange's aux list the same way, so their expansion cache must be keyed by
  // the server thought id instead of the exchange-scoped timeline id. Thoughts
  // without an id keep the timeline key.
  const duplicatedThoughtIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of timeline) {
      if (item.type !== "thought" || !item.thoughtId) continue;
      counts.set(item.thoughtId, (counts.get(item.thoughtId) || 0) + 1);
    }
    return new Set(
      Array.from(counts)
        .filter(([, count]) => count > 1)
        .map(([thoughtId]) => thoughtId),
    );
  }, [timeline]);
  const timelineNavigation = useMemo(() => {
    let userIndex = 0;
    let previousTimestamp = "";
    const seqIndices = new Map<number, number>();
    const userIndices: number[] = [];
    const pendingQuestionIndices: number[] = [];
    const rows = timeline.map((item, index) => {
      const previousUserTime = previousTimestamp;
      if (item.type === "user_text") {
        userIndex += 1;
        previousTimestamp = item.timestamp || "";
        userIndices.push(index);
      }
      if ("seq" in item && item.seq && !seqIndices.has(item.seq)) seqIndices.set(item.seq, index);
      // Keep unanswered forms mounted so scrolling cannot discard a user's draft.
      if (item.type === "tool" && item.toolCall.kind === "ask_user" &&
          ["running", "pending", "in_progress"].includes(item.toolCall.status || "")) {
        pendingQuestionIndices.push(index);
      }
      return { userIndex, previousUserTime };
    });
    return { rows, seqIndices, userIndices, pendingQuestionIndices };
  }, [timeline]);
  const virtualized = timeline.length > 100;
  const virtualizedRef = useRef(virtualized);
  virtualizedRef.current = virtualized;
  const virtualizer = useVirtualizer({
    count: timeline.length,
    getScrollElement: () => scrollRef.current,
    enabled: virtualized,
    getItemKey: (index) => `${rootId}:${sessionKey}:${timeline[index].id || index}`,
    estimateSize: (index) => {
      const item = timeline[index];
      if (!item) {
        return 40;
      }
      const rowSpacing =
        index > 0
          ? isAuxiliaryTimelineItem(timeline[index - 1]) &&
            isAuxiliaryTimelineItem(item)
            ? 6
            : 16
          : 0;
      if (item.type !== "user_text" && item.type !== "assistant_text") {
        return estimateTimelineRowSize(item, 0, null, rowSpacing);
      }
      const container = scrollRef.current;
      if (!estimateTextMetricsRef.current && container && typeof window !== "undefined") {
        const computed = window.getComputedStyle(container);
        const parsedScale = Number.parseFloat(
          computed.getPropertyValue("--mindfs-font-scale"),
        );
        estimateTextMetricsRef.current = createEstimateTextMetrics(
          computed.fontFamily || "sans-serif",
          Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : 1,
        );
      }
      const metrics = estimateTextMetricsRef.current;
      const containerWidth =
        container?.clientWidth ||
        (typeof window !== "undefined" ? window.innerWidth : 0);
      const width = Math.round(containerWidth / 8) * 8;
      const cacheKey = `${item.id || index}:${width}:${metrics?.fontScale || 1}`;
      const cache = estimateRowSizeCacheRef.current;
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const size = estimateTimelineRowSize(item, width, metrics, rowSpacing);
      if (cache.size > 4000) {
        cache.clear();
      }
      cache.set(cacheKey, size);
      return size;
    },
    overscan: 8,
    // Defer ResizeObserver work to the next frame. Measuring rows
    // synchronously while the reader scrolls caused the transcript to fight
    // the gesture (and triggered "ResizeObserver loop" warnings).
    useAnimationFrameWithResizeObserver: true,
    scrollToFn: (offset, scrollOptions, instance) => {
      virtualizerScrollWriteRef.current = {
        at: performance.now(),
        offset: offset + (scrollOptions.adjustments || 0),
      };
      elementScroll(offset, scrollOptions, instance);
    },
    rangeExtractor: (range) => Array.from(new Set([
      ...defaultRangeExtractor(range), ...timelineNavigation.pendingQuestionIndices,
    ])).sort((a, b) => a - b),
    onChange: (instance) => {
      if (!shouldStickToBottomRef.current || instance.isScrolling) return;
      if (viewportStickFrameRef.current !== null) cancelAnimationFrame(viewportStickFrameRef.current);
      viewportStickFrameRef.current = requestAnimationFrame(() => {
        viewportStickFrameRef.current = null;
        if (shouldStickToBottomRef.current) stickSessionToBottom();
      });
    },
  });

  const captureReadingAnchor = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return null;
    }
    let index = -1;
    let offset = 0;
    if (virtualizedRef.current) {
      const rows = virtualizer.getVirtualItems();
      const first =
        rows.find((row) => row.end > container.scrollTop + 1) || rows[0];
      if (!first) {
        return null;
      }
      index = first.index;
      offset = first.start - container.scrollTop;
    } else {
      const containerTop = container.getBoundingClientRect().top;
      const node = Array.from(
        container.querySelectorAll<HTMLElement>("[data-timeline-index]"),
      ).find((candidate) => candidate.getBoundingClientRect().bottom > containerTop);
      if (!node) {
        return null;
      }
      const parsed = Number(node.dataset.timelineIndex || "");
      if (!Number.isInteger(parsed) || parsed < 0) {
        return null;
      }
      index = parsed;
      offset = node.getBoundingClientRect().top - containerTop;
    }
    const item = timelineRef.current[index];
    if (!item) {
      return null;
    }
    return {
      itemId: item.id || "",
      contentHint: "content" in item ? (item.content || "").slice(0, 80) : "",
      type: item.type,
      index,
      offset,
      sessionKey: readingSessionKeyRef.current || "",
    };
  }, [virtualizer]);

  const releaseReadingAnchor = useCallback(() => {
    readingAnchorRef.current = null;
    if (readingAnchorFrameRef.current !== null) {
      window.cancelAnimationFrame(readingAnchorFrameRef.current);
      readingAnchorFrameRef.current = null;
    }
  }, []);

  // Re-resolve the anchor row every frame: completion re-syncs usually land a
  // few frames after the stream flag flips, and rows above the reader shift
  // the document when they are added, removed, or re-keyed. Keep the anchored
  // row at the same screen offset until the settle window expires, a user
  // gesture takes over, or tail-following resumes.
  const holdReadingAnchor = useCallback(() => {
    readingAnchorFrameRef.current = null;
    const anchor = readingAnchorRef.current;
    const container = scrollRef.current;
    if (
      !anchor ||
      !container ||
      shouldStickToBottomRef.current ||
      readingSessionKeyRef.current !== anchor.sessionKey
    ) {
      releaseReadingAnchor();
      return;
    }
    const items = timelineRef.current;
    // The completion re-sync re-keys rows (timeline ids are exchange-scoped)
    // and drops transient rows, so the recorded id is often gone. Resolve the
    // same content occurrence by the match *nearest* the recorded index:
    // short user messages like "继续" repeat across a session, and the first
    // content match can sit thousands of pixels above the reader. Pinning it
    // yanked the viewport back to an earlier conversation.
    const nearestToAnchor = (candidates: number[]) =>
      candidates.reduce((best, candidate) =>
        Math.abs(candidate - anchor.index) < Math.abs(best - anchor.index)
          ? candidate
          : best,
      );
    let index = -1;
    if (anchor.itemId) {
      const matches: number[] = [];
      items.forEach((item, itemIndex) => {
        if ((item.id || "") === anchor.itemId) {
          matches.push(itemIndex);
        }
      });
      if (matches.length > 0) {
        index = nearestToAnchor(matches);
      }
    }
    if (index < 0 && anchor.contentHint) {
      const matches: number[] = [];
      items.forEach((item, itemIndex) => {
        if (
          item.type === anchor.type &&
          "content" in item &&
          (item.content || "").startsWith(anchor.contentHint)
        ) {
          matches.push(itemIndex);
        }
      });
      if (matches.length > 0) {
        index = nearestToAnchor(matches);
      }
    }
    if (index < 0) {
      index = Math.min(anchor.index, Math.max(0, items.length - 1));
    }
    let start: number | null = null;
    if (virtualizedRef.current) {
      const mounted = virtualizer
        .getVirtualItems()
        .find((row) => row.index === index);
      if (mounted) {
        start = mounted.start;
      } else {
        const resolved = virtualizer.getOffsetForIndex(index, "start");
        start = resolved ? resolved[0] : null;
      }
    } else {
      const node = container.querySelector<HTMLElement>(
        `[data-timeline-index="${index}"]`,
      );
      if (node) {
        start =
          node.getBoundingClientRect().top -
          container.getBoundingClientRect().top +
          container.scrollTop;
      }
    }
    if (start !== null) {
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const target = Math.max(0, Math.min(maxTop, start - anchor.offset));
      if (Math.abs(container.scrollTop - target) > 1) {
        readingAnchorWriteRef.current = { at: performance.now(), offset: target };
        container.scrollTop = target;
      }
    }
    if (performance.now() < readingAnchorDeadlineRef.current) {
      readingAnchorFrameRef.current =
        window.requestAnimationFrame(holdReadingAnchor);
    } else {
      readingAnchorRef.current = null;
    }
  }, [releaseReadingAnchor, virtualizer]);

  // Capture real row heights while the regular list is mounted. When the
  // timeline crosses into virtualization those measurements seed the
  // virtualizer, so its scroll body keeps the existing height instead of
  // collapsing to estimates.
  useLayoutEffect(() => {
    // Only sessions near the virtualization threshold need the measurement;
    // shorter ones never swap layouts.
    if (virtualized || timeline.length < 80) {
      return;
    }
    const container = scrollRef.current;
    if (!container || !scrollEndRef.current) {
      return;
    }
    const heights = new Map<number, number>();
    container.querySelectorAll<HTMLElement>("[data-timeline-index]").forEach((node) => {
      const index = Number(node.dataset.timelineIndex || "");
      if (!Number.isInteger(index) || index < 0) {
        return;
      }
      const marginTop = Number.parseFloat(node.style.marginTop || "0") || 0;
      heights.set(index, Math.ceil(node.getBoundingClientRect().height + marginTop));
    });
    nonVirtualItemHeightsRef.current = heights;
    lastKnownScrollTopRef.current = container.scrollTop;
  });

  useLayoutEffect(() => {
    const wasVirtualized = previousVirtualizedRef.current;
    previousVirtualizedRef.current = virtualized;
    if (wasVirtualized === null || wasVirtualized === virtualized) {
      return;
    }
    if (shouldStickToBottomRef.current) {
      // Following the tail re-anchors itself; only a reading gesture needs
      // the viewport preserved across the layout swap.
      pendingScrollRestoreRef.current = null;
      return;
    }
    if (virtualized) {
      const heights = nonVirtualItemHeightsRef.current;
      heights?.forEach((height, index) => {
        if (index < timeline.length) {
          virtualizer.resizeItem(index, height);
        }
      });
    }
    pendingScrollRestoreRef.current = lastKnownScrollTopRef.current;
    pendingScrollRestoreDeadlineRef.current = performance.now() + 600;
  }, [virtualized, virtualizer, timeline.length]);

  useLayoutEffect(() => {
    const target = pendingScrollRestoreRef.current;
    if (target === null) {
      return;
    }
    if (shouldStickToBottomRef.current) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    let cancelled = false;
    let frame: number | null = null;
    let attempts = 0;
    // The virtualizer publishes the seeded row sizes on a follow-up render.
    // Wait for that height before writing the offset; writing while the sizer
    // still uses estimates clamps to the estimated bottom and re-enables
    // following, which is the jump this restore exists to prevent.
    const restore = () => {
      if (cancelled || pendingScrollRestoreRef.current === null) {
        return;
      }
      if (shouldStickToBottomRef.current) {
        pendingScrollRestoreRef.current = null;
        return;
      }
      attempts += 1;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      const settled = performance.now() >= pendingScrollRestoreDeadlineRef.current;
      if (virtualized && !settled && maxTop < target && attempts < 24) {
        frame = window.requestAnimationFrame(restore);
        return;
      }
      container.scrollTop = Math.min(target, maxTop);
      pendingScrollRestoreRef.current = null;
    };
    restore();
    return () => {
      cancelled = true;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  });

  const cancelTargetSeqScroll = () => {
    if (targetSeqFrameRef.current !== null) {
      window.cancelAnimationFrame(targetSeqFrameRef.current);
      targetSeqFrameRef.current = null;
    }
    targetSeqTimerRefs.current.forEach((timer) => window.clearTimeout(timer));
    targetSeqTimerRefs.current = [];
  };

  const stickSessionToBottom = (behavior: ScrollBehavior = "auto") => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    lastKnownScrollTopRef.current = maxTop;
    container.scrollTo({ top: maxTop, behavior });
  };

  const clearSessionStickSettle = () => {
    sessionStickSettleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    sessionStickSettleTimersRef.current = [];
  };

  // "The reader is at the tail" must include the reserved controls padding
  // below the last row: the newest message is fully visible there, and an iOS
  // fling often decays just past the point where the end marker leaves the
  // viewport. Allow one more line of slack below the fold. Shared by the
  // scroll handler and the content observer so an intentional pause (expanded
  // card, summary/search jump) ends exactly where following can re-arm.
  const isNearSessionTail = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return false;
    }
    const end = scrollEndRef.current;
    if (
      end &&
      end.getBoundingClientRect().top <=
        container.getBoundingClientRect().bottom + 8
    ) {
      return true;
    }
    return (
      container.scrollHeight - container.clientHeight - container.scrollTop <=
      sessionTailPaddingBottom + 40
    );
  }, [sessionTailPaddingBottom]);

  // A freshly opened long session starts from estimated row heights. When the
  // measured heights (or a restored scroll offset) land later, the viewport can
  // settle above the tail. Re-assert the bottom for a short window after the
  // session opens or its history finishes loading. Wheel/touch reading gestures
  // set userPaused, so this never fights a reader; a scrollbar/keyboard scroll
  // in that first moment is the only gesture it can override.
  const scheduleSessionStickSettle = () => {
    clearSessionStickSettle();
    [0, 150, 450].forEach((delay) => {
      const timer = window.setTimeout(() => {
        sessionStickSettleTimersRef.current = sessionStickSettleTimersRef.current.filter(
          (item) => item !== timer,
        );
        if (userPausedFollowingRef.current) {
          return;
        }
        stickSessionToBottom("auto");
      }, delay);
      sessionStickSettleTimersRef.current.push(timer);
    });
  };

  // Every path that resumes following clears the pause guards together, so a
  // stale intentional/touch marker cannot leak into the next pause.
  const resumeFollowing = useCallback(() => {
    intentionalPauseRef.current = false;
    touchPauseRef.current = false;
    userPausedFollowingRef.current = false;
    shouldStickToBottomRef.current = true;
    // Drop the live capture too. It only describes a paused reader; keeping
    // it meant the next pause (for example expanding a thought block) could
    // apply a completion anchor from a position the reader had already left,
    // yanking the viewport back to that earlier conversation.
    liveReadingAnchorRef.current = null;
    setShowJumpToLatest(false);
  }, []);

  // Expanding a card is a reading gesture. Stop tail-following so the added
  // content (and later stream updates) cannot drag the viewport back down.
  const pauseSessionFollowing = useCallback(() => {
    // A card expansion moves the tail without a scroll event, so this is the
    // reader's position at the pause. Capture it now: the completion re-sync
    // needs the pre-completion layout to resolve the same row afterwards.
    liveReadingAnchorRef.current = captureReadingAnchor();
    if (!userPausedFollowingRef.current) {
      pauseOriginTopRef.current = scrollRef.current?.scrollTop ?? 0;
    }
    intentionalPauseRef.current = true;
    touchPauseRef.current = false;
    shouldStickToBottomRef.current = false;
    userPausedFollowingRef.current = true;
    releaseReadingAnchor();
    if (targetSeqFrameRef.current !== null) {
      window.cancelAnimationFrame(targetSeqFrameRef.current);
      targetSeqFrameRef.current = null;
    }
    targetSeqTimerRefs.current.forEach((timer) => window.clearTimeout(timer));
    targetSeqTimerRefs.current = [];
    if (viewportStickFrameRef.current !== null) {
      window.cancelAnimationFrame(viewportStickFrameRef.current);
      viewportStickFrameRef.current = null;
    }
    // The expanded card moves the tail away without producing a scroll event;
    // surface the jump button now that following is paused.
    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (!container || shouldStickToBottomRef.current) {
        return;
      }
      const distanceFromBottom = container.scrollHeight - container.clientHeight - container.scrollTop;
      if (distanceFromBottom > 40) {
        setShowJumpToLatest(true);
      }
    });
  }, [captureReadingAnchor, releaseReadingAnchor]);

  // Sending a message always returns the view to the tail, even when the user
  // had scrolled up to read history. The optimistic user exchange carries
  // pending_ack until the server acknowledges it, which makes it a precise
  // "user just sent this" signal (unlike history loads or edits).
  useEffect(() => {
    let pendingUserId = "";
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item.type === "user_text" && item.pendingAck) {
        pendingUserId = item.id;
        break;
      }
    }
    if (!pendingUserId) {
      return;
    }
    const key = `${sessionKey || ""}:${pendingUserId}`;
    if (lastPendingUserKeyRef.current === key) {
      return;
    }
    lastPendingUserKeyRef.current = key;
    cancelTargetSeqScroll();
    resumeFollowing();
    const frame = window.requestAnimationFrame(() => {
      if (shouldStickToBottomRef.current) {
        stickSessionToBottom("auto");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timeline, sessionKey, resumeFollowing]);

  useEffect(() => {
    onFileClickRef.current = onFileClick;
  }, [onFileClick]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const media = window.matchMedia("(max-width: 767px)");
    const handleChange = () => {
      setIsMobile(media.matches);
    };
    handleChange();
    media.addEventListener("change", handleChange);
    return () => {
      media.removeEventListener("change", handleChange);
    };
  }, []);

  useEffect(() => {
    setSavedPromptKeys({});
    setCopiedMessageKeys({});
    setUserSummaryHoverOpen(false);
    setUserSummaryPinnedOpen(false);
    setCurrentUserMessageIndex(0);
    estimateRowSizeCacheRef.current.clear();
    estimateTextMetricsRef.current = null;
    releaseReadingAnchor();
    relatedFilesDefaultStateRef.current = "";
    Object.values(copyResetTimersRef.current).forEach((timer) =>
      window.clearTimeout(timer),
    );
    copyResetTimersRef.current = {};
  }, [sessionKey]);

  const cumulativeTokenUsage = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    return timeline.map((item) => {
      if (item.type === "assistant_text" && item.tokenUsage) {
        inputTokens += Math.max(0, Number(item.tokenUsage.inputTokens || 0));
        outputTokens += Math.max(0, Number(item.tokenUsage.outputTokens || 0));
      }
      return { inputTokens, outputTokens };
    });
  }, [timeline]);

  const userMessageSummaries = useMemo(
    () =>
      timeline
        .filter((item): item is TimelineItem & { type: "user_text"; id: string; content: string } => item.type === "user_text")
        .map((item, index) => ({
          id: item.id || `user-${index}`,
          index: index + 1,
          summary: normalizeUserMessageSummary(item.content || "", t("session.emptyMessage")),
        })),
    [timeline, t],
  );
  const userSummaryOpen = userSummaryHoverOpen || userSummaryPinnedOpen;

  const readCurrentUserMessageIndex = useCallback(() => {
    const container = scrollRef.current;
    if (!container) {
      return 0;
    }
    if (virtualized) {
      const first = virtualizer.getVirtualItems().find((item) => item.end >= container.scrollTop - 24);
      return first ? Math.max(1, timelineNavigation.rows[first.index]?.userIndex || 0) : 0;
    }
    const nodes = Array.from(
      container.querySelectorAll<HTMLElement>("[data-user-message-index]"),
    );
    if (nodes.length === 0) {
      return 0;
    }
    const containerRect = container.getBoundingClientRect();
    const viewportTop = containerRect.top;
    const viewportBottom = containerRect.bottom;
    let firstVisible = 0;
    let firstFullyEntered = 0;
    let lastBeforeViewport = 0;
    for (const node of nodes) {
      const index = Number(node.dataset.userMessageIndex || 0);
      if (!index) {
        continue;
      }
      const rect = node.getBoundingClientRect();
      if (rect.bottom < viewportTop) {
        lastBeforeViewport = index;
        continue;
      }
      if (rect.top > viewportBottom) {
        break;
      }
      const isVisible = rect.bottom >= viewportTop && rect.top <= viewportBottom;
      if (isVisible && !firstVisible) {
        firstVisible = index;
      }
      if (rect.top >= viewportTop && !firstFullyEntered) {
        firstFullyEntered = index;
      }
    }
    return (
      firstFullyEntered ||
      firstVisible ||
      lastBeforeViewport ||
      Number(nodes[0]?.dataset.userMessageIndex || 0)
    );
  }, [virtualized, virtualizer, timelineNavigation]);

  const refreshCurrentUserMessageIndex = useCallback(() => {
    setCurrentUserMessageIndex(readCurrentUserMessageIndex());
  }, [readCurrentUserMessageIndex]);
  // The scroll listener must keep reading the newest timeline without being
  // torn down on every streamed chunk. Update the mirrored callbacks during
  // render and call them through refs from the listener effect.
  const refreshCurrentUserMessageIndexRef = useRef(refreshCurrentUserMessageIndex);
  refreshCurrentUserMessageIndexRef.current = refreshCurrentUserMessageIndex;

  const scrollToUserMessageSummary = (index: number) => {
    if (virtualized) {
      const target = timelineNavigation.userIndices[index - 1];
      if (target === undefined) return;
      intentionalPauseRef.current = true;
      touchPauseRef.current = false;
      shouldStickToBottomRef.current = false;
      userPausedFollowingRef.current = true;
      releaseReadingAnchor();
      cancelTargetSeqScroll();
      virtualizer.scrollToIndex(target, { align: "center" });
      setShowJumpToLatest(true);
      setUserSummaryPinnedOpen(false);
      setUserSummaryHoverOpen(false);
      setCurrentUserMessageIndex(index);
      return;
    }
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const node = container.querySelector<HTMLElement>(
      `[data-user-message-index="${index}"]`,
    );
    if (!node) {
      return;
    }
    intentionalPauseRef.current = true;
    touchPauseRef.current = false;
    shouldStickToBottomRef.current = false;
    userPausedFollowingRef.current = true;
    cancelTargetSeqScroll();
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const nextTop = Math.max(
      0,
      Math.min(
        maxTop,
        container.scrollTop +
          nodeRect.top -
          containerRect.top -
          container.clientHeight / 2 +
          nodeRect.height / 2,
      ),
    );
    container.scrollTop = nextTop;
    setShowJumpToLatest(nextTop < maxTop - 40);
    setUserSummaryPinnedOpen(false);
    setUserSummaryHoverOpen(false);
    setCurrentUserMessageIndex(index);
  };

  // Keep the active row centered inside the summary popup. Run only when the
  // popup opens or the active message actually changes: depending on the
  // timeline reader here re-centered the list on every streamed chunk and
  // fought a user who was scrolling the popup.
  useEffect(() => {
    if (!userSummaryOpen || !currentUserMessageIndex) {
      return;
    }
    const list = userSummaryListRef.current;
    const scroller = list?.parentElement;
    const item = list?.querySelector<HTMLElement>(
      `[data-user-summary-index="${currentUserMessageIndex}"]`,
    );
    if (!scroller || !item) {
      return;
    }
    const itemRect = item.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    scroller.scrollTop = Math.max(
      0,
      Math.min(
        maxTop,
        scroller.scrollTop +
          itemRect.top -
          scrollerRect.top -
          scroller.clientHeight / 2 +
          itemRect.height / 2,
      ),
    );
  }, [currentUserMessageIndex, userSummaryOpen]);

  useEffect(() => {
    if (!userSummaryOpen) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      const root = userSummaryRootRef.current;
      if (!root || root.contains(event.target as Node)) {
        return;
      }
      setUserSummaryPinnedOpen(false);
      setUserSummaryHoverOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [userSummaryOpen]);

  useEffect(() => {
    return () => {
      Object.values(copyResetTimersRef.current).forEach((timer) =>
        window.clearTimeout(timer),
      );
      copyResetTimersRef.current = {};
      if (targetSeqFrameRef.current !== null) {
        window.cancelAnimationFrame(targetSeqFrameRef.current);
        targetSeqFrameRef.current = null;
      }
      if (viewportStickFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportStickFrameRef.current);
        viewportStickFrameRef.current = null;
      }
      targetSeqTimerRefs.current.forEach((timer) => window.clearTimeout(timer));
      targetSeqTimerRefs.current = [];
      sessionStickSettleTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      sessionStickSettleTimersRef.current = [];
      releaseReadingAnchor();
    };
  }, [releaseReadingAnchor]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    if (!scrollEndRef.current) {
      return;
    }
    const loadingFinished = previousLoadingRef.current && !loading;
    previousLoadingRef.current = loading;
    const nextKey = sessionKey;
    const isSessionChanged = lastSessionKeyRef.current !== nextKey;
    if (isSessionChanged) {
      lastSessionKeyRef.current = nextKey;
      resumeFollowing();
    }
    if (isSessionChanged || loadingFinished) {
      scheduleSessionStickSettle();
    }
    if (shouldStickToBottomRef.current) {
      stickSessionToBottom("auto");
    }
  }, [
    sessionKey,
    timeline,
    isStreaming,
    streamVersion,
    slashCommandResult,
    loading,
    resumeFollowing,
  ]);

  // A turn finishes in two steps: the stream flag flips, then the App
  // re-syncs the persisted exchanges (which can remove or re-key rows above
  // the reader). Capture the row at the top of the viewport while the layout
  // still matches what the reader sees, then hold its screen offset across the
  // completion updates.
  useLayoutEffect(() => {
    const sessionChanged = previousCompletionSessionRef.current !== sessionKey;
    previousCompletionSessionRef.current = sessionKey;
    const wasStreaming = previousStreamingRef.current;
    const wasAwaiting = previousAwaitingRef.current;
    previousStreamingRef.current = isStreaming;
    previousAwaitingRef.current = isAwaiting;
    const completed =
      !sessionChanged &&
      ((wasStreaming && !isStreaming) || (wasAwaiting && !isAwaiting));
    if (!completed) {
      if (sessionChanged) {
        liveReadingAnchorRef.current = null;
        releaseReadingAnchor();
      }
      return;
    }
    if (shouldStickToBottomRef.current) {
      releaseReadingAnchor();
      return;
    }
    if (
      readingAnchorRef.current &&
      performance.now() < readingAnchorDeadlineRef.current
    ) {
      return;
    }
    const live = liveReadingAnchorRef.current;
    const anchor =
      live && live.sessionKey === (sessionKey || "")
        ? live
        : captureReadingAnchor();
    if (!anchor) {
      return;
    }
    readingAnchorRef.current = anchor;
    readingAnchorDeadlineRef.current = performance.now() + 2000;
    if (readingAnchorFrameRef.current === null) {
      // Re-resolve now, before this commit paints: the completion update can
      // already have moved the rows above the reader in this commit, and on
      // iOS nothing (Safari has no scroll anchoring) undoes that shift. The
      // frame loop keeps the anchor held while later re-sync commits land.
      holdReadingAnchor();
    }
  }, [
    isStreaming,
    isAwaiting,
    timeline,
    virtualized,
    virtualizer,
    sessionKey,
    captureReadingAnchor,
    holdReadingAnchor,
    releaseReadingAnchor,
  ]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof window === "undefined") {
      return;
    }
    const queueStickToBottom = () => {
      if (!shouldStickToBottomRef.current) {
        return;
      }
      if (viewportStickFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportStickFrameRef.current);
      }
      viewportStickFrameRef.current = window.requestAnimationFrame(() => {
        viewportStickFrameRef.current = null;
        if (!shouldStickToBottomRef.current) {
          return;
        }
        stickSessionToBottom("auto");
      });
    };
    window.visualViewport?.addEventListener("resize", queueStickToBottom);
    window.visualViewport?.addEventListener("scroll", queueStickToBottom);
    window.addEventListener("mindfs:safe-area-updated", queueStickToBottom as EventListener);
    return () => {
      window.visualViewport?.removeEventListener("resize", queueStickToBottom);
      window.visualViewport?.removeEventListener("scroll", queueStickToBottom);
      window.removeEventListener("mindfs:safe-area-updated", queueStickToBottom as EventListener);
      if (viewportStickFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportStickFrameRef.current);
        viewportStickFrameRef.current = null;
      }
    };
  }, [sessionKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      resumeFollowing();
      return;
    }
    let lastScrollTop = el.scrollTop;
    let lastScrollHeight = el.scrollHeight;
    let touchY: number | null = null;
    let touchStartedInNestedScroller = false;
    let settleTimer: number | null = null;
    // Finger jitter and sub-pixel scroll positions can leave a few pixels of
    // slack at the tail; treat that as bottom rather than pausing following.
    const bottomSlop = 8;
    const atBottom = () => el.scrollHeight - el.clientHeight - el.scrollTop <= bottomSlop;
    // The content reserves tall space below the last row for the floating
    // jump/task controls (SESSION_TAIL_CONTROLS_*). A reader who scrolled down
    // until the newest message is fully visible is still that far from the
    // scrollable bottom; requiring the hard bottom here stranded them: later
    // streamed chunks landed below the viewport and only the jump button
    // could recover following. The end marker sits after all content.
    const tailEndVisible = () => {
      const end = scrollEndRef.current;
      if (!end) {
        return false;
      }
      return (
        end.getBoundingClientRect().top <=
        el.getBoundingClientRect().bottom + 8
      );
    };
    // Does an ancestor between the event target and the transcript own this
    // gesture? Scrolling an expanded tool result or another nested scroller
    // says nothing about the reader's position in the transcript.
    const hasNestedVerticalScroller = (target: EventTarget | null): boolean => {
      let node = target instanceof Element ? target : null;
      while (node && node !== el) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 1
        ) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    };
    const wheelHitsNestedScroller = (
      target: EventTarget | null,
      deltaY: number,
    ): boolean => {
      let node = target instanceof Element ? target : null;
      while (node && node !== el) {
        const overflowY = window.getComputedStyle(node).overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight + 1
        ) {
          const maxTop = node.scrollHeight - node.clientHeight;
          if (deltaY < 0 ? node.scrollTop > 1 : node.scrollTop < maxTop - 1) {
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    };
    const resumeFollowingAtBottom = () => {
      let strayOrGrowth = false;
      if (!atBottom()) {
        // An expanded card or a summary/search jump is a deliberate stop;
        // only the reader's own return gesture may resume following.
        if (intentionalPauseRef.current) {
          return;
        }
        // A gesture that never moved the view away from the pause origin is
        // not a reading pause — a tap's finger drift, or streamed growth
        // pushing the tail down while the finger rested. Re-arm regardless of
        // where the content end is now; requiring it to still be visible
        // stranded following until the jump button was clicked. A gesture
        // that did move up only returns through an explicit downward gesture
        // that brings the tail back in view.
        const movedUpSincePause =
          el.scrollTop < pauseOriginTopRef.current - bottomSlop;
        if (movedUpSincePause) {
          const returnedDown =
            performance.now() - lastDownwardIntentAtRef.current < 600;
          if (!returnedDown || !isNearSessionTail()) {
            return;
          }
        } else if (touchPauseRef.current) {
          // A finger that never moved the transcript was a tap, not a reading
          // gesture; streamed growth may have pushed the tail away in the
          // meantime, but following must continue.
          strayOrGrowth = true;
        } else if (!isNearSessionTail()) {
          return;
        }
      }
      resumeFollowing();
      releaseReadingAnchor();
      if (strayOrGrowth) {
        // The viewport never left the tail; it only lagged behind streamed
        // growth. Catch up now instead of waiting for the next chunk, which
        // would otherwise leave the newest lines below the fold with no jump
        // button to recover them.
        stickSessionToBottom("auto");
      }
    };
    const settleFollowing = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        resumeFollowingAtBottom();
      }, 150);
    };
    const pauseFollowing = (fromTouch: boolean) => {
      if (!userPausedFollowingRef.current) {
        pauseOriginTopRef.current = el.scrollTop;
        intentionalPauseRef.current = false;
        touchPauseRef.current = fromTouch;
      }
      shouldStickToBottomRef.current = false;
      userPausedFollowingRef.current = true;
      // A fresh gesture owns the viewport; don't fight it with a pending
      // layout-swap or completion-anchor restore.
      pendingScrollRestoreRef.current = null;
      releaseReadingAnchor();
      // Touching or wheeling at the tail can pause following without moving
      // the view. Only surface the jump button once the content is away from
      // the bottom.
      setShowJumpToLatest(!atBottom());
      cancelTargetSeqScroll();
      if (viewportStickFrameRef.current !== null) {
        window.cancelAnimationFrame(viewportStickFrameRef.current);
        viewportStickFrameRef.current = null;
      }
      liveReadingAnchorRef.current = captureReadingAnchor();
      // Re-check after the gesture settles so a jittery or lateral swipe at
      // the tail does not strand following in the paused state.
      settleFollowing();
    };
    const onWheel = (event: WheelEvent) => {
      releaseReadingAnchor();
      if (wheelHitsNestedScroller(event.target, event.deltaY)) {
        return;
      }
      if (event.deltaY < 0) {
        pauseFollowing(false);
      } else if (event.deltaY > 0) {
        lastDownwardIntentAtRef.current = performance.now();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      releaseReadingAnchor();
      touchStartedInNestedScroller =
        event.touches.length === 1 &&
        hasNestedVerticalScroller(event.target);
      touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches.length === 1 ? event.touches[0].clientY : null;
      if (touchY !== null && nextY !== null) {
        const fingerDelta = nextY - touchY;
        // Moving the finger down scrolls toward older messages. Ignore
        // sub-pixel jitter and mostly lateral swipes.
        if (fingerDelta >= 2) {
          if (!touchStartedInNestedScroller) pauseFollowing(true);
        } else if (fingerDelta <= -2) {
          lastDownwardIntentAtRef.current = performance.now();
        }
      }
      touchY = nextY;
    };
    const onTouchEnd = () => {
      touchY = null;
      touchStartedInNestedScroller = false;
    };
    const updateStickiness = (event?: Event) => {
      // Scroll events captured from nested scrollers (expanded tool output,
      // code blocks) are not transcript movement. Treating them as such
      // re-armed tail-following while the reader scrolled inside an expanded
      // card, and the next stream update yanked the transcript to the tail.
      if (event && event.target !== el) return;
      const viewportGap = window.visualViewport
        ? window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop
        : 0;
      const rawDistanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      const distanceFromBottom = Math.max(0, rawDistanceFromBottom - viewportGap);
      const isNearBottom = distanceFromBottom < 40;
      const movedUp = el.scrollTop < lastScrollTop;
      const movedDown = el.scrollTop > lastScrollTop;
      const contentShrank = el.scrollHeight < lastScrollHeight;
      // The virtualizer keeps the reading position stable by writing scrollTop
      // when row heights are corrected. On iOS those writes are deferred and
      // applied in a burst after a tap/scroll, which can look like an upward
      // reading gesture and stop following right after a session opens.
      const virtualizerWrite = virtualizerScrollWriteRef.current;
      const measurementAdjusted =
        virtualizerWrite.at > 0 &&
        performance.now() - virtualizerWrite.at < 200 &&
        Math.abs(el.scrollTop - virtualizerWrite.offset) <= 2;
      const anchorWrite = readingAnchorWriteRef.current;
      const anchorAdjusted =
        anchorWrite.at > 0 &&
        performance.now() - anchorWrite.at < 200 &&
        Math.abs(el.scrollTop - anchorWrite.offset) <= 2;
      // iOS momentum keeps scrolling for far longer than the wheel/touch
      // intent window. While those scroll events keep moving down, the
      // return gesture is still in progress: refresh the intent so an
      // expired timestamp cannot strand a fling that decays inside the
      // reserved tail padding.
      if (
        movedDown &&
        performance.now() - lastDownwardIntentAtRef.current < 600
      ) {
        lastDownwardIntentAtRef.current = performance.now();
      }
      // Any movement that is neither a virtualizer height correction, the
      // completion anchor write, nor a document shrink/clamp came from the
      // reader (a scrollbar drag emits no wheel/touch event). Stop pinning
      // the reading anchor.
      if (
        (movedUp || movedDown) &&
        !contentShrank &&
        !measurementAdjusted &&
        !anchorAdjusted
      ) {
        releaseReadingAnchor();
      }
      // The tail wins over direction: an iOS overscroll bounce reports upward
      // movement while the view is still at (or beyond) the bottom, and the
      // bounce must not pause following or surface the jump button. Resuming
      // here also hides the button as soon as the bounce returns to the tail
      // instead of waiting for the settle timer. An explicit reading pause is
      // the exception: a streamed append can land while the viewport is still
      // inside the slop, and re-arming here would drag the reader down.
      // The content end being visible counts as the tail too: a non-explicit
      // upward movement there (virtualizer/layout correction) must not latch
      // following off while the newest message is on screen.
      // The tail also ends an intentional pause (expanded card, summary or
      // search jump). Merging or collapsing the expanded rows *shrinks* the
      // content and brings its end back into view without a gesture; the jump
      // button hides below its 40px threshold at the same time, so keeping
      // following off there would be an invisible pause. Growth must not end
      // it: a short expanded card sits inside the reserved tail area while the
      // reply streams, and re-arming there dragged a slow upward drag back
      // down on every chunk. Reading gestures keep their pause too.
      if (
        (!userPausedFollowingRef.current &&
          (rawDistanceFromBottom <= bottomSlop ||
            (!shouldStickToBottomRef.current && tailEndVisible()))) ||
        (intentionalPauseRef.current &&
          contentShrank &&
          isNearSessionTail())
      ) {
        resumeFollowing();
      } else if (movedUp && !contentShrank) {
        // Upward motion wins outside the tail threshold. Stationary
        // measurements must not resume following after a wheel/touch gesture.
        // Measuring a virtual row can shrink the document and clamp scrollTop;
        // that is not an upward reading gesture. Growth is different: a
        // scrollbar/keyboard scroll while the reply streams must still pause
        // following, or the next chunk (for example the context stats) drags
        // the viewport back to the tail. The virtualizer's own height
        // corrections are not a reading gesture either.
        if (!measurementAdjusted) {
          pendingScrollRestoreRef.current = null;
          shouldStickToBottomRef.current = false;
        }
      } else if (
        movedDown &&
        (isNearBottom ||
          (performance.now() - lastDownwardIntentAtRef.current < 600 &&
            isNearSessionTail()))
      ) {
        // Scrolling back toward the tail is an explicit return gesture.
        // Clear the pause guard so the tail-slop rule can re-arm following.
        // The visible content end is enough even when the reserved controls
        // padding below it is still unscrolled (wheel down / finger up).
        resumeFollowing();
      }
      setShowJumpToLatest(
        !shouldStickToBottomRef.current && !atBottom(),
      );
      refreshCurrentUserMessageIndexRef.current();
      if (!shouldStickToBottomRef.current) {
        liveReadingAnchorRef.current = captureReadingAnchor();
      }
      lastScrollTop = el.scrollTop;
      lastScrollHeight = el.scrollHeight;
      lastKnownScrollTopRef.current = el.scrollTop;
      // Safety net for pauses that never produce another scroll event;
      // scroll events at the tail already resume following above.
      settleFollowing();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(
          event.key,
        )
      ) {
        releaseReadingAnchor();
      }
    };
    updateStickiness();
    // Observe intent and position before virtualizer scroll callbacks rerender.
    const options = { passive: true, capture: true };
    el.addEventListener("scroll", updateStickiness, options);
    el.addEventListener("wheel", onWheel, options);
    el.addEventListener("touchstart", onTouchStart, options);
    el.addEventListener("touchmove", onTouchMove, options);
    el.addEventListener("touchend", onTouchEnd, options);
    el.addEventListener("touchcancel", onTouchEnd, options);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      el.removeEventListener("scroll", updateStickiness, true);
      el.removeEventListener("wheel", onWheel, true);
      el.removeEventListener("touchstart", onTouchStart, true);
      el.removeEventListener("touchmove", onTouchMove, true);
      el.removeEventListener("touchend", onTouchEnd, true);
      el.removeEventListener("touchcancel", onTouchEnd, true);
      window.removeEventListener("keydown", onKeyDown, true);
      releaseReadingAnchor();
    };
  }, [
    sessionKey,
    isNearSessionTail,
    captureReadingAnchor,
    releaseReadingAnchor,
    resumeFollowing,
  ]);

  // Row content can grow after the timeline render that triggered the tail
  // follow: Markdown highlights, images, diagrams, code blocks and streamed
  // chunks all settle a frame or more later. For a short first conversation
  // (no virtualizer scroll-body events) nothing re-asserted the bottom, so the
  // rest of the reply landed below the viewport. The same growth while the
  // reader is paused must surface the jump button instead of waiting for a
  // scroll event that never comes.
  useEffect(() => {
    const container = scrollRef.current;
    const content = scrollEndRef.current?.parentElement?.parentElement;
    if (
      !container ||
      !content ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    let frame: number | null = null;
    // Content height as of the previous observation. Only a shrink may end an
    // intentional pause: streamed growth below a short expanded card also
    // leaves the reader near the tail, and re-arming there followed the
    // growth, dragging slow upward drags back down chunk by chunk.
    let lastContentHeight = content.getBoundingClientRect().height;
    const update = () => {
      frame = null;
      const contentHeight = content.getBoundingClientRect().height;
      const contentShrank = contentHeight < lastContentHeight - 1;
      lastContentHeight = contentHeight;
      const distanceFromBottom =
        container.scrollHeight - container.clientHeight - container.scrollTop;
      if (shouldStickToBottomRef.current) {
        const maxTop = Math.max(
          0,
          container.scrollHeight - container.clientHeight,
        );
        lastKnownScrollTopRef.current = maxTop;
        container.scrollTo({ top: maxTop, behavior: "auto" });
        setShowJumpToLatest((prev) => (prev ? false : prev));
        return;
      }
      // A layout shrink can bring the reader back to the tail without a
      // scroll event. Re-arm following like the scroll handler does, unless
      // the reader explicitly paused there. An intentional pause (expanded
      // card, summary/search jump) ends there only on a shrink: a
      // merge/collapse hides the jump button at the tail, so keeping
      // following off would be an invisible pause, while streamed growth
      // must leave the deliberate pause alone.
      if (
        (distanceFromBottom <= 8 && !userPausedFollowingRef.current) ||
        (intentionalPauseRef.current && contentShrank && isNearSessionTail())
      ) {
        resumeFollowing();
        return;
      }
      setShowJumpToLatest((prev) => {
        const next = distanceFromBottom > 40;
        return prev === next ? prev : next;
      });
    };
    const observer = new ResizeObserver(() => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(update);
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [sessionKey, isNearSessionTail]);

  // The composer growing (multi-line draft) or the iOS keyboard opening
  // resizes the transcript without adding timeline content. While the reader
  // is following the tail, re-assert the bottom; otherwise the newest lines
  // stay hidden behind the input until the next streamed chunk.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (!shouldStickToBottomRef.current) {
        return;
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        if (shouldStickToBottomRef.current) {
          stickSessionToBottom("auto");
        }
      });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [sessionKey]);

  useEffect(() => {
    if (!targetSeq) {
      targetSeqScrollKeyRef.current = "";
      return;
    }
    const scrollKey = `${sessionKey || ""}:${targetSeq}:${targetSeqRequestKey}`;
    if (targetSeqScrollKeyRef.current === scrollKey) {
      return;
    }
    const container = scrollRef.current;
    if (!container || !timeline.length) {
      return;
    }
    if (virtualized) {
      const index = timelineNavigation.seqIndices.get(targetSeq);
      if (index === undefined) return;
      targetSeqScrollKeyRef.current = scrollKey;
      intentionalPauseRef.current = true;
      touchPauseRef.current = false;
      shouldStickToBottomRef.current = false;
      userPausedFollowingRef.current = true;
      releaseReadingAnchor();
      cancelTargetSeqScroll();
      virtualizer.scrollToIndex(index, { align: "center" });
      setShowJumpToLatest(true);
      return;
    }
    const node = container.querySelector<HTMLElement>(
      `[data-session-seq="${targetSeq}"]`,
    );
    if (!node) {
      return;
    }
    targetSeqScrollKeyRef.current = scrollKey;
    intentionalPauseRef.current = true;
    touchPauseRef.current = false;
    shouldStickToBottomRef.current = false;
    userPausedFollowingRef.current = true;
    releaseReadingAnchor();
    cancelTargetSeqScroll();
    const scrollToNode = () => {
      const latestContainer = scrollRef.current;
      const latestNode = latestContainer?.querySelector<HTMLElement>(
        `[data-session-seq="${targetSeq}"]`,
      );
      if (!latestContainer || !latestNode) {
        return;
      }
      shouldStickToBottomRef.current = false;
      const nextTop = Math.max(
        0,
        latestNode.offsetTop -
          latestContainer.clientHeight / 2 +
          latestNode.offsetHeight / 2,
      );
      latestContainer.scrollTo({ top: nextTop, behavior: "auto" });
    };
    targetSeqFrameRef.current = window.requestAnimationFrame(() => {
      targetSeqFrameRef.current = window.requestAnimationFrame(() => {
        targetSeqFrameRef.current = null;
        scrollToNode();
      });
    });
    [80, 220, 480].forEach((delay) => {
      const timer = window.setTimeout(() => {
        targetSeqTimerRefs.current = targetSeqTimerRefs.current.filter(
          (item) => item !== timer,
        );
        if (targetSeqScrollKeyRef.current !== scrollKey) {
          return;
        }
        scrollToNode();
      }, delay);
      targetSeqTimerRefs.current.push(timer);
    });
  }, [sessionKey, targetSeq, targetSeqRequestKey, timeline, virtualized, virtualizer, timelineNavigation]);

  const rawRelated = session?.related_files || (session as any)?.outputs || [];
  const relatedFiles = (Array.isArray(rawRelated) ? rawRelated : [])
    .map((f: any) => {
      const path =
        typeof f === "string" ? f : typeof f?.path === "string" ? f.path : "";
      const name =
        typeof f?.name === "string" ? f.name : path.split("/").pop() || path;
      const head =
        typeof f !== "string" && typeof f?.head === "string" ? f.head : "";
      const repoPath =
        typeof f !== "string" && typeof f?.repo_path === "string"
          ? f.repo_path
          : "";
      const repoName =
        typeof f !== "string" && typeof f?.repo_name === "string"
          ? f.repo_name
          : repoPath.split(/[\\/]/).filter(Boolean).pop() || "";
      const repoKind =
        typeof f !== "string" && typeof f?.repo_kind === "string"
          ? f.repo_kind
          : "";
      const rootID =
        typeof f !== "string" && typeof f?.root_id === "string"
          ? f.root_id
          : "";
      return { path, name, head, repo_path: repoPath, repo_name: repoName, repo_kind: repoKind, root_id: rootID };
    })
    .filter((f) => f.path);
  const activeAskUserCallId = (() => {
    if (!isAwaiting) {
      return "";
    }
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const item = timeline[i];
      if (item.type === "user_text" || item.type === "assistant_text") {
        return "";
      }
      if (item.type !== "tool") continue;
      const toolCall = item.toolCall || {};
      const kind = `${toolCall.kind || ""}`.toLowerCase();
      const status = `${toolCall.status || ""}`.toLowerCase();
      if (kind !== "ask_user") continue;
      if (
        status !== "running" &&
        status !== "pending" &&
        status !== "in_progress"
      ) {
        continue;
      }
      if (getAskUserQuestions(toolCall).length === 0) continue;
      return (
        toolCall.callId ||
        (typeof toolCall.meta?.toolUseId === "string"
          ? toolCall.meta.toolUseId
          : "")
      );
    }
    return "";
  })();
  const defaultRelatedFilesCollapsed = shouldDefaultCollapseRelatedFiles(
    isMobile,
    relatedFiles.length,
  );
  const relatedFilesDefaultStateKey = `${sessionKey || ""}:${isMobile ? "mobile" : "desktop"}:${defaultRelatedFilesCollapsed ? "collapsed" : "expanded"}`;

  useEffect(() => {
    if (relatedFilesDefaultStateRef.current === relatedFilesDefaultStateKey) {
      return;
    }
    relatedFilesDefaultStateRef.current = relatedFilesDefaultStateKey;
    setRelatedFilesCollapsed(defaultRelatedFilesCollapsed);
  }, [defaultRelatedFilesCollapsed, relatedFilesDefaultStateKey]);

  if (!session) {
    return (
      <div
        style={{
          padding: "40px",
          textAlign: "center",
          color: "var(--text-secondary)",
        }}
      >
        {t("session.empty")}
      </div>
    );
  }

  const displayFiles = relatedFiles;
  const displayFileGroups = (() => {
    const currentRootPath = String(rootPath || "").replace(/[\\/]+$/, "");
    const repoGroups = displayFiles.reduce<
      Array<{
        key: string;
        repoPath: string;
        repoName: string;
        repoKind: string;
        headGroups: Array<{ key: string; head: string; files: typeof displayFiles }>;
      }>
    >((groups, file) => {
    const head = file.head || "";
    const rawRepoPath = file.repo_path || "";
    const normalizedRepoPath = String(rawRepoPath || "").replace(/[\\/]+$/, "");
    const isCurrentRepoRecord =
      !rawRepoPath ||
      file.repo_name === t("session.currentProject") ||
      (!!currentRootPath && normalizedRepoPath === currentRootPath);
    const repoPath = isCurrentRepoRecord ? "" : rawRepoPath;
    const rawRepoKind = file.repo_kind || "";
    const repoKind = isCurrentRepoRecord && rawRepoKind !== "plain" && rawRepoKind !== "svn"
      ? ""
      : rawRepoKind;
    const repoKey = `${repoKind}\0${repoPath}`;
    let repoGroup = groups.find((group) => group.key === repoKey);
    if (!repoGroup) {
      repoGroup = {
        key: repoKey,
        repoPath,
        repoName: isCurrentRepoRecord
          ? t("session.currentProject")
          : file.repo_name || repoPath.split(/[\\/]/).filter(Boolean).pop() || t("session.currentProject"),
        repoKind,
        headGroups: [],
      };
      groups.push(repoGroup);
    }
    const headKey = `${repoKey}\0${head}`;
    const existing = repoGroup.headGroups.find((group) => group.key === headKey);
    if (existing) {
      existing.files.push(file);
    } else {
      repoGroup.headGroups.push({
        key: headKey,
        head,
        files: [file],
      });
    }
    return groups;
    }, []);
    return repoGroups.flatMap((repoGroup) =>
      repoGroup.headGroups.map((headGroup) => ({
        key: headGroup.key,
        head: headGroup.head,
        repoPath: repoGroup.repoPath,
        repoName: repoGroup.repoName,
        repoKind: repoGroup.repoKind,
        files: headGroup.files,
      })),
    );
  })();
  const displayName =
    session.name ||
    session.purpose ||
    session.key ||
    session.session_key ||
    "Session";
  const hasVisibleTimeline = timeline.length > 0;
  const userMetaButtonStyle: React.CSSProperties = {
    width: "18px",
    height: "18px",
    border: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    color: "#2563eb",
    cursor: "pointer",
    fontSize: "14px",
    fontWeight: 800,
    lineHeight: 1,
    opacity: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "6px",
    flexShrink: 0,
  };

  const makePromptKey = (
    item: Extract<TimelineItem, { type: "user_text" | "assistant_text" }>,
  ): string =>
    `${item.id}\n${item.timestamp || ""}\n${item.content || ""}`;

  const renderTimelineItem = (
    item: TimelineItem,
    idx: number,
    spacing: string = "0",
  ) => {
    const timelineItemKey = `${rootId}:${sessionKey}:${item.id || `${item.type}-${idx}`}`;
    if (item.type === "thought") {
      const thoughtCacheKey =
        item.thoughtId && !duplicatedThoughtIds.has(item.thoughtId)
          ? `thought:${item.thoughtId}`
          : `thought:${timelineItemKey}`;
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <ThinkingBlock
            content={item.content || ""}
            defaultExpanded={toolViewCache.expanded.get(thoughtCacheKey) ?? false}
            onExpandedChange={(expanded) => {
              toolViewCache.expanded.set(thoughtCacheKey, expanded);
              if (expanded) pauseSessionFollowing();
            }}
          />
        </div>
      );
    }
    if (item.type === "tool") {
      const tc = item.toolCall || {};
      const isAskUser =
        `${tc.kind || ""}`.toLowerCase() === "ask_user" &&
        getAskUserQuestions(tc).length > 0;
      const isUserShell =
        `${tc.kind || ""}`.toLowerCase() === "execute" &&
        tc.meta?.source === "userShell";
      const toolUseId =
        tc.callId ||
        (typeof tc.meta?.toolUseId === "string" ? tc.meta.toolUseId : "");
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          {isAskUser ? (
            <AskUserQuestionCard
              toolCall={tc}
              rootId={rootId}
              sessionKey={sessionKey}
              agent={session?.agent}
              active={!!toolUseId && toolUseId === activeAskUserCallId}
              onAnswer={onAskUserAnswer}
            />
          ) : (
            <ToolCallCard
              kind={tc.kind}
              title={
                (tc as any).title ||
                (tc.meta && typeof tc.meta.title === "string"
                  ? (tc.meta.title as string)
                  : "")
              }
              callId={tc.callId || ""}
              status={tc.status || "running"}
              content={tc.content}
              getFallbackResult={formatToolCallFallbackResult}
              viewCache={toolViewCache}
              viewCacheKey={
                tc.callId && !duplicatedToolCallIds.has(tc.callId)
                  ? `tool:${tc.callId}`
                  : timelineItemKey
              }
              locations={tc.locations}
              meta={tc.meta}
              rootPath={rootPath || undefined}
              rootId={rootId}
              sessionKey={sessionKey}
              defaultExpanded={isUserShell}
              onExpand={pauseSessionFollowing}
            />
          )}
        </div>
      );
    }
    if (item.type === "todo") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <TodoUpdateCard todoUpdate={item.todoUpdate} />
        </div>
      );
    }
    if (item.type === "tasks") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <TaskListCard tasksUpdate={item.tasksUpdate} />
        </div>
      );
    }
    if (item.type === "plan") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <PlanUpdateCard content={item.planUpdate?.content || ""} rootId={rootId} />
        </div>
      );
    }
    if (item.type === "compact") {
      return (
        <div key={timelineItemKey} style={{ marginTop: spacing }}>
          <CompactNoticeCard
            status={item.compactNotice?.status}
            summary={item.compactNotice?.summary}
          />
        </div>
      );
    }
    const isUser = item.type === "user_text";
    const userMessageIndex = isUser
      ? timelineNavigation.rows[idx].userIndex
      : undefined;
    const next = idx + 1 < timeline.length ? timeline[idx + 1] : null;
    const hasFollowingAssistantFlow =
      !isUser && !!next && next.type !== "user_text";
    const hideAssistantMeta =
      !isUser &&
      (hasFollowingAssistantFlow ||
        (isStreaming && idx === timeline.length - 1));
    const time = formatTime(item.timestamp, locale);
    const uploadAttachments = isUser
      ? extractUploadAttachments(item.content || "")
      : [];
    const imageAttachments = uploadAttachments.filter(
      (attachment) => attachment.isImage,
    );
    const displayContent = isUser
      ? stripImageAttachmentTokens(item.content || "")
      : item.content || "";
    const promptSaveContent = isUser
      ? stripUploadAttachmentTokens(item.content || "")
      : "";
    const promptKey = makePromptKey(item);
    const promptSaved = !!savedPromptKeys[promptKey];
    const copySucceeded = !!copiedMessageKeys[promptKey];
    const userMessageWidth =
      imageAttachments.length > 0 ? "min(320px, 100%)" : "auto";
    const hasRichUserAttachments = imageAttachments.length > 0;
    const assistantMarkdownContent = !isUser ? (item.content || "").trim() : "";
    const assistantExchangeMeta = !isUser
      ? formatAssistantExchangeMeta(item, agents)
      : "";
    const assistantDurationLabel = !isUser
      ? formatSessionDuration(timelineNavigation.rows[idx].previousUserTime, item.timestamp)
      : "";
    // Forking needs a server-assigned seq. Streaming replies only exist in the
    // client cache until the turn is persisted, so their inferred seq would be
    // rejected by the fork endpoint with "message not found".
    const canForkAgentMessage =
      !isUser &&
      item.persisted === true &&
      Number(item.seq || 0) > 0 &&
      !!onForkAgentMessage;
    const canEditInPlace = isUser && idx === latestUserIndex && !item.pendingAck && !!item.timestamp && session?.type === "chat" && !(session as any)?.closed_at;
    const isEditing = isUser && editingMessage?.timestamp === item.timestamp && editingMessage?.original === item.content;
    return (
      <div
        key={timelineItemKey}
        data-session-seq={item.seq || undefined}
        data-user-message-index={userMessageIndex}
        style={{
          marginTop: spacing,
          alignSelf: isUser ? "flex-end" : "flex-start",
          width: isEditing ? "min(560px, 100%)" : isUser ? userMessageWidth : "100%",
          maxWidth: isEditing ? "100%" : isUser ? "80%" : "100%",
          minWidth: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {isUser ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              gap: "6px",
              width: isEditing ? "100%" : userMessageWidth,
              maxWidth: "100%",
              minWidth: 0,
            }}
          >
            {!isEditing && hasRichUserAttachments ? (
              <div
                style={{
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                  padding: "8px",
                  borderRadius: "18px 18px 4px 18px",
                  background: "rgba(148,163,184,0.14)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  boxSizing: "border-box",
                }}
              >
                {imageAttachments.length > 0 ? (
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        imageAttachments.length > 1
                          ? "repeat(2, minmax(0, 1fr))"
                          : "minmax(0, 1fr)",
                      gap: "8px",
                      width: "100%",
                    }}
                  >
                    {imageAttachments.map((attachment) => (
                      <button
                        key={attachment.path}
                        type="button"
                        onClick={() =>
                          onFileClickRef.current?.({ path: attachment.path })
                        }
                        style={{
                          border: "none",
                          padding: 0,
                          background: "transparent",
                          cursor: "pointer",
                          borderRadius: "12px",
                          overflow: "hidden",
                        }}
                        title={attachment.name}
                      >
                        <AttachmentImage
                          rootId={rootId || ""}
                          path={attachment.path}
                          name={attachment.name}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}
                {displayContent ? (
                  <div
                    style={{
                      padding:
                        imageAttachments.length > 0 ? "2px 6px 0" : "6px 8px",
                      color: "var(--text-primary)",
                      fontSize: "14px",
                      lineHeight: "1.5",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      wordBreak: "break-word",
                    }}
                  >
                    <InlineTokenText
                      content={displayContent}
                      isDark={false}
                      variant="inverse"
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {!isEditing && !hasRichUserAttachments && displayContent ? (
              <div
                style={{
                  padding: "10px 16px",
                  borderRadius: "18px 18px 4px 18px",
                  background: "rgba(148,163,184,0.14)",
                  color: "var(--text-primary)",
                  fontSize: "14px",
                  lineHeight: "1.5",
                  boxShadow: "none",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  wordBreak: "break-word",
                  alignSelf: "flex-end",
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                <InlineTokenText
                  content={displayContent}
                  isDark={false}
                  variant="inverse"
                />
              </div>
            ) : null}
            {isEditing && editingMessage ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <textarea autoFocus aria-label={t("session.editMessage")} value={editingMessage.content} disabled={savingEdit}
                  onChange={(event) => setEditingMessage({ ...editingMessage, content: event.target.value })}
                  onCompositionStart={() => { editComposing.current = true; }}
                  onCompositionEnd={() => { editComposing.current = false; }}
                  onKeyDown={(event) => {
                    if (editComposing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    if (event.key === "Escape" && !editSubmitting.current) { event.preventDefault(); setEditingMessage(null); }
                    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitEdit(); }
                  }}
                  rows={3} style={{ width: "100%", boxSizing: "border-box", resize: "vertical", padding: "10px 16px", border: "1px solid var(--border-color, #d1d5db)", borderRadius: "18px 18px 4px 18px", font: "inherit", fontSize: 14, lineHeight: 1.5, color: "var(--text-primary)", background: "rgba(148,163,184,0.14)" }} />
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-secondary, #64748b)" }}><svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" style={{ verticalAlign: "-2px", marginRight: 4 }}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7v1" /></svg>{t("session.editNotice")}</span>
                  <button type="button" disabled={savingEdit} style={{ flexShrink: 0, padding: "2px 8px", fontSize: 12, lineHeight: "16px", borderRadius: 5, border: "1px solid var(--border-color, #d1d5db)", background: "transparent", color: "var(--text-primary)" }} onClick={() => setEditingMessage(null)}>{t("common.cancel")}</button>
                  <button type="button" disabled={savingEdit || !editingMessage.content.trim()} style={{ flexShrink: 0, padding: "2px 8px", fontSize: 12, lineHeight: "16px", borderRadius: 5, border: "1px solid transparent", background: "#2563eb", color: "white", opacity: savingEdit || !editingMessage.content.trim() ? 0.5 : 1 }} onClick={() => void submitEdit()}>{t(savingEdit ? "session.editSaving" : "session.editRegenerate")}</button>
                </div>
                {editError && <span role="alert" style={{ fontSize: 12, color: "var(--text-danger, #dc2626)" }}>{editError}</span>}
              </div>
            ) : null}
            <span
              style={{
                fontSize: "10px",
                color: "var(--text-secondary)",
                alignSelf: "flex-end",
                display: isEditing ? "none" : "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              {item.pendingAck ? (
                <span
                  aria-label={t("session.sending")}
                  style={{
                    width: "8px",
                    height: "8px",
                    border: "1px solid var(--text-secondary)",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "spin 0.8s linear infinite",
                  }}
                />
              ) : null}
              <span style={{ opacity: 0.5 }}>{time}</span>
              <button
                type="button"
                onClick={() => {
                  if (canEditInPlace) {
                    setEditError("");
                    setEditingMessage({ seq: Number(item.seq || 0), original: item.content || "", timestamp: item.timestamp!, content: item.content || "" });
                  } else { onEditUserMessage?.(item.content || ""); }
                }}
                style={userMetaButtonStyle}
                disabled={savingEdit}
                aria-label={t(canEditInPlace ? "session.editMessage" : "session.copyToComposer")}
                title={t(canEditInPlace ? "session.editMessage" : "session.copyToComposer")}
              >
                {renderToolIcon("edit")}
              </button>
              {promptSaved ? (
                <span
                  aria-label={t("session.promptSaved")}
                  title={t("session.promptSaved")}
                  style={{
                    ...userMetaButtonStyle,
                    color: "#2563eb",
                    fontSize: "13px",
                  }}
                >
                  ✓
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    if (!promptSaveContent) {
                      reportError(
                        "file.write_failed",
                        t("session.emptyPromptCannotSave"),
                      );
                      return;
                    }
                    void savePrompt(promptSaveContent)
                      .then(() => {
                        setSavedPromptKeys((prev) => ({
                          ...prev,
                          [promptKey]: true,
                        }));
                      })
                      .catch((err) => {
                        reportError(
                          "file.write_failed",
                          String((err as Error)?.message || t("session.savePromptFailed")),
                        );
                      });
                  }}
                  style={userMetaButtonStyle}
                  aria-label={t("session.addPrompt")}
                  title={t("session.addPrompt")}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      stroke="currentColor"
                      strokeWidth="0.45"
                      strokeLinejoin="round"
                      d="M1.086 5.183A2.5 2.5 0 0 1 2.854 2.12l3.863-1.035A2.5 2.5 0 0 1 9.78 2.854L10.354 5H9.32l-.506-1.888a1.5 1.5 0 0 0-1.837-1.06L3.112 3.087a1.5 1.5 0 0 0-1.06 1.837l1.035 3.864a1.5 1.5 0 0 0 1.837 1.06L5 9.828v1.028a2.5 2.5 0 0 1-2.879-1.81zM8 6a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zM7 8a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1zm4 .5a.5.5 0 0 0-1 0V10H8.5a.5.5 0 0 0 0 1H10v1.5a.5.5 0 0 0 1 0V11h1.5a.5.5 0 0 0 0-1H11z"
                    />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!promptSaveContent) {
                    reportError("clipboard.write_failed", t("session.emptyMessageCannotCopy"));
                    return;
                  }
                  const markCopied = () => {
                    setCopiedMessageKeys((prev) => ({
                      ...prev,
                      [promptKey]: true,
                    }));
                    if (copyResetTimersRef.current[promptKey]) {
                      window.clearTimeout(copyResetTimersRef.current[promptKey]);
                    }
                    copyResetTimersRef.current[promptKey] = window.setTimeout(() => {
                      setCopiedMessageKeys((prev) => {
                        const next = { ...prev };
                        delete next[promptKey];
                        return next;
                      });
                      delete copyResetTimersRef.current[promptKey];
                    }, 1000);
                  };
                  void copyText(promptSaveContent)
                    .then(markCopied)
                    .catch((err) => {
                      reportError(
                        "clipboard.write_failed",
                        String((err as Error)?.message || t("session.copyFailed")),
                      );
                    });
                }}
                style={userMetaButtonStyle}
                aria-label={t("session.copyMessage")}
                title={t("session.copyMessage")}
              >
                {copySucceeded ? (
                  <span
                    aria-hidden="true"
                    style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}
                  >
                    ✓
                  </span>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                    />
                    <path
                      fill="currentColor"
                      d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                    />
                  </svg>
                )}
              </button>
            </span>
          </div>
        ) : (
          <div
            style={{
              width: "100%",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
            }}
          >
            <div
              style={{
                color: "var(--text-primary)",
                fontSize: "15px",
                lineHeight: "1.7",
                width: "100%",
                minWidth: 0,
              }}
            >
              <MarkdownViewer
                content={item.content || ""}
                root={rootId || undefined}
                onFileClick={(path) => onFileClickRef.current?.({ path })}
              />
            </div>
            {!hideAssistantMeta && (
              <span
                style={{
                  alignSelf: "flex-start",
                  display: "inline-flex",
                  flexWrap: "nowrap",
                  alignItems: "center",
                  gap: "8px",
                  maxWidth: "100%",
                  minWidth: 0,
                  fontSize: "10px",
                  color: "var(--text-secondary)",
                  marginTop: "0",
                  marginBottom: "4px",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    flexShrink: 0,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!assistantMarkdownContent) {
                        reportError(
                          "clipboard.write_failed",
                          t("session.emptyMessageCannotCopy"),
                        );
                        return;
                      }
                      void copyText(assistantMarkdownContent)
                        .then(() => {
                          setCopiedMessageKeys((prev) => ({
                            ...prev,
                            [promptKey]: true,
                          }));
                          if (copyResetTimersRef.current[promptKey]) {
                            window.clearTimeout(
                              copyResetTimersRef.current[promptKey],
                            );
                          }
                          copyResetTimersRef.current[promptKey] =
                            window.setTimeout(() => {
                              setCopiedMessageKeys((prev) => {
                                const next = { ...prev };
                                delete next[promptKey];
                                return next;
                              });
                              delete copyResetTimersRef.current[promptKey];
                            }, 1000);
                        })
                        .catch((err) => {
                          reportError(
                            "clipboard.write_failed",
                            String((err as Error)?.message || t("session.copyFailed")),
                          );
                        });
                    }}
                    style={userMetaButtonStyle}
                    aria-label={t("session.copyMarkdown")}
                    title={t("session.copyMarkdown")}
                  >
                    {copySucceeded ? (
                      <span
                        aria-hidden="true"
                        style={{
                          fontSize: "13px",
                          fontWeight: 800,
                          lineHeight: 1,
                        }}
                      >
                        ✓
                      </span>
                    ) : (
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                      >
                        <path
                          fill="currentColor"
                          d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                        />
                        <path
                          fill="currentColor"
                          d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                        />
                      </svg>
                    )}
                  </button>
                  {canForkAgentMessage ? (
                    <ForkSessionButton
                      onFork={(independent) => {
                        const seq = Number(item.seq || 0);
                        if (seq > 0) {
                          void onForkAgentMessage?.(seq, independent);
                        }
                      }}
                      style={userMetaButtonStyle}
                    >
                      <ForkIcon />
                    </ForkSessionButton>
                  ) : null}
                  {visibleReplyInfo.agent && <AgentIcon
                    agentName={item.agent || ""}
                    style={{ width: "12px", height: "12px", flexShrink: 0, opacity: 0.5 }}
                  />}
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    flex: "1 1 auto",
                    flexWrap: "wrap",
                    alignItems: "center",
                    gap: "0 8px",
                    minWidth: 0,
                    lineHeight: "16px",
                    opacity: 0.5,
                  }}
                >
                  {visibleReplyInfo.model && assistantExchangeMeta ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        minHeight: "16px",
                        minWidth: 0,
                        maxWidth: "100%",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {assistantExchangeMeta}
                    </span>
                  ) : null}
                  {visibleReplyInfo.tokens && <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: "16px",
                      minWidth: 0,
                      maxWidth: "100%",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <TurnTokenUsage usage={item.tokenUsage} totalUsage={cumulativeTokenUsage[idx]} />
                  </span>}
                  {visibleReplyInfo.time && <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: "16px",
                      minWidth: 0,
                      maxWidth: "100%",
                      fontVariantNumeric: "tabular-nums",
                      overflowWrap: "anywhere",
                    }}
                  >
                    {time}{assistantDurationLabel}
                  </span>}
                  {visibleReplyInfo.context && <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: "16px",
                      minWidth: 0,
                      maxWidth: "100%",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <ContextWindowBadge contextWindow={item.contextWindow} />
                  </span>}
                </span>
                {isMobile && idx === latestCompletedReplyIndex && (
                  <ReplyInfoMenu key={sessionKey} preferences={replyInfoPreferences} />
                )}
              </span>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderSlashCommandResult = () => {
    if (!slashCommandResult) {
      return null;
    }
    const commandLabel = `/${slashCommandResult.command || "status"}`;
    const loginNotice = slashCommandResult.loginNotice;
    const isLogin = (slashCommandResult.command || "") === "login";
    const content =
      slashCommandResult.error ||
      loginNotice?.error ||
      slashCommandResult.content ||
      (slashCommandResult.status === "running"
        ? isLogin
          ? t("session.loginWaiting")
          : t("session.statusFetching")
        : "");
    const loginCodeCopyKey = loginNotice?.loginId
      ? `login-code:${loginNotice.loginId}`
      : `login-code:${slashCommandResult.sessionKey}`;
    const loginCodeCopied = !!copiedMessageKeys[loginCodeCopyKey];
    return (
      <div
        style={{
          marginTop: hasVisibleTimeline ? "18px" : "0",
          width: "100%",
          boxSizing: "border-box",
          border: "1px solid rgba(148,163,184,0.36)",
          background: "rgba(148,163,184,0.10)",
          borderRadius: "8px",
          padding: "10px 12px",
          color: "var(--text-primary)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
            marginBottom: content ? "6px" : 0,
            fontSize: "11px",
            lineHeight: 1.4,
            color: "var(--text-secondary)",
          }}
        >
          <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
            {commandLabel}
          </span>
          <span>
            {slashCommandResult.status === "running"
              ? t("session.statusRunning")
              : slashCommandResult.status === "failed"
                ? t("session.statusFailed")
                : t("session.statusComplete")}
          </span>
        </div>
        {isLogin && loginNotice?.userCode ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              fontSize: "13px",
              lineHeight: 1.5,
            }}
          >
            {loginNotice.verificationUrl ? (
              <a
                href={loginNotice.verificationUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)", overflowWrap: "anywhere" }}
              >
                {loginNotice.verificationUrl}
              </a>
            ) : null}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                  fontSize: "20px",
                  letterSpacing: "0",
                  color: "var(--text-primary)",
                }}
              >
                {loginNotice.userCode}
              </span>
              <button
                type="button"
                onClick={() => {
                  const userCode = loginNotice.userCode || "";
                  if (!userCode) {
                    reportError("clipboard.write_failed", t("session.emptyCodeCannotCopy"));
                    return;
                  }
                  void copyText(userCode)
                    .then(() => {
                      setCopiedMessageKeys((prev) => ({
                        ...prev,
                        [loginCodeCopyKey]: true,
                      }));
                      if (copyResetTimersRef.current[loginCodeCopyKey]) {
                        window.clearTimeout(
                          copyResetTimersRef.current[loginCodeCopyKey],
                        );
                      }
                      copyResetTimersRef.current[loginCodeCopyKey] =
                        window.setTimeout(() => {
                          setCopiedMessageKeys((prev) => {
                            const next = { ...prev };
                            delete next[loginCodeCopyKey];
                            return next;
                          });
                          delete copyResetTimersRef.current[loginCodeCopyKey];
                        }, 1000);
                    })
                    .catch((err) => {
                      reportError(
                        "clipboard.write_failed",
                        String((err as Error)?.message || t("session.copyFailed")),
                      );
                    });
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "22px",
                  height: "22px",
                  border: "none",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  borderRadius: "6px",
                  padding: 0,
                  cursor: "pointer",
                }}
                aria-label={loginCodeCopied ? t("session.codeCopied") : t("session.copyCode")}
                title={loginCodeCopied ? t("session.copied") : t("session.copyCode")}
              >
                {loginCodeCopied ? (
                  <span
                    aria-hidden="true"
                    style={{ fontSize: "13px", fontWeight: 800, lineHeight: 1 }}
                  >
                    ✓
                  </span>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <path
                      fill="currentColor"
                      d="M20 2H10c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m0 12H10V4h10z"
                    />
                    <path
                      fill="currentColor"
                      d="M14 20H4V10h2V8H4c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2v-2h-2z"
                    />
                  </svg>
                )}
              </button>
            </div>
            {slashCommandResult.status === "complete" ? (
              <div style={{ color: "var(--text-secondary)" }}>
                {t("session.loginComplete")}
                {loginNotice.planType ? ` · ${loginNotice.planType}` : ""}
              </div>
            ) : null}
          </div>
        ) : content ? (
          <div
            style={{
              fontSize: "13px",
              lineHeight: "1.6",
              minWidth: 0,
              overflowWrap: "anywhere",
            }}
          >
            <MarkdownViewer
              content={content}
              root={rootId || undefined}
              onFileClick={(path) => onFileClickRef.current?.({ path })}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "transparent",
      }}
    >
      {interactionMode === "drawer" ? null : (
        <SessionHeader
          key={`${rootId || ""}:${sessionKey || ""}`}
          title={displayName}
          sessionKey={sessionKey || ""}
          rootId={rootId}
          pending={isAwaiting}
          chat={!session.type || session.type === "chat"}
          onRootClick={onRootClick}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          onDetachSession={session.parent_session_key ? onDetachSession : undefined}
          onHandoffPack={onHandoffPack}
          onScheduledTask={onScheduledTask}
        />
      )}

      {/* 滚动容器 */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, position: "relative" }}>
        <div ref={scrollRef} style={{ flex: 1, minHeight: 0, minWidth: 0, height: "100%", overflowY: "auto", overflowX: "hidden", position: "relative", WebkitOverflowScrolling: "touch" }}>
          <div style={{
            width: "100%",
            minWidth: 0,
            display: "block",
            padding: `24px 16px ${sessionTailPaddingBottom}px`,
            boxSizing: "border-box",
            overflowX: "hidden",
          }} data-mindfs-session-content-width="1">
          <div style={{ width: "100%", minWidth: 0, margin: "0", display: "flex", flexDirection: "column" }}>
            {loading && !hasVisibleTimeline ? (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "10px",
                  padding: "6px 0 8px",
                }}
              >
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    style={{
                      width: index === 1 ? "78%" : index === 2 ? "64%" : "52%",
                      height: index === 0 ? "18px" : "72px",
                      alignSelf:
                        index === 0
                          ? "flex-start"
                          : index === 1
                            ? "flex-end"
                            : "flex-start",
                      borderRadius: index === 0 ? "8px" : "18px",
                      background:
                        "linear-gradient(90deg, rgba(148,163,184,0.12) 0%, rgba(148,163,184,0.24) 50%, rgba(148,163,184,0.12) 100%)",
                      backgroundSize: "200% 100%",
                      animation:
                        "sessionLoadingPulse 1.1s ease-in-out infinite",
                    }}
                  />
                ))}
              </div>
            ) : null}
            {virtualized ? (
              <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%", overflowAnchor: "none" }}>
                {virtualizer.getVirtualItems().map((row) => (
                  <div
                    key={row.key}
                    data-index={row.index}
                    ref={virtualizer.measureElement}
                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)`, display: "flex", flexDirection: "column" }}
                  >
                    {renderTimelineItem(timeline[row.index], row.index, timelineItemSpacing(row.index > 0 ? timeline[row.index - 1] : null, timeline[row.index]))}
                  </div>
                ))}
              </div>
            ) : timeline.map((item, idx) =>
              React.cloneElement(
                renderTimelineItem(
                  item,
                  idx,
                  timelineItemSpacing(idx > 0 ? timeline[idx - 1] : null, item),
                ),
                { "data-timeline-index": idx } as any,
              ),
            )}
            {renderSlashCommandResult()}
            {(isAwaiting || isStreaming) && (
              <div
                style={{
                  marginTop: "16px",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  color: "var(--text-secondary)",
                }}
              >
                <span
                  style={{
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: "var(--accent-color)",
                    animation: "pulse 1s infinite",
                  }}
                />
                {isStreaming
                  ? streamStatusText || t("session.generating")
                  : t("session.sentWaiting")}
              </div>
            )}

            {relatedFiles.length > 0 && (
              <div
                style={{
                  marginTop: "18px",
                  paddingTop: "14px",
                  borderTop: "1px solid var(--border-color)",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setRelatedFilesCollapsed((value) => !value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setRelatedFilesCollapsed((value) => !value);
                    }
                  }}
                  style={{
                    fontSize: "12px",
                    fontWeight: 500,
                    color: "var(--text-secondary)",
                    marginBottom: "6px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    cursor: "pointer",
                    borderRadius: "6px",
                    padding: "2px 0",
                    outline: "none",
                  }}
                >
                  <span>{t("session.relatedFiles", { count: relatedFiles.length })}</span>
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setRelatedFilesCollapsed((value) => !value)
                      }}
                      aria-label={
                        relatedFilesCollapsed ? t("session.expandRelatedFiles") : t("session.collapseRelatedFiles")
                      }
                      title={
                        relatedFilesCollapsed ? t("session.expandRelatedFiles") : t("session.collapseRelatedFiles")
                      }
                      style={{
                        border: "none",
                        background: "transparent",
                        padding: 0,
                        margin: 0,
                        cursor: "pointer",
                        color: "var(--text-secondary)",
                        width: "16px",
                        height: "16px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          flexShrink: 0,
                          transform: relatedFilesCollapsed
                            ? "rotate(0deg)"
                            : "rotate(90deg)",
                          transition: "transform 0.2s",
                          color: "var(--text-secondary)",
                          display: "inline-flex",
                          alignItems: "center",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.25"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </span>
                    </button>
                  </div>
                </div>
                {!relatedFilesCollapsed ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "4px",
                    }}
                  >
                    {displayFileGroups.map((group) => {
                      const normalizedRepoPath = String(group.repoPath || "").replace(/[\\/]+$/, "");
                      const normalizedRootPath = String(rootPath || "").replace(/[\\/]+$/, "");
                      const isCurrentRepo =
                        !group.repoPath ||
                        group.repoName === t("session.currentProject") ||
                        normalizedRepoPath === normalizedRootPath;
                      const showGroupHeader = group.repoKind === "plain" || group.head || !isCurrentRepo;
                      return (
                        <div
                          key={group.key}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "4px",
                          }}
                        >
                          {showGroupHeader ? (
                            <div
                              title={[group.repoPath, group.head].filter(Boolean).join(" · ") || group.repoName || t("session.currentProject")}
                              style={{
                                padding: "2px 6px 0",
                                fontSize: "11px",
                                color: "var(--text-secondary)",
                                fontFamily: group.head
                                  ? "var(--mono-font, monospace)"
                                  : undefined,
                              }}
                            >
                              {group.repoKind === "plain"
                                ? `${group.repoName || t("session.currentProject")} · ${t("session.nonGit")}`
                                : group.repoKind === "svn"
                                  ? group.head && group.head !== "0"
                                    ? isCurrentRepo
                                      ? t("session.svnRevision", { revision: group.head })
                                      : `${group.repoName || t("session.currentProject")} · ${t("session.svnRevision", { revision: group.head })}`
                                    : group.repoName || t("session.currentProject")
                                  : group.head
                                    ? isCurrentRepo
                                      ? `HEAD ${group.head.slice(0, 8)}`
                                      : `${group.repoName || t("session.currentProject")} · HEAD ${group.head.slice(0, 8)}`
                                    : group.repoName || t("session.currentProject")}
                            </div>
                          ) : null}
                          {group.files.map((file) => {
                            return (
                          <div
                            key={`${file.head || "legacy"}:${file.path}`}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <div
                              onClick={() => onFileClickRef.current?.(file)}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "8px",
                                flex: 1,
                                minWidth: 0,
                                padding: "3px 6px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                transition: "background 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background =
                                  "rgba(0,0,0,0.04)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background =
                                  "transparent";
                              }}
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                width="13"
                                height="13"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="#94a3b8"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                                style={{ flexShrink: 0 }}
                              >
                                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 2 14 8 20 8" />
                                <line x1="16" x2="8" y1="13" y2="13" />
                                <line x1="16" x2="8" y1="17" y2="17" />
                                <line x1="10" x2="8" y1="9" y2="9" />
                              </svg>
                              <div
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  fontSize: "12px",
                                  color: "var(--text-primary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {file.name}
                              </div>
                            </div>
                            <button
                              type="button"
                              aria-label={t("session.removeRelatedFile", { name: file.name || file.path })}
                              onClick={(event) => {
                                event.stopPropagation();
                                onRemoveRelatedFile?.(
                                  file.path,
                                  file.head,
                                  file.repo_path,
                                  file.repo_kind,
                                );
                              }}
                              style={{
                                border: "none",
                                background: "transparent",
                                color: "#dc2626",
                                cursor: "pointer",
                                fontSize: "14px",
                                lineHeight: 1,
                                padding: "2px 4px",
                                borderRadius: "4px",
                                flexShrink: 0,
                              }}
                            >
                              x
                            </button>
                          </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            )}
            <div
              ref={scrollEndRef}
              data-session-scroll-end="1"
              style={{ height: "1px" }}
            />
          </div>
          </div>
        </div>
        {userMessageSummaries.length > 0 || showJumpToLatest || taskItems.length > 0 ? (
          <div
            style={{
              position: "absolute",
              right: "16px",
              bottom: `${16 + composerOverlayInset}px`,
              zIndex: 4,
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {showJumpToLatest ? (
              <button
                type="button"
                onClick={() => {
                  cancelTargetSeqScroll();
                  if (targetSeq) {
                    targetSeqScrollKeyRef.current = `${sessionKey || ""}:${targetSeq}:${targetSeqRequestKey}`;
                  }
                  resumeFollowing();
                  stickSessionToBottom("instant");
                }}
                aria-label={t("session.jumpLatest")}
                title={t("session.jumpLatest")}
                data-mindfs-jump-latest="1"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  height: "34px",
                  border: "1px solid rgba(37,99,235,0.35)",
                  background: "#2563eb",
                  color: "#ffffff",
                  borderRadius: "999px",
                  padding: "0 12px",
                  boxShadow: "0 8px 24px rgba(15, 23, 42, 0.14)",
                  cursor: "pointer",
                  fontSize: "12px",
                  whiteSpace: "nowrap",
                }}
              >
                <span>{t("session.jumpBottom")}</span>
              </button>
            ) : null}
            {taskItems.length > 0 ? (
              <div
                onMouseEnter={() => setTaskPanelHoverOpen(true)}
                onMouseLeave={() => setTaskPanelHoverOpen(false)}
                style={{
                  position: "relative",
                  display: "inline-flex",
                }}
              >
                {taskPanelOpen ? (
                  <>
                    <div
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        right: 0,
                        bottom: "100%",
                        width: "min(340px, calc(100vw - 72px))",
                        height: "8px",
                      }}
                    />
                    <div
                      role="dialog"
                      aria-label={t("taskList.title")}
                      style={{
                        position: "absolute",
                        right: 0,
                        bottom: "calc(100% + 8px)",
                        width: "min(340px, calc(100vw - 72px))",
                        maxHeight: "280px",
                        overflowY: "auto",
                        padding: "8px",
                        borderRadius: "8px",
                        border: "1px solid var(--menu-border)",
                        background: "var(--menu-bg)",
                        boxShadow: "0 16px 34px rgba(15, 23, 42, 0.18)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          padding: "2px 2px 8px",
                          fontSize: "12px",
                          fontWeight: 700,
                        }}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          {renderToolIcon("task")}
                          {t("taskList.title")}
                        </span>
                        <span
                          style={{
                            color: "var(--text-secondary)",
                            fontSize: "11px",
                            fontWeight: 600,
                          }}
                        >
                          {completedTaskCount}/{taskItems.length}
                        </span>
                      </div>
                      <TaskListRows items={taskItems} />
                    </div>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setTaskPanelPinnedOpen((open) => {
                      const nextOpen = !open;
                      if (!nextOpen) {
                        setTaskPanelHoverOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                  aria-label={taskPanelOpen ? t("taskList.hide") : t("taskList.show")}
                  title={taskPanelOpen ? t("taskList.hide") : t("taskList.show")}
                  data-mindfs-task-list="1"
                  style={{
                    position: "relative",
                    width: "34px",
                    height: "34px",
                    border: "none",
                    borderRadius: "8px",
                    background: taskPanelOpen ? "var(--accent-color)" : "var(--menu-bg)",
                    color: taskPanelOpen ? "#ffffff" : "var(--text-secondary)",
                    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.16)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    fontSize: "16px",
                  }}
                >
                  {renderToolIcon("task")}
                  <span
                    aria-hidden="true"
                    data-mindfs-task-list-count="1"
                    style={{
                      position: "absolute",
                      top: "-7px",
                      right: "-7px",
                      minWidth: "18px",
                      height: "18px",
                      padding: "0 5px",
                      borderRadius: "999px",
                      background:
                        taskItems.length > 0 && completedTaskCount === taskItems.length
                          ? "#15803d"
                          : "#2563eb",
                      color: "#ffffff",
                      border: "2px solid var(--menu-bg)",
                      fontSize: "10px",
                      fontWeight: 800,
                      lineHeight: "14px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxSizing: "border-box",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {completedTaskCount}/{taskItems.length}
                  </span>
                </button>
              </div>
            ) : null}
            {userMessageSummaries.length > 0 ? (
              <div
                ref={userSummaryRootRef}
                data-mindfs-user-summary="1"
                onMouseEnter={() => {
                  refreshCurrentUserMessageIndex();
                  setUserSummaryHoverOpen(true);
                }}
                onMouseLeave={() => setUserSummaryHoverOpen(false)}
                style={{
                  position: "relative",
                  display: "inline-flex",
                }}
              >
                {userSummaryOpen ? (
                  <>
                    <div
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        right: 0,
                        bottom: "100%",
                        width: "min(320px, calc(100vw - 72px))",
                        height: "8px",
                      }}
                    />
                    <div
                      role="dialog"
                      aria-label={t("session.userSummary")}
                      style={{
                        position: "absolute",
                        right: 0,
                        bottom: "calc(100% + 8px)",
                        width: "min(320px, calc(100vw - 72px))",
                        maxHeight: "260px",
                        overflowY: "auto",
                        padding: "6px",
                        borderRadius: "8px",
                        border: "1px solid var(--menu-border)",
                        background: "var(--menu-bg)",
                        boxShadow: "0 16px 34px rgba(15, 23, 42, 0.18)",
                        color: "var(--text-primary)",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        ref={userSummaryListRef}
                        style={{ display: "flex", flexDirection: "column", gap: "2px" }}
                      >
                        {userMessageSummaries.map((item) => {
                          const isCurrent = item.index === currentUserMessageIndex;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-user-summary-index={item.index}
                              onClick={() => scrollToUserMessageSummary(item.index)}
                              style={{
                                width: "100%",
                                border: "none",
                                background: isCurrent
                                  ? "rgba(148, 163, 184, 0.22)"
                                  : "transparent",
                                display: "block",
                                padding: "6px 8px",
                                borderRadius: "6px",
                                cursor: "pointer",
                                textAlign: "left",
                                color: "var(--text-primary)",
                              }}
                              onMouseEnter={(event) => {
                                event.currentTarget.style.background = "var(--menu-active-bg)";
                              }}
                              onMouseLeave={(event) => {
                                event.currentTarget.style.background = isCurrent
                                  ? "rgba(148, 163, 184, 0.22)"
                                  : "transparent";
                              }}
                            >
                              <span
                                title={item.summary}
                                style={{
                                  display: "block",
                                  minWidth: 0,
                                  fontSize: "12px",
                                  lineHeight: "18px",
                                  color: "var(--text-primary)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.summary}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    refreshCurrentUserMessageIndex();
                    setUserSummaryPinnedOpen((open) => {
                      const nextOpen = !open;
                      if (!nextOpen) {
                        setUserSummaryHoverOpen(false);
                      }
                      return nextOpen;
                    });
                  }}
                  aria-label={userSummaryOpen ? t("session.hideUserSummary") : t("session.showUserSummary")}
                  title={userSummaryOpen ? t("session.hideUserSummary") : t("session.showUserSummary")}
                  style={{
                    position: "relative",
                    width: "34px",
                    height: "34px",
                    border: "none",
                    borderRadius: "8px",
                    background: userSummaryOpen ? "var(--accent-color)" : "var(--menu-bg)",
                    color: userSummaryOpen ? "#ffffff" : "var(--text-secondary)",
                    boxShadow: "0 10px 24px rgba(15, 23, 42, 0.16)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    fontSize: "18px",
                  }}
                >
                  <UserMessageListIcon />
                  <span
                    aria-hidden="true"
                    data-mindfs-user-summary-count="1"
                    style={{
                      position: "absolute",
                      top: "-7px",
                      right: "-7px",
                      minWidth: "18px",
                      height: "18px",
                      padding: "0 5px",
                      borderRadius: "999px",
                      background: "#2563eb",
                      color: "#ffffff",
                      border: "2px solid var(--menu-bg)",
                      fontSize: "10px",
                      fontWeight: 800,
                      lineHeight: "14px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxSizing: "border-box",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {userMessageSummaries.length}
                  </span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes sessionLoadingPulse {
          0% { background-position: 100% 0; opacity: 0.7; }
          50% { opacity: 1; }
          100% { background-position: -100% 0; opacity: 0.7; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export const SessionViewer = memo(
  SessionViewerInner,
  (prev, next) =>
    prev.session === next.session &&
    prev.loading === next.loading &&
    prev.rootId === next.rootId &&
    prev.rootPath === next.rootPath &&
    prev.interactionMode === next.interactionMode &&
    prev.targetSeq === next.targetSeq &&
    prev.targetSeqRequestKey === next.targetSeqRequestKey &&
    prev.composerOverlayInset === next.composerOverlayInset &&
    prev.onRootClick === next.onRootClick &&
    prev.onRenameSession === next.onRenameSession &&
    prev.onDeleteSession === next.onDeleteSession &&
    prev.onDetachSession === next.onDetachSession &&
    prev.onHandoffPack === next.onHandoffPack &&
    prev.onScheduledTask === next.onScheduledTask,
);
