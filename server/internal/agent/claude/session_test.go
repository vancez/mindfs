package claude

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"

	"mindfs/server/internal/agent/types"
)

func TestClaudeModelInfoSupportsEffortWithoutModelNameWhitelist(t *testing.T) {
	want := []string{"low", "medium", "high", "xhigh", "max"}
	got := claudeModelInfo(claudeagent.ModelInfo{
		Value:       "custom-provider-model",
		DisplayName: "Custom Model",
	})
	if !got.SupportEffort {
		t.Fatal("custom model should support CLI effort selection")
	}
	if !reflect.DeepEqual(got.Efforts, want) {
		t.Fatalf("custom model efforts = %v, want %v", got.Efforts, want)
	}
}

func TestClaudeTokenUsageIncludesCacheReadAndCreationInLogicalInput(t *testing.T) {
	got := claudeTokenUsage(claudeagent.ResultMessage{
		Usage: &claudeagent.NonNullableUsage{
			InputTokens:              50,
			OutputTokens:             1_100,
			CacheReadInputTokens:     10_000,
			CacheCreationInputTokens: 2_350,
		},
	})
	if got == nil || got.InputTokens != 12_400 || got.OutputTokens != 1_100 {
		t.Fatalf("usage = %#v", got)
	}
	if got.CacheReadTokens == nil || *got.CacheReadTokens != 10_000 {
		t.Fatalf("cache read = %#v", got.CacheReadTokens)
	}
	if got.CacheWriteTokens == nil || *got.CacheWriteTokens != 2_350 {
		t.Fatalf("cache write = %#v", got.CacheWriteTokens)
	}
}

func TestAppendClaudeDeveloperInstructionsUsesCLIAppendSystemPrompt(t *testing.T) {
	options := claudeagent.DefaultOptions()
	for _, apply := range appendClaudeDeveloperInstructions(nil, "render markdown") {
		apply(&options)
	}
	if options.SystemPrompt != "" {
		t.Fatalf("custom system prompt = %q, want empty", options.SystemPrompt)
	}
	value, ok := options.ExtraArgs["append-system-prompt"]
	if !ok || value == nil || *value != "render markdown" {
		t.Fatalf("append-system-prompt extra arg = %#v", value)
	}
}

func TestClaudeCompactBoundaryEmitsCompactNotice(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleCompactBoundaryMessage(claudeagent.CompactBoundaryMessage{
		UUID:      "compact-1",
		SessionID: "claude-session",
		CompactMetadata: claudeagent.CompactMetadata{
			Trigger:   "auto",
			PreTokens: 1200,
		},
	})

	if got.Type != types.EventTypeCompact {
		t.Fatalf("event type = %q, want compact", got.Type)
	}
	notice, ok := got.Data.(types.CompactNotice)
	if !ok {
		t.Fatalf("event data = %T, want CompactNotice", got.Data)
	}
	if notice.ID != "compact-1" || notice.Status != "auto" || !strings.Contains(notice.Summary, "1200") {
		t.Fatalf("notice = %#v", notice)
	}
}

func TestClaudeAuthStatusEmitsToolUpdate(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleAuthStatusMessage(claudeagent.AuthStatusMessage{
		UUID:             "auth-1",
		IsAuthenticating: true,
		Output:           []string{"open browser"},
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.RawType != "auth_status" || toolCall.Status != "running" {
		t.Fatalf("toolCall = %#v", toolCall)
	}
}

func TestClaudePlainStreamEventFallsBackToMessageChunk(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) { got = event }}

	s.handleStreamEvent(claudeagent.StreamEvent{Type: "stream_event", Event: "delta", Delta: "hello"})

	if got.Type != types.EventTypeMessageChunk {
		t.Fatalf("event type = %q, want message chunk", got.Type)
	}
	chunk, ok := got.Data.(types.MessageChunk)
	if !ok || chunk.Content != "hello" {
		t.Fatalf("chunk = %#v", got.Data)
	}
}

func TestClaudePartialInputJSONDeltaIsKnownNonDisplayEvent(t *testing.T) {
	raw := json.RawMessage(`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"具"}}`)

	textDelta, thinkingDelta := extractDeltas(raw)
	if textDelta != "" || thinkingDelta != "" {
		t.Fatalf("extractDeltas = %q, %q; want no display deltas", textDelta, thinkingDelta)
	}
	if !isKnownNonDisplayPartialEvent(raw) {
		t.Fatalf("input_json_delta should be recognized as non-display partial event")
	}
}

