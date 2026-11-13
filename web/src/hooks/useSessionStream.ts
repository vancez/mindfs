import { useEffect, useMemo, useState } from "react";
import {
  sessionService,
  type CompactNotice,
  type ExchangeAux,
  type PlanUpdate,
  type TaskListUpdate,
  type TodoUpdate,
  type ToolCall,
  type TokenUsage,
} from "../services/session";
import { translateNow } from "../i18n";

type ExchangeLike = {
  seq?: number;
  role?: string;
  agent?: string;
  model?: string;
  model_display_name?: string;
  effort?: string;
  fast_service?: string;
  content?: string;
  thought_id?: string;
  context_window?: {
    totalTokens: number;
    modelContextWindow: number;
  };
  token_usage?: TokenUsage;
  timestamp?: string;
  toolCall?: ToolCall;
  todoUpdate?: TodoUpdate;
  tasksUpdate?: TaskListUpdate;
  planUpdate?: PlanUpdate;
  compactNotice?: CompactNotice;
  pending_ack?: boolean;
  persisted?: boolean;
};

type ExchangeAuxMapLike = Record<string, ExchangeAux[]>;

export type TimelineItem =
  | {
      id: string;
      type: "user_text" | "assistant_text";
      content: string;
      timestamp?: string;
      agent?: string;
      model?: string;
      modelDisplayName?: string;
      effort?: string;
      fastService?: string;
      pendingAck?: boolean;
      seq?: number;
      persisted?: boolean;
      contextWindow?: {
        totalTokens: number;
        modelContextWindow: number;
      };
      tokenUsage?: TokenUsage;
    }
  | { id: string; type: "thought"; content: string; thoughtId?: string }
  | { id: string; type: "tool"; toolCall: ToolCall }
  | { id: string; type: "todo"; todoUpdate: TodoUpdate; timestamp?: string }
  | { id: string; type: "tasks"; tasksUpdate: TaskListUpdate; timestamp?: string }
  | { id: string; type: "plan"; planUpdate: PlanUpdate; timestamp?: string }
  | { id: string; type: "compact"; compactNotice: CompactNotice; timestamp?: string };

type UseSessionStreamResult = {
  timeline: TimelineItem[];
  isStreaming: boolean;
  streamVersion: number;
  streamStatusText: string;
  // Latest task-list snapshot, including empty snapshots that are skipped in
  // the inline timeline so a persistent task panel can hide itself.
  latestTaskList: TaskListUpdate | null;
};

type ContextWindowLike = {
  totalTokens: number;
  modelContextWindow: number;
};

function hashText(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableTimelineID(
  prefix: string,
  index: number,
  content: string,
  timestamp?: string,
  agent?: string,
): string {
  return `${prefix}:${index}:${timestamp || ""}:${agent || ""}:${hashText(content)}`;
}

// Server-side ids are not unique across exchanges: when a turn is interrupted
// while a tool call is still running, its completion is persisted into the next
// turn, so the same callId shows up twice. Timeline identity has to include the
// exchange that recorded the item; duplicate keys made React reuse the wrong
// card state (expanding B showed A's details) and collided in the virtualizer's
// size cache, which stacked rows on top of each other.
function exchangeScopedID(prefix: string, index: number, id: string): string {
  return `${prefix}:${index}:${id}`;
}

function normalizeRole(role?: string): string {
  return (role || "").toLowerCase();
}

function normalizeToolCallStatus(status?: string): string {
  const value = (status || "").toLowerCase();
  if (value === "completed") return "complete";
  if (value === "pending") return "running";
  return value || "running";
}

// TaskCreate/TaskUpdate/TaskList/TaskGet are internal task-list plumbing. The
// task list card owns their presentation, so their tool cards are omitted from
// the transcript (an update after a turn boundary has no title and would
// otherwise render as "tool" with the raw taskId/status input).
function isTaskListToolCall(toolCall: ToolCall): boolean {
  if ((toolCall.kind || "").toLowerCase() !== "task") {
    return false;
  }
  const taskTool = toolCall.meta?.taskTool;
  return typeof taskTool === "string" && taskTool.trim() !== "";
}

function normalizeToolCall(input: ToolCall): ToolCall {
  const raw = input as ToolCall & {
    toolCallId?: string;
    tool_call_id?: string;
  };
  const callId = raw.callId || raw.toolCallId || raw.tool_call_id || "";
  return {
    ...input,
    callId,
    status: normalizeToolCallStatus(raw.status),
  };
}

function settleRunningTools(items: TimelineItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.type !== "tool") return item;
    const kind = (item.toolCall.kind || "").toLowerCase();
    if (kind === "ask_user" || kind === "task") return item;
    const status = (item.toolCall.status || "").toLowerCase();
    if (
      status === "running" ||
      status === "in_progress" ||
      status === "pending"
    ) {
      return {
        ...item,
        toolCall: {
          ...item.toolCall,
          status: "complete",
        },
      };
    }
    return item;
  });
}