func TestClaudeThinkingTokensMessageUpdatesSessionIDOnly(t *testing.T) {
	events := make([]types.Event, 0, 1)
	s := &session{onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	msg := claudeagent.ThinkingTokensMessage{
		Type:                 "system",
		Subtype:              "thinking_tokens",
		EstimatedTokens:      43,
		EstimatedTokensDelta: 2,
		SessionID:            "claude-session",
	}
	s.updateSessionID(msg)

	if s.SessionID() != "claude-session" {
		t.Fatalf("session id = %q, want claude-session", s.SessionID())
	}
	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

func TestClaudeTaskNotificationEmitsTerminalTaskUpdate(t *testing.T) {
	events := make([]types.Event, 0, 1)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}
	s.trackTaskInfo("task-1", claudeTaskInfo{ToolUseID: "tool-1", TaskType: "local_agent"})

	s.handleTaskNotificationMessage(claudeagent.TaskNotificationMessage{
		Subtype:    "task_notification",
		TaskID:     "task-1",
		ToolUseID:  "tool-1",
		Status:     claudeagent.TaskNotificationStatusCompleted,
		OutputFile: "/tmp/claude-task-output.md",
		Summary:    "subagent finished",
	})

	if len(events) != 1 {
		t.Fatalf("events = %#v, want one terminal update", events)
	}
	if events[0].Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", events[0].Type)
	}
	toolCall, ok := events[0].Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", events[0].Data)
	}
	if toolCall.CallID != "tool-1" || toolCall.Status != "complete" {
		t.Fatalf("toolCall = %#v, want terminal update for original tool call", toolCall)
	}
	if toolCall.Meta["subtype"] != "task_notification" || toolCall.Meta["summary"] != "subagent finished" {
		t.Fatalf("meta = %#v, want notification metadata", toolCall.Meta)
	}
}

func TestClaudeLocalBashTaskLifecycleIsIgnored(t *testing.T) {
	events := make([]types.Event, 0, 3)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:      "task-1",
		ToolUseID:   "tool-1",
		TaskType:    "local_bash",
		Description: "Run shell command",
	})
	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "task-1",
		ToolUseID:    "tool-1",
		Description:  "Run shell command",
		LastToolName: "Bash",
	})
	s.handleTaskUpdatedMessage(claudeagent.TaskUpdatedMessage{
		TaskID: "task-1",
		Patch:  claudeagent.TaskUpdatePatch{Status: claudeagent.TaskRunStatusCompleted},
	})

	if len(events) != 0 {
		t.Fatalf("events = %#v, want none", events)
	}
}

func TestClaudeToolProgressHeartbeatDetection(t *testing.T) {
	parent := "call_00_AT1DtZL8sY6waNB01TLv1120"
	cases := []struct {
		name      string
		toolUseID string
		parentID  *string
		want      bool
	}{
		{name: "parent heartbeat", toolUseID: parent + "-heartbeat-0", parentID: &parent, want: true},
		{name: "repeated heartbeat", toolUseID: parent + "-heartbeat-12", want: true},
		{name: "regular progress", toolUseID: parent, parentID: &parent, want: false},
		{name: "non numeric heartbeat", toolUseID: parent + "-heartbeat-latest", want: false},
		{name: "empty", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := isClaudeToolProgressHeartbeat(claudeagent.ToolProgressMessage{
				ToolUseID:       tc.toolUseID,
				ParentToolUseID: tc.parentID,
			})
			if got != tc.want {
				t.Fatalf("isClaudeToolProgressHeartbeat(%q) = %v, want %v", tc.toolUseID, got, tc.want)
			}
		})
	}
}

func TestSummarizeExecuteToolCallPrefersNaturalLanguageDescription(t *testing.T) {
	title, meta := summarizeExecuteToolCall("Bash", json.RawMessage(`{
		"command":"go test ./...",
		"description":"Run the test suite"
	}`), nil)
	if title != "Run the test suite" {
		t.Fatalf("title = %q, want tool description", title)
	}
	if meta["command"] != "go test ./..." || meta["description"] != "Run the test suite" {
		t.Fatalf("meta = %#v, want command and description", meta)
	}
}

func TestSummarizeExecuteToolCallFallsBackToNaturalLanguageTitle(t *testing.T) {
	title, meta := summarizeExecuteToolCall("Bash", json.RawMessage(`{"command":"go test ./..."}`), nil)
	if title != "Run command" {
		t.Fatalf("title = %q, want natural-language fallback", title)
	}
	if meta["command"] != "go test ./..." {
		t.Fatalf("meta = %#v, want original command in details", meta)
	}
}

func TestClaudeLocalAgentTaskProgressEmitsParentTaskUpdate(t *testing.T) {
	events := make([]types.Event, 0, 2)
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		events = append(events, event)
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		TaskType:     "local_agent",
		Description:  "Print hi",
		SubagentType: "general-purpose",
		Prompt:       "prompt body",
	})
	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		Description:  "Print hi",
		SubagentType: "general-purpose",
	})

	if len(events) != 2 {
		t.Fatalf("events = %#v, want start and progress", events)
	}
	if events[0].Type != types.EventTypeToolCall || events[1].Type != types.EventTypeToolUpdate {
		t.Fatalf("event types = %q, %q", events[0].Type, events[1].Type)
	}
}

func TestClaudeTaskProgressDoesNotOverridePendingToolTitle(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		got = event
	}}
	s.trackPendingToolCall(types.ToolCall{
		CallID: "tool-1",
		Title:  "Print hi 5 times every 10s",
		Status: "running",
		Kind:   types.ToolKindTask,
	})

	s.handleTaskProgressMessage(claudeagent.TaskProgressMessage{
		TaskID:       "agent-1",
		ToolUseID:    "tool-1",
		Description:  "Acknowledging the user's instructions",
		SubagentType: "general-purpose",
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.Title != "" {
		t.Fatalf("progress title = %q, want empty to preserve original title", toolCall.Title)
	}
	if toolCall.Meta["progress"] != "Acknowledging the user's instructions" {
		t.Fatalf("progress meta = %#v", toolCall.Meta)
	}
}

func TestClaudeTaskUpdatedUsesOriginalToolUseIDAndDescription(t *testing.T) {
	var got types.Event
	s := &session{sessionID: "claude-session", onUpdate: func(event types.Event) {
		got = event
	}}

	s.handleTaskStartedMessage(claudeagent.TaskStartedMessage{
		TaskID:       "aab5b6559d82ef106",
		ToolUseID:    "call-task-1",
		TaskType:     "local_agent",
		Description:  "Review changed files",
		SubagentType: "general-purpose",
	})
	s.handleTaskUpdatedMessage(claudeagent.TaskUpdatedMessage{
		TaskID:  "aab5b6559d82ef106",
		Subtype: "task_updated",
		Patch:   claudeagent.TaskUpdatePatch{Status: claudeagent.TaskRunStatusCompleted},
	})

	if got.Type != types.EventTypeToolUpdate {
		t.Fatalf("event type = %q, want tool update", got.Type)
	}
	toolCall, ok := got.Data.(types.ToolCall)
	if !ok {
		t.Fatalf("event data = %T, want ToolCall", got.Data)
	}
	if toolCall.CallID != "call-task-1" {
		t.Fatalf("callID = %q, want original tool use id", toolCall.CallID)
	}
	if toolCall.Title != "Review changed files" {
		t.Fatalf("title = %q, want original task description", toolCall.Title)
	}
	if toolCall.Status != "complete" {
		t.Fatalf("status = %q, want complete", toolCall.Status)
	}
	if toolCall.Meta["taskId"] != "aab5b6559d82ef106" || toolCall.Meta["parentToolUseId"] != "call-task-1" {
		t.Fatalf("meta = %#v, want task id and parent tool use id", toolCall.Meta)
	}
}

func TestClaudeTaskCreateAndUpdateToolUseMapToTaskKind(t *testing.T) {
	for _, name := range []string{"TaskCreate", "TaskUpdate", "TaskList", "TaskGet"} {
		if got := mapToolKind(name); got != types.ToolKindTask {
			t.Fatalf("mapToolKind(%q) = %q, want task", name, got)
		}
	}
}

func TestClaudePlanToolsMapToThinkKind(t *testing.T) {
	for _, name := range []string{"Think", "UpdatePlan", "update_plan", "EnterPlanMode", "ExitPlanMode"} {
		if got := mapToolKind(name); got != types.ToolKindThink {
			t.Fatalf("mapToolKind(%q) = %q, want think", name, got)
		}
	}
}

func TestClaudeTaskCreateResultUsesReturnedTaskID(t *testing.T) {
	parentID := "call-create-1"
	s := &session{}
	create := newRunningToolCall(
		parentID,
		"TaskCreate",
		"tool_use",
		json.RawMessage(`{"subject":"检查 git 状态","description":"检查当前 git 修改状态","activeForm":"检查 git 状态"}`),
	)
	create.Meta = mergeToolCallMeta(create.Meta, map[string]any{
		"taskTool":  "TaskCreate",
		"toolUseId": parentID,
	})
	s.trackPendingToolCall(create)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult:   map[string]any{"task": map[string]any{"id": "7", "subject": "检查 git 状态"}},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "claude-task-list:7" || update.Status != "running" {
		t.Fatalf("update = %#v, want returned task id and running status", update)
	}
	if update.Title != "检查 git 状态" || update.Meta["taskId"] != "7" || update.Meta["taskTool"] != "TaskCreate" {
		t.Fatalf("update = %#v, want create title and real task meta", update)
	}
}

func TestClaudeTaskUpdateResultPreservesTaskStatus(t *testing.T) {
	parentID := "call-update-1"
	s := &session{}
	updateBase := newRunningToolCall(
		parentID,
		"TaskUpdate",
		"tool_use",
		json.RawMessage(`{"taskId":"7","status":"completed"}`),
	)
	updateBase.Meta = mergeToolCallMeta(updateBase.Meta, map[string]any{
		"taskTool":  "TaskUpdate",
		"toolUseId": parentID,
	})
	s.trackPendingToolCall(updateBase)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult: map[string]any{
			"success":       true,
			"taskId":        "7",
			"statusChange":  map[string]any{"from": "pending", "to": "completed"},
			"updatedFields": []any{"status"},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "claude-task-list:7" || update.Status != "complete" {
		t.Fatalf("update = %#v, want real complete task update", update)
	}
	if update.Title != "" || len(update.Content) != 0 {
		t.Fatalf("update = %#v, want status-only task update", update)
	}
	if update.Meta["taskId"] != "7" || update.Meta["taskStatus"] != "complete" {
		t.Fatalf("meta = %#v, want real task id and status", update.Meta)
	}
}

func TestSummarizeGenericToolResultContentBlocks(t *testing.T) {
	raw := map[string]any{
		"content": []any{
			map[string]any{"type": "text", "text": "first"},
			map[string]any{"type": "text", "text": "second"},
		},
	}

	got := summarizeGenericToolResult(raw)
	if got != "first\nsecond" {
		t.Fatalf("summarizeGenericToolResult = %q, want content block text", got)
	}
}

func TestSummarizeGenericToolResultJSONString(t *testing.T) {
	got := summarizeGenericToolResult(`{"output":"git diff output"}`)
	if got != "git diff output" {
		t.Fatalf("summarizeGenericToolResult = %q, want decoded output", got)
	}
}

func TestToolResultUpdateCapturesReadFileContent(t *testing.T) {
	callID := "call-read-1"
	s := &session{
		pendingToolCalls: map[string]types.ToolCall{
			callID: {CallID: callID, Status: "running", Kind: types.ToolKindRead},
		},
	}

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &callID,
		ToolUseResult: map[string]any{
			"type": "text",
			"file": map[string]any{
				"filePath": "main.go",
				"content":  "package main\n\nfunc main() {}\n",
			},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if len(update.Content) != 1 || update.Content[0].Text != "package main\n\nfunc main() {}\n" {
		t.Fatalf("content = %#v, want file content", update.Content)
	}
	if update.Meta["output"] != "package main\n\nfunc main() {}\n" {
		t.Fatalf("meta.output = %#v, want file content", update.Meta["output"])
	}
}

func TestToolResultUpdateCapturesSearchContentAndFilenames(t *testing.T) {
	cases := []struct {
		name string
		raw  map[string]any
		want string
	}{
		{
			name: "content mode",
			raw:  map[string]any{"mode": "content", "content": "main.go:12:func main()"},
			want: "main.go:12:func main()",
		},
		{
			name: "files with matches",
			raw:  map[string]any{"mode": "files_with_matches", "filenames": []any{"a.go", "b.go"}},
			want: "a.go\nb.go",
		},
		{
			name: "no matches",
			raw:  map[string]any{"mode": "files_with_matches", "filenames": []any{}},
			want: "No matching files.",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			callID := "call-search-1"
			s := &session{
				pendingToolCalls: map[string]types.ToolCall{
					callID: {CallID: callID, Status: "running", Kind: types.ToolKindSearch},
				},
			}
			update, ok := s.toolResultUpdate(claudeagent.UserMessage{
				ParentToolUseID: &callID,
				ToolUseResult:   tc.raw,
			})
			if !ok {
				t.Fatal("toolResultUpdate returned ok=false")
			}
			if len(update.Content) != 1 || update.Content[0].Text != tc.want {
				t.Fatalf("content = %#v, want %q", update.Content, tc.want)
			}
		})
	}
}

func TestToolResultUpdateCapturesWebSearchLinks(t *testing.T) {
	callID := "call-web-search-1"
	s := &session{
		pendingToolCalls: map[string]types.ToolCall{
			callID: {CallID: callID, Status: "running", Kind: types.ToolKindWebSearch},
		},
	}
	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &callID,
		ToolUseResult: map[string]any{
			"query": "mindfs",
			"results": []any{
				map[string]any{
					"content": []any{
						map[string]any{"title": "MindFS", "url": "https://example.com/mindfs"},
					},
				},
				"Search summary text",
			},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	want := "Search summary text\n\n- [MindFS](https://example.com/mindfs)"
	if len(update.Content) != 1 || update.Content[0].Text != want {
		t.Fatalf("content = %#v, want %q", update.Content, want)
	}
}

func TestToolResultUpdateCapturesFetchTextResult(t *testing.T) {
	callID := "call-fetch-1"
	s := &session{
		pendingToolCalls: map[string]types.ToolCall{
			callID: {CallID: callID, Status: "running", Kind: types.ToolKindFetch},
		},
	}
	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &callID,
		ToolUseResult:   "fetched page text",
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if len(update.Content) != 1 || update.Content[0].Text != "fetched page text" {
		t.Fatalf("content = %#v, want fetched page text", update.Content)
	}
}

func TestToolResultUpdateMatchesParallelCallsByKind(t *testing.T) {
	s := &session{}
	read := types.ToolCall{CallID: "read-1", Status: "running", Kind: types.ToolKindRead, Meta: map[string]any{"filePath": "a.ts"}}
	command := types.ToolCall{CallID: "exec-1", Status: "running", Kind: types.ToolKindExecute, Meta: map[string]any{"command": "ls"}}
	s.trackPendingToolCall(read)
	s.trackPendingToolCall(command)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"stdout": "file-a.ts\n", "stderr": ""},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "exec-1" {
		t.Fatalf("update call id = %q, want exec-1", update.CallID)
	}
	if len(update.Content) != 1 || update.Content[0].Text != "file-a.ts\n" {
		t.Fatalf("content = %#v, want command stdout", update.Content)
	}
	if !s.hasPendingToolCall("read-1") {
		t.Fatal("read call should still be pending")
	}
}

func TestToolResultUpdateMatchesParallelReadsByFilePath(t *testing.T) {
	s := &session{}
	s.trackPendingToolCall(types.ToolCall{CallID: "read-1", Status: "running", Kind: types.ToolKindRead, Meta: map[string]any{"filePath": "a.ts"}})
	s.trackPendingToolCall(types.ToolCall{CallID: "read-2", Status: "running", Kind: types.ToolKindRead, Meta: map[string]any{"filePath": "b.ts"}})

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{
			"type": "text",
			"file": map[string]any{"filePath": "b.ts", "content": "B CONTENT"},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "read-2" {
		t.Fatalf("update call id = %q, want read-2", update.CallID)
	}
	if len(update.Content) != 1 || update.Content[0].Text != "B CONTENT" {
		t.Fatalf("content = %#v, want B CONTENT", update.Content)
	}
	if !s.hasPendingToolCall("read-1") {
		t.Fatal("read-1 should still be pending")
	}
}

func TestToolResultUpdateDrainsAmbiguousParallelCalls(t *testing.T) {
	s := &session{}
	s.trackPendingToolCall(types.ToolCall{CallID: "exec-1", Status: "running", Kind: types.ToolKindExecute, Meta: map[string]any{"command": "sleep 2"}})
	s.trackPendingToolCall(types.ToolCall{CallID: "exec-2", Status: "running", Kind: types.ToolKindExecute, Meta: map[string]any{"command": "echo FAST"}})

	first, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"stdout": "FAST\n", "stderr": ""},
	})
	if !ok {
		t.Fatal("first toolResultUpdate returned ok=false")
	}
	second, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"stdout": "SLOW\n", "stderr": ""},
	})
	if !ok {
		t.Fatal("second toolResultUpdate returned ok=false")
	}
	if first.CallID == second.CallID {
		t.Fatalf("both results mapped to %q", first.CallID)
	}
	if len(s.pendingToolCalls) != 0 {
		t.Fatalf("pending calls after both results = %#v, want empty", s.pendingToolCalls)
	}
}