function assistantSegmentItem(
  index: number,
  ex: ExchangeLike,
  content: string,
  segmentIndex: number,
  includeContextWindow: boolean,
): TimelineItem | null {
  if (!content) {
    return null;
  }
  return {
    // Content and timestamps change during streaming. Identity belongs to the
    // exchange/segment, so React and virtual measurements survive each chunk.
    id: `assistant:${index}:${segmentIndex}`,
    type: "assistant_text",
    content,
    timestamp: ex.timestamp,
    agent: ex.agent,
    model: ex.model,
    modelDisplayName: ex.model_display_name,
    effort: ex.effort,
    fastService: ex.fast_service,
    seq: ex.seq,
    persisted: ex.persisted,
    contextWindow: includeContextWindow ? ex.context_window : undefined,
    tokenUsage: includeContextWindow ? ex.token_usage : undefined,
  };
}

function buildAssistantTimeline(
  ex: ExchangeLike,
  index: number,
  auxList: ExchangeAux[],
): TimelineItem[] {
  const content = ex.content || "";
  if (!auxList.length) {
    const single = assistantSegmentItem(index, ex, content, 0, true);
    return single ? [single] : [];
  }

  const lines = content === "" ? [] : content.split("\n");
  const totalLines = lines.length;
  const out: TimelineItem[] = [];
  const normalizedAux = auxList.map((aux, auxIndex) => ({
    ...aux,
    auxIndex,
    line: Math.max(0, Math.min(totalLines, Number(aux.line || 0))),
  }));
  normalizedAux.sort((left, right) => {
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.auxIndex - right.auxIndex;
  });

  let emittedLines = 0;
  let segmentIndex = 0;
  for (const aux of normalizedAux) {
    if (aux.line > emittedLines) {
      const segment = assistantSegmentItem(
        index,
        ex,
        lines.slice(emittedLines, aux.line).join("\n"),
        segmentIndex,
        false,
      );
      if (segment) {
        out.push(segment);
        segmentIndex += 1;
      }
      emittedLines = aux.line;
    }
    if (aux.thought) {
      out.push({
        id: aux.thought_id
          ? exchangeScopedID("thought", index, aux.thought_id)
          : stableTimelineID(
              "thought",
              index * 1000 + segmentIndex,
              aux.thought,
              ex.timestamp,
              ex.agent,
            ),
        type: "thought",
        content: aux.thought,
        thoughtId: aux.thought_id || undefined,
      });
      segmentIndex += 1;
    } else if (aux.plan) {
      out.push({
        id: aux.plan.id
          ? exchangeScopedID("plan", index, aux.plan.id)
          : stableTimelineID(
              "plan",
              index * 1000 + segmentIndex,
              aux.plan.content || "",
              ex.timestamp,
              ex.agent,
            ),
        type: "plan",
        planUpdate: aux.plan,
        timestamp: ex.timestamp,
      });
      segmentIndex += 1;
    } else if (aux.todo) {
      out.push({
        id: stableTimelineID(
          "todo",
          index * 1000 + segmentIndex,
          JSON.stringify(aux.todo),
          ex.timestamp,
          ex.agent,
        ),
        type: "todo",
        todoUpdate: aux.todo,
        timestamp: ex.timestamp,
      });
      segmentIndex += 1;
    } else if (aux.tasks) {
      if (aux.tasks.items?.length) {
        out.push({
          id: stableTimelineID(
            "tasks",
            index * 1000 + segmentIndex,
            JSON.stringify(aux.tasks),
            ex.timestamp,
            ex.agent,
          ),
          type: "tasks",
          tasksUpdate: aux.tasks,
          timestamp: ex.timestamp,
        });
        segmentIndex += 1;
      }
    } else if (aux.compact) {
      out.push({
        id: aux.compact.id
          ? exchangeScopedID("compact", index, aux.compact.id)
          : stableTimelineID(
              "compact",
              index * 1000 + segmentIndex,
              JSON.stringify(aux.compact),
              ex.timestamp,
              ex.agent,
            ),
        type: "compact",
        compactNotice: aux.compact,
        timestamp: ex.timestamp,
      });
      segmentIndex += 1;
    } else if (aux.toolcall) {
      const normalizedTool = normalizeToolCall(aux.toolcall);
      if (!isTaskListToolCall(normalizedTool)) {
        out.push({
          id: normalizedTool.callId
            ? exchangeScopedID("tool", index, normalizedTool.callId)
            : stableTimelineID(
                "tool",
                index * 1000 + segmentIndex,
                JSON.stringify(normalizedTool),
                ex.timestamp,
                ex.agent,
              ),
          type: "tool",
          toolCall: normalizedTool,
        });
        segmentIndex += 1;
      }
    }
  }

  if (emittedLines < totalLines) {
    const segment = assistantSegmentItem(
      index,
      ex,
      lines.slice(emittedLines).join("\n"),
      segmentIndex,
      true,
    );
    if (segment) {
      out.push(segment);
      segmentIndex += 1;
    }
  } else {
    for (let i = out.length - 1; i >= 0; i -= 1) {
      const item = out[i];
      if (item.type === "assistant_text") {
        out[i] = {
          ...item,
          contextWindow: ex.context_window,
          tokenUsage: ex.token_usage,
        };
        break;
      }
    }
  }

  return out;
}