func TestToolResultUpdateCompletesSubagentCall(t *testing.T) {
	parentID := "agent-call"
	s := &session{}
	s.trackPendingToolCall(types.ToolCall{CallID: parentID, Status: "running", Kind: types.ToolKindTask, Meta: map[string]any{"prompt": "do work"}})
	s.trackPendingToolCall(types.ToolCall{
		CallID: "sub-exec-1",
		Status: "running",
		Kind:   types.ToolKindExecute,
		Meta:   map[string]any{"command": "echo hi", "parentToolUseId": parentID},
	})

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult:   nil,
		Message: claudeagent.APIUserMessage{
			Role:    "user",
			Content: []claudeagent.UserContentBlock{{Type: "tool_result"}},
		},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "sub-exec-1" || update.Status != "complete" {
		t.Fatalf("update = %#v, want subagent call completed", update)
	}
	if !s.hasPendingToolCall(parentID) {
		t.Fatal("parent Task call should still be pending")
	}
}

func TestToolResultUpdateMatchesSubagentResultByParent(t *testing.T) {
	parentID := "agent-call"
	s := &session{}
	s.trackPendingToolCall(types.ToolCall{CallID: parentID, Status: "running", Kind: types.ToolKindTask, Meta: map[string]any{"prompt": "do work"}})
	s.trackPendingToolCall(types.ToolCall{
		CallID: "sub-exec-1",
		Status: "running",
		Kind:   types.ToolKindExecute,
		Meta:   map[string]any{"command": "echo hi", "parentToolUseId": parentID},
	})

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ParentToolUseID: &parentID,
		ToolUseResult:   map[string]any{"stdout": "hi\n", "stderr": ""},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "sub-exec-1" {
		t.Fatalf("update call id = %q, want sub-exec-1", update.CallID)
	}
	if !s.hasPendingToolCall(parentID) {
		t.Fatal("parent Task call should still be pending")
	}
}

func TestToolResultUpdateDoesNotLetStringResultPopReadCall(t *testing.T) {
	s := &session{}
	s.trackPendingToolCall(types.ToolCall{CallID: "read-1", Status: "running", Kind: types.ToolKindRead, Meta: map[string]any{"filePath": "a.ts"}})
	s.trackPendingToolCall(types.ToolCall{CallID: "fetch-1", Status: "running", Kind: types.ToolKindFetch, Meta: map[string]any{}})

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: "fetched text",
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "fetch-1" {
		t.Fatalf("update call id = %q, want fetch-1", update.CallID)
	}
	if !s.hasPendingToolCall("read-1") {
		t.Fatal("read call should still be pending")
	}
}

func TestToolResultUpdateMatchesTaskListCalls(t *testing.T) {
	s := &session{}
	agent := types.ToolCall{CallID: "agent-call", Status: "running", Kind: types.ToolKindTask, Meta: map[string]any{"prompt": "work"}}
	create := types.ToolCall{CallID: "create-call", Status: "running", Kind: types.ToolKindTask, Meta: map[string]any{"taskTool": "TaskCreate"}}
	s.trackPendingToolCall(agent)
	s.trackPendingToolCall(create)

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"task": map[string]any{"id": "7", "subject": "Check"}},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.CallID != "claude-task-list:7" {
		t.Fatalf("update call id = %q, want task list create update", update.CallID)
	}
	if !s.hasPendingToolCall("agent-call") {
		t.Fatal("agent call should still be pending")
	}
}