function buildBaseTimeline(
  exchanges: ExchangeLike[],
  exchangeAux: ExchangeAuxMapLike,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  let inferredSeq = 0;
  for (let index = 0; index < exchanges.length; index += 1) {
    const ex = exchanges[index];
    const role = normalizeRole(ex.role);
    const content = ex.content || "";
    if (role === "user") {
      inferredSeq += 1;
      const persisted = Number(ex.seq || 0) > 0;
      const seq = persisted ? Number(ex.seq || 0) : inferredSeq;
      if (!content) continue;
      out.push({
        id: stableTimelineID("user", index, content, ex.timestamp, ex.agent),
        type: "user_text",
        content,
        timestamp: ex.timestamp,
        agent: ex.agent,
        pendingAck: ex.pending_ack === true,
        seq,
        persisted,
      });
      continue;
    }
    if (role === "agent" || role === "assistant") {
      inferredSeq += 1;
      const persisted = Number(ex.seq || 0) > 0;
      const seq = persisted ? Number(ex.seq || 0) : inferredSeq;
      const auxList = seq ? exchangeAux[String(seq)] || [] : [];
      out.push(
        ...buildAssistantTimeline({ ...ex, seq, persisted }, index, auxList),
      );
      continue;
    }
    if (role === "thought") {
      if (!content) continue;
      out.push({
        id: ex.thought_id
          ? exchangeScopedID("thought", index, ex.thought_id)
          : stableTimelineID("thought", index, content, ex.timestamp, ex.agent),
        type: "thought",
        content,
        thoughtId: ex.thought_id || undefined,
      });
      continue;
    }
    if (role === "tool") {
      if (!ex.toolCall) continue;
      const normalizedTool = normalizeToolCall(ex.toolCall);
      if (isTaskListToolCall(normalizedTool)) continue;
      out.push({
        id: normalizedTool.callId
          ? exchangeScopedID("tool", index, normalizedTool.callId)
          : stableTimelineID(
              "tool",
              index,
              JSON.stringify(normalizedTool),
              ex.timestamp,
              ex.agent,
            ),
        type: "tool",
        toolCall: normalizedTool,
      });
      continue;
    }
    if (role === "todo") {
      if (!ex.todoUpdate) continue;
      out.push({
        id: stableTimelineID(
          "todo",
          index,
          JSON.stringify(ex.todoUpdate),
          ex.timestamp,
          ex.agent,
        ),
        type: "todo",
        todoUpdate: ex.todoUpdate,
        timestamp: ex.timestamp,
      });
      continue;
    }
    if (role === "tasks") {
      if (!ex.tasksUpdate?.items?.length) continue;
      out.push({
        id: stableTimelineID(
          "tasks",
          index,
          JSON.stringify(ex.tasksUpdate),
          ex.timestamp,
          ex.agent,
        ),
        type: "tasks",
        tasksUpdate: ex.tasksUpdate,
        timestamp: ex.timestamp,
      });
      continue;
    }
    if (role === "plan") {
      if (!ex.planUpdate) continue;
      out.push({
        id: ex.planUpdate.id
          ? exchangeScopedID("plan", index, ex.planUpdate.id)
          : stableTimelineID("plan", index, ex.planUpdate.content || "", ex.timestamp, ex.agent),
        type: "plan",
        planUpdate: ex.planUpdate,
        timestamp: ex.timestamp,
      });
      continue;
    }
    if (role === "compact") {
      if (!ex.compactNotice) continue;
      out.push({
        id: ex.compactNotice.id
          ? exchangeScopedID("compact", index, ex.compactNotice.id)
          : stableTimelineID("compact", index, JSON.stringify(ex.compactNotice), ex.timestamp, ex.agent),
        type: "compact",
        compactNotice: ex.compactNotice,
        timestamp: ex.timestamp,
      });
    }
  }
  return out;
}