func TestToolResultUpdateFallsBackToOnlyPendingTool(t *testing.T) {
	s := &session{
		pendingToolCalls: map[string]types.ToolCall{
			"call-1": {
				CallID: "call-1",
				Status: "running",
				Kind:   types.ToolKindExecute,
			},
		},
	}

	update, ok := s.toolResultUpdate(claudeagent.UserMessage{
		ToolUseResult: map[string]any{"content": "command output"},
	})
	if !ok {
		t.Fatal("toolResultUpdate returned ok=false")
	}
	if update.Status != "complete" {
		t.Fatalf("status = %q, want complete", update.Status)
	}
	if len(update.Content) != 1 || !strings.Contains(update.Content[0].Text, "command output") {
		t.Fatalf("content = %#v, want command output", update.Content)
	}
}

func TestClaudePartialContextEmitsLiveUpdate(t *testing.T) {
	var events []types.Event
	s := &session{
		sessionID: "claude-session",
		context:   types.ContextWindow{ModelContextWindow: 200_000},
		onUpdate:  func(event types.Event) { events = append(events, event) },
	}
	raw, err := json.Marshal(map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"usage": map[string]any{
				"input_tokens":                12,
				"cache_read_input_tokens":     90,
				"cache_creation_input_tokens": 8,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	s.handlePartialAssistantMessage(raw, subagentMeta{})
	if len(events) != 1 || events[0].Type != types.EventTypeContextUpdate {
		t.Fatalf("events = %#v, want one context update", events)
	}
	update, ok := events[0].Data.(types.ContextUpdate)
	if !ok {
		t.Fatalf("event data = %T, want ContextUpdate", events[0].Data)
	}
	if update.ContextWindow.TotalTokens != 110 || update.ContextWindow.ModelContextWindow != 200_000 {
		t.Fatalf("context update = %#v", update.ContextWindow)
	}

	s.handlePartialAssistantMessage(raw, subagentMeta{})
	if len(events) != 1 {
		t.Fatalf("unchanged context emitted another update: %#v", events)
	}

	s.handlePartialAssistantMessage(raw, subagentMeta{ParentToolUseID: "tool-1"})
	if len(events) != 1 {
		t.Fatalf("subagent context leaked into parent updates: %#v", events)
	}

	delta, err := json.Marshal(map[string]any{
		"type": "message_delta",
		"usage": map[string]any{
			"input_tokens":            20,
			"cache_read_input_tokens": 100,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.handlePartialAssistantMessage(delta, subagentMeta{})
	if len(events) != 2 {
		t.Fatalf("events = %#v, want a second context update", events)
	}
	update, ok = events[1].Data.(types.ContextUpdate)
	if !ok || update.ContextWindow.TotalTokens != 120 {
		t.Fatalf("delta context update = %#v", events[1].Data)
	}
}

func TestClaudePartialContextEmitsBeforeModelWindowKnown(t *testing.T) {
	var events []types.Event
	s := &session{
		sessionID: "claude-session",
		onUpdate:  func(event types.Event) { events = append(events, event) },
	}
	raw, err := json.Marshal(map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"usage": map[string]any{
				"input_tokens":                42,
				"cache_read_input_tokens":     900,
				"cache_creation_input_tokens": 58,
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	s.handlePartialAssistantMessage(raw, subagentMeta{})
	if len(events) != 1 || events[0].Type != types.EventTypeContextUpdate {
		t.Fatalf("events = %#v, want one context update", events)
	}
	update, ok := events[0].Data.(types.ContextUpdate)
	if !ok {
		t.Fatalf("event data = %T, want ContextUpdate", events[0].Data)
	}
	if update.ContextWindow.TotalTokens != 1000 || update.ContextWindow.ModelContextWindow != 0 {
		t.Fatalf("context update = %#v", update.ContextWindow)
	}
}