function applySessionContextWindow(
  items: TimelineItem[],
  contextWindow?: ContextWindowLike,
): TimelineItem[] {
  const totalTokens = Math.max(0, Number(contextWindow?.totalTokens || 0));
  const modelContextWindow = Math.max(
    0,
    Number(contextWindow?.modelContextWindow || 0),
  );
  // Subagent sessions only know their used tokens, not the model window. The
  // badge component already renders that intermediate state, so stamp it.
  if (!totalTokens) {
    return items;
  }
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.type !== "assistant_text") {
      continue;
    }
    if (
      item.contextWindow?.totalTokens &&
      item.contextWindow?.modelContextWindow
    ) {
      return items;
    }
    const next = [...items];
    next[i] = {
      ...item,
      contextWindow: {
        totalTokens,
        modelContextWindow,
      },
    };
    return next;
  }
  return items;
}

export function useSessionStream(
  sessionKey: string | null,
  exchanges: ExchangeLike[] = [],
  exchangeAux: ExchangeAuxMapLike = {},
  sessionContextWindow?: ContextWindowLike,
  sessionPending = false,
): UseSessionStreamResult {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [streamStatusText, setStreamStatusText] = useState("");

  const baseTimeline = useMemo(
    () =>
      applySessionContextWindow(
        buildBaseTimeline(exchanges, exchangeAux),
        sessionContextWindow,
      ),
    [exchanges, exchangeAux, sessionContextWindow],
  );

  useEffect(() => {
    setStreamVersion(0);
    setStreamStatusText("");
    if (!sessionKey) {
      setIsStreaming(false);
      return;
    }
    const unsubscribe = sessionService.subscribe(sessionKey, {
      onStream: (event) => {
        setStreamVersion((value) => value + 1);
        if (event.type === "recovery") {
          setStreamStatusText(event.data?.message || translateNow("session.recovering"));
          setIsStreaming(true);
          return;
        }
        if (event.type === "message_chunk") {
          setStreamStatusText("");
        }
        if (event.type === "message_done" || event.type === "context_update") {
          return;
        }
        if (event.type === "error") {
          setStreamStatusText("");
          setIsStreaming(false);
        } else {
          setIsStreaming(true);
        }
      },
      onDone: () => {
        setStreamStatusText("");
        setIsStreaming(false);
      },
      onError: () => {
        setStreamStatusText("");
        setIsStreaming(false);
      },
    });

    // subscribe() replays events queued while this viewer was unmounted. If
    // the turn finished during that time, those stale events would re-enter
    // the generating state forever: recompute from the authoritative live
    // stream flag, which session.done/session.error already cleared.
    const streaming = sessionPending && sessionService.isSessionStreaming(sessionKey);
    setIsStreaming(streaming);
    if (!streaming) {
      setStreamStatusText("");
    }

    return () => {
      unsubscribe();
    };
  }, [sessionKey, sessionPending]);

  // Viewport-only rerenders must not look like new session content to the
  // viewer's tail-following effect.
  const timeline = useMemo(() => settleRunningTools(baseTimeline), [baseTimeline]);

  const latestTaskList = useMemo(() => {
    let latest: TaskListUpdate | null = null;
    for (const ex of exchanges) {
      const role = normalizeRole(ex.role);
      if (role === "tasks") {
        if (ex.tasksUpdate) latest = ex.tasksUpdate;
        continue;
      }
      if (role !== "agent" && role !== "assistant") continue;
      const seq = Number(ex.seq || 0);
      if (!seq) continue;
      const auxList = exchangeAux[String(seq)] || [];
      let latestLine = -1;
      for (const aux of auxList) {
        if (!aux.tasks) continue;
        const line = Math.max(0, Number(aux.line || 0));
        if (line >= latestLine) {
          latest = aux.tasks;
          latestLine = line;
        }
      }
    }
    return latest;
  }, [exchanges, exchangeAux]);

  return {
    timeline,
    isStreaming,
    streamVersion,
    streamStatusText,
    latestTaskList,
  };
}
