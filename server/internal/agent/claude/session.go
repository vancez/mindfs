package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mindfs/server/internal/agent/logs"
	"mindfs/server/internal/agent/providermodels"
	types "mindfs/server/internal/agent/types"

	claudeagent "github.com/roasbeef/claude-agent-sdk-go"
)

const chunkFlushThreshold = 24

type deltaType string

const (
	deltaTypeText     deltaType = "text"
	deltaTypeThinking deltaType = "thinking"
)

type subagentMeta struct {
	ParentToolUseID string
	TaskID          string
	SubagentType    string
	TaskDescription string
}

type claudeTaskInfo struct {
	ToolUseID       string
	TaskType        string
	Description     string
	SubagentType    string
	TaskDescription string
}

// subagentUsageState tracks one subagent's live usage. Claude's stream gives
// the prompt size on message_start and cumulative per-message output on
// message_delta, so output is committed when the next message starts.
type subagentUsageState struct {
	contextUsed     int
	cacheRead       int
	cacheWrite      int
	outputCommitted int
	outputCurrent   int
	lastContextUsed int
	lastOutput      int
}

type OpenOptions struct {
	AgentName             string
	SessionKey            string
	Model                 string
	Effort                string
	PlanMode              bool
	RootPath              string
	Command               string
	Args                  []string
	Env                   map[string]string
	DeveloperInstructions string
	ResumeSessionID       string
	ForkSessionID         string
	ResumeMessageID       string
	InitialTaskList       *types.TaskListUpdate
}

type Runtime struct{}

func NewRuntime() *Runtime {
	return &Runtime{}
}

func (r *Runtime) OpenSession(ctx context.Context, opts OpenOptions) (types.Session, error) {
	if opts.SessionKey == "" {
		return nil, errors.New("session key required")
	}

	s := &session{
		agentName:     strings.TrimSpace(opts.AgentName),
		sessionKey:    opts.SessionKey,
		rootPath:      strings.TrimSpace(opts.RootPath),
		model:         strings.TrimSpace(opts.Model),
		planMode:      opts.PlanMode,
		agentDebugLog: logs.NewAgentLogger(opts.RootPath, opts.SessionKey, opts.AgentName),
		questionWaits: make(map[string]chan askUserAnswerResult),
	}
	s.seedTaskList(opts.InitialTaskList)

	optionList := []claudeagent.Option{
		claudeagent.WithCwd(opts.RootPath),
		claudeagent.WithEnv(opts.Env),
		claudeagent.WithVerbose(true),
		claudeagent.WithIncludePartialMessages(true),
		claudeagent.WithAgentProgressSummaries(true),
		claudeagent.WithForwardSubagentText(true),
		claudeagent.WithCanUseTool(s.handleCanUseTool),
	}
	optionList = appendClaudeDeveloperInstructions(optionList, opts.DeveloperInstructions)
	if strings.TrimSpace(opts.Command) != "" {
		optionList = append(optionList, claudeagent.WithCLIPath(opts.Command))
	}
	forkSessionID := strings.TrimSpace(opts.ForkSessionID)
	resumeMessageID := strings.TrimSpace(opts.ResumeMessageID)
	explicitSessionID := ""
	if forkSessionID != "" && resumeMessageID != "" {
		forked, err := claudeagent.ForkSession(forkSessionID, &claudeagent.ForkSessionOptions{
			UpToMessageID: resumeMessageID,
		})
		if err != nil {
			return nil, fmt.Errorf("fork claude session at message: %w", err)
		}
		if forked == nil || strings.TrimSpace(forked.SessionID) == "" {
			return nil, errors.New("fork claude session did not return session id")
		}
		explicitSessionID = strings.TrimSpace(forked.SessionID)
		optionList = append(optionList, claudeagent.WithResume(explicitSessionID))
	} else if forkSessionID != "" {
		optionList = append(optionList, claudeagent.WithForkSession(forkSessionID))
	} else if strings.TrimSpace(opts.ResumeSessionID) != "" {
		optionList = append(optionList, claudeagent.WithResume(strings.TrimSpace(opts.ResumeSessionID)))
	}
	if resumeMessageID != "" && forkSessionID == "" {
		optionList = append(optionList, claudeagent.WithResumeSessionAt(resumeMessageID))
	}
	if strings.TrimSpace(opts.Model) != "" {
		optionList = append(optionList, claudeagent.WithModel(strings.TrimSpace(opts.Model)))
	}
	if strings.TrimSpace(opts.Effort) != "" {
		optionList = append(optionList, claudeagent.WithEffort(claudeagent.EffortLevel(strings.TrimSpace(opts.Effort))))
	}
	if opts.PlanMode {
		optionList = append(optionList, claudeagent.WithPermissionMode(claudeagent.PermissionModePlan))
	}

	client, err := claudeagent.NewClient(optionList...)
	if err != nil {
		return nil, err
	}
	stream, err := client.Stream(ctx)
	if err != nil {
		client.Close()
		return nil, err
	}

	selectedModel := strings.TrimSpace(opts.Model)
	if selectedModel == "" && opts.ResumeSessionID == "" {
		if candidate, ok := claudeFirstAvailableModel(client); ok {
			selectedModel = candidate
		}
	}
	if selectedModel != "" {
		if err := stream.SetModel(ctx, selectedModel); err != nil {
			client.Close()
			return nil, err
		}
	}
	if opts.PlanMode {
		if err := stream.SetPermissionMode(ctx, claudeagent.PermissionModePlan); err != nil {
			client.Close()
			return nil, err
		}
	}

	s.client = client
	s.stream = stream
	s.sessionID = stream.SessionID()
	if strings.TrimSpace(s.sessionID) == "" {
		s.sessionID = explicitSessionID
	}
	s.model = selectedModel
	go s.consumeMessages()
	return s, nil
}

func appendClaudeDeveloperInstructions(options []claudeagent.Option, developerInstructions string) []claudeagent.Option {
	if instructions := strings.TrimSpace(developerInstructions); instructions != "" {
		return append(options, claudeagent.WithExtraArgs(map[string]*string{
			"append-system-prompt": &instructions,
		}))
	}
	return options
}

func (r *Runtime) CloseAll() {}

func claudeFirstAvailableModel(client *claudeagent.Client) (string, bool) {
	if client == nil {
		return "", false
	}
	for _, item := range client.SupportedModelsFromInit() {
		candidate := strings.TrimSpace(item.Value)
		if candidate == "" || strings.EqualFold(candidate, "default") {
			continue
		}
		return candidate, true
	}
	return "", false
}

type session struct {
	client *claudeagent.Client
	stream *claudeagent.Stream

	mu         sync.RWMutex
	emitMu     sync.Mutex
	onUpdate   func(types.Event)
	sessionID  string
	sessionKey string
	agentName  string
	// rootPath is the CLI working directory; it determines the Claude projects
	// directory used to locate subagent transcripts.
	rootPath string
	model    string
	planMode bool
	context  types.ContextWindow

	sendMu          sync.Mutex
	turnMu          sync.Mutex
	turns           []chan error
	turnInterrupted bool

	closeOnce sync.Once
	turn      types.TurnCanceler

	agentDebugLog *logs.AgentLogger

	sawDelta       bool
	sawMessageText bool
	// sawSubagentText tracks which subagent refs already streamed text deltas,
	// keyed by parent tool use id (or task id). The session-wide sawDelta flag
	// reflects only the parent turn, so finalized subagent text needs its own
	// per-ref marker to avoid being emitted twice.
	sawSubagentText map[string]bool
	// subagentUsage accumulates each subagent's prompt/context size and output
	// tokens, keyed by parent tool use id. Only the stream consumer goroutine
	// touches this map.
	subagentUsage map[string]*subagentUsageState
	// subagentTranscripts caches resolved transcript paths per task id. Only
	// the stream consumer goroutine touches it.
	subagentTranscripts map[string]string
	pendingText         strings.Builder
	pendingThinking     strings.Builder

	pendingToolMu    sync.Mutex
	pendingToolCalls map[string]types.ToolCall
	pendingToolOrder []string
	taskInfos        map[string]claudeTaskInfo

	// Session task list (Claude TaskCreate/TaskUpdate/TaskList/TaskGet).
	// taskOrder preserves creation order for stable snapshots.
	taskListMu sync.Mutex
	taskItems  map[string]types.TaskItem
	taskOrder  []string

	questionMu    sync.Mutex
	questionWaits map[string]chan askUserAnswerResult
}

func (s *session) ProcessID() int {
	if s == nil || s.client == nil {
		return 0
	}
	return s.client.ProcessID()
}

type askUserAnswerResult struct {
	answers claudeagent.Answers
	err     error
}

func (s *session) SendMessage(ctx context.Context, content string) error {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()

	if s.stream == nil {
		return errors.New("claude session not initialized")
	}
	turnCtx, turnID := s.turn.Begin(ctx)
	defer s.turn.End(turnID)
	s.sawMessageText = false
	log.Printf("[agent/claude] input session=%s content=%q", s.sessionKey, preview(content))

	waiter := make(chan error, 1)
	s.enqueueTurn(waiter)
	if err := s.stream.Send(turnCtx, content); err != nil {
		s.dequeueTurn(waiter)
		log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, err)
		return err
	}

	select {
	case err := <-waiter:
		if err != nil && !isTurnCanceledError(err) {
			log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, err)
		}
		return err
	case <-turnCtx.Done():
		s.dequeueTurn(waiter)
		log.Printf("[agent/claude] send.error session=%s err=%v", s.sessionKey, turnCtx.Err())
		return turnCtx.Err()
	}
}

func (s *session) AnswerQuestion(ctx context.Context, answer types.AskUserAnswer) error {
	callID := strings.TrimSpace(answer.ToolUseID)
	if callID == "" {
		return errors.New("toolUseId required")
	}
	if len(answer.Answers) == 0 {
		return errors.New("answers required")
	}

	s.questionMu.Lock()
	waiter, ok := s.questionWaits[callID]
	s.questionMu.Unlock()
	if !ok {
		return errors.New("question is not pending: " + callID)
	}

	answers := make(claudeagent.Answers, len(answer.Answers))
	for key, value := range answer.Answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			answers[key] = value
		}
	}
	if len(answers) == 0 {
		return errors.New("answers required")
	}

	select {
	case waiter <- askUserAnswerResult{answers: answers}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *session) handleCanUseTool(ctx context.Context, req claudeagent.ToolPermissionRequest) claudeagent.PermissionResult {
	if req.ToolName != "AskUserQuestion" {
		return claudeagent.PermissionAllow{}
	}

	var input claudeagent.AskUserQuestionInput
	if err := json.Unmarshal(req.Arguments, &input); err != nil || len(input.Questions) == 0 {
		return claudeagent.PermissionAllow{}
	}

	callID := strings.TrimSpace(req.Context.ToolUseID)
	if callID == "" {
		return claudeagent.PermissionDeny{Reason: "ask user question missing tool use id"}
	}

	answers, err := s.awaitAskUserQuestion(ctx, claudeagent.QuestionSet{
		ToolUseID: callID,
		Questions: input.Questions,
		SessionID: req.Context.SessionID,
	})
	if err != nil {
		return claudeagent.PermissionDeny{Reason: err.Error()}
	}

	updatedInput := make(map[string]interface{})
	if err := json.Unmarshal(req.Arguments, &updatedInput); err != nil {
		updatedInput["questions"] = input.Questions
	}
	updatedInput["answers"] = normalizeAskUserAnswers(input.Questions, answers)

	return claudeagent.PermissionAllow{UpdatedInput: updatedInput}
}

func normalizeAskUserAnswers(questions []claudeagent.QuestionItem, answers claudeagent.Answers) map[string]string {
	normalized := make(map[string]string, len(answers))

	for key, value := range answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" || askUserQuestionTextForKey(key, questions) != "" {
			continue
		}
		normalized[key] = value
	}
	for key, value := range answers {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key == "" || value == "" {
			continue
		}
		questionText := askUserQuestionTextForKey(key, questions)
		if questionText == "" {
			questionText = key
		}
		if _, exists := normalized[questionText]; !exists {
			normalized[questionText] = value
		}
	}

	return normalized
}

func askUserQuestionTextForKey(key string, questions []claudeagent.QuestionItem) string {
	for index, question := range questions {
		if key == fmt.Sprintf("q_%d", index) {
			return strings.TrimSpace(question.Question)
		}
	}
	return ""
}

func (s *session) CurrentModel() string {
	if s == nil {
		return ""
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return strings.TrimSpace(s.model)
}

func (s *session) SetModel(ctx context.Context, model string) error {
	if s == nil || s.stream == nil {
		return errors.New("claude session not initialized")
	}
	trimmed := strings.TrimSpace(model)
	if err := s.stream.SetModel(ctx, trimmed); err != nil {
		return err
	}
	s.mu.Lock()
	s.model = trimmed
	s.mu.Unlock()
	return nil
}

func (s *session) SetPlanMode(ctx context.Context, enabled bool) error {
	if s == nil || s.stream == nil {
		return errors.New("claude session not initialized")
	}
	mode := claudeagent.PermissionModeDefault
	if enabled {
		mode = claudeagent.PermissionModePlan
	}
	if err := s.stream.SetPermissionMode(ctx, mode); err != nil {
		return err
	}
	s.mu.Lock()
	s.planMode = enabled
	s.mu.Unlock()
	return nil
}

func (s *session) ListModels(ctx context.Context) (types.ModelList, error) {
	_ = ctx
	if s == nil || s.client == nil {
		return types.ModelList{}, errors.New("claude session not initialized")
	}
	supported := s.client.SupportedModelsFromInit()
	models := make([]types.ModelInfo, 0, len(supported))
	for _, model := range supported {
		models = append(models, claudeModelInfo(model))
	}
	models = providermodels.Supplement(s.agentName, "anthropic-compatible", models)
	log.Printf("[agent/claude] models.cached session=%s count=%d", s.sessionKey, len(models))
	currentModelID := ""
	if selected := s.CurrentModel(); selected != "" {
		for _, item := range models {
			if strings.TrimSpace(item.ID) == selected {
				currentModelID = selected
				break
			}
		}
	}
	return types.ModelList{
		CurrentModelID: currentModelID,
		Models:         models,
	}, nil
}

func claudeModelInfo(model claudeagent.ModelInfo) types.ModelInfo {
	name := strings.TrimSpace(model.DisplayName)
	if name == "" {
		name = strings.TrimSpace(model.Value)
	}
	return types.ModelInfo{
		ID:            model.Value,
		Name:          name,
		Description:   model.Description,
		SupportEffort: true,
		Efforts:       claudeEffortLevels(),
	}
}

func claudeEffortLevels() []string {
	return []string{"low", "medium", "high", "xhigh", "max"}
}

func (s *session) SetMode(_ context.Context, _ string) error {
	return nil
}

func (s *session) ListModes(_ context.Context) (types.ModeList, error) {
	return types.ModeList{}, nil
}

func (s *session) ListCommands(ctx context.Context) (types.CommandList, error) {
	_ = ctx
	if s.client == nil {
		return types.CommandList{}, errors.New("claude session not initialized")
	}
	supported := s.client.InitializationInfo().Commands
	commands := make([]types.CommandInfo, 0, len(supported))
	for _, command := range supported {
		name := strings.TrimSpace(command.Name)
		if name == "" || strings.EqualFold(name, "keybindings-help") {
			continue
		}
		commands = append(commands, types.CommandInfo{
			Name:         name,
			Description:  strings.TrimSpace(command.Description),
			ArgumentHint: strings.TrimSpace(command.ArgumentHint),
		})
	}
	log.Printf("[agent/claude] commands.cached session=%s count=%d", s.sessionKey, len(commands))
	return types.CommandList{Commands: commands}, nil
}

func (s *session) OnUpdate(onUpdate func(types.Event)) {
	s.mu.Lock()
	s.onUpdate = onUpdate
	s.mu.Unlock()
}

func (s *session) SessionID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessionID
}

func (s *session) ContextWindow(_ context.Context) (types.ContextWindow, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.context, nil
}

func (s *session) CancelCurrentTurn() error {
	s.cancelPendingQuestions(errors.New("turn canceled"))
	if s.stream == nil {
		s.turn.Cancel()
		return nil
	}
	if err := s.stream.Interrupt(context.Background()); err == nil {
		s.markTurnInterrupted()
		return nil
	}
	s.turn.Cancel()
	return nil
}

func (s *session) cancelPendingQuestions(err error) {
	if err == nil {
		err = errors.New("turn canceled")
	}
	s.questionMu.Lock()
	type pendingQuestion struct {
		callID string
		waiter chan askUserAnswerResult
	}
	waiters := make([]pendingQuestion, 0, len(s.questionWaits))
	for callID, waiter := range s.questionWaits {
		waiters = append(waiters, pendingQuestion{callID: callID, waiter: waiter})
		delete(s.questionWaits, callID)
	}
	s.questionMu.Unlock()

	for _, pending := range waiters {
		select {
		case pending.waiter <- askUserAnswerResult{err: err}:
		default:
		}
		if update, ok := s.cancelPendingToolCall(pending.callID, err.Error()); ok {
			s.emit(types.Event{
				Type:      types.EventTypeToolUpdate,
				SessionID: s.SessionID(),
				Data:      update,
			})
		}
	}
}

func (s *session) Close() error {
	var closeErr error
	s.closeOnce.Do(func() {
		s.cancelPendingQuestions(errors.New("claude session closed"))
		if s.stream != nil {
			closeErr = s.stream.Close()
		}
		if s.client != nil {
			if err := s.client.Close(); err != nil && closeErr == nil {
				closeErr = err
			}
		}
		s.failPendingTurns(errors.New("claude session closed"))
	})
	return closeErr
}

func (s *session) consumeMessages() {
	if s.stream == nil {
		return
	}

	// Claude SDK multiplexes several logical message types onto one channel:
	// - PartialAssistantMessage: incremental tokens for visible text or thinking
	// - AssistantMessage: a finalized assistant payload, including tool_use blocks
	// - UserMessage: a local echo that primarily carries tool_use_result here
	// - ToolProgressMessage: intermediate progress for a running tool call
	// - ResultMessage: the completion or error boundary for the current turn
	//
	// This function normalizes them into our internal session event stream.
	s.sawDelta = false
	s.sawSubagentText = nil
	s.pendingText.Reset()
	s.pendingThinking.Reset()
	for msg := range s.stream.Messages() {
		raw, _ := json.Marshal(msg)
		s.updateSessionID(msg)

		switch m := msg.(type) {
		case claudeagent.PartialAssistantMessage:
			// Incremental text / thinking tokens. Buffer and coalesce them into
			// larger readable chunks before emitting UI updates.
			s.handlePartialAssistantMessage(m.Event, subagentMetaFromPartial(m))
		case claudeagent.StreamEvent:
			s.handleStreamEvent(m)
		case claudeagent.AssistantMessage:
			// Finalized assistant message. Flush pending deltas first so finalized
			// blocks do not interleave with previously buffered streaming output.
			s.flushAllDeltas()
			s.handleAssistantMessage(m, s.sawDelta)
		case claudeagent.UserMessage:
			// Claude SDK surfaces tool execution results as a synthetic "user"
			// message. ToolUseResult maps to the earliest pending tool_use.
			s.flushAllDeltas()
			s.logRawToolResult(m)
			s.handleUserMessage(m)
		case claudeagent.TodoUpdateMessage:
			s.flushAllDeltas()
			s.handleTodoUpdateMessage(m)
		case claudeagent.ToolProgressMessage:
			// Lightweight progress heartbeat for a tool call that is still running.
			// Claude Code gives each heartbeat a synthetic tool_use_id
			// ("<tool_use_id>-heartbeat-N") that still points at the original
			// tool via parent_tool_use_id. Forwarding those would add phantom
			// tool cards and, through the subagent router, phantom child
			// sessions for ordinary long-running commands.
			if isClaudeToolProgressHeartbeat(m) {
				continue
			}
			s.flushAllDeltas()
			s.emitToolUpdate(m.ToolUseID, m.ToolName, subagentMetaFromToolProgress(m))
		case claudeagent.CompactBoundaryMessage:
			s.flushAllDeltas()
			s.handleCompactBoundaryMessage(m)
		case claudeagent.AuthStatusMessage:
			s.flushAllDeltas()
			s.handleAuthStatusMessage(m)
		case claudeagent.SubagentResultMessage:
			s.flushAllDeltas()
			s.handleSubagentResultMessage(m)
		case claudeagent.TaskStartedMessage:
			s.flushAllDeltas()
			s.handleTaskStartedMessage(m)
		case claudeagent.TaskProgressMessage:
			s.flushAllDeltas()
			s.handleTaskProgressMessage(m)
		case claudeagent.TaskUpdatedMessage:
			s.flushAllDeltas()
			s.handleTaskUpdatedMessage(m)
		case claudeagent.TaskNotificationMessage:
			s.flushAllDeltas()
			s.handleTaskNotificationMessage(m)
		case claudeagent.ThinkingTokensMessage:
			// Live estimate for redacted thinking token progress. It is useful
			// telemetry for clients that render token counters, but MindFS does
			// not currently expose it in the session timeline.
		case claudeagent.ResultMessage:
			// End-of-turn boundary. Claude may place the final text here when no
			// incremental tokens were streamed, so emit it as a last fallback.
			s.flushAllDeltas()
			if !s.sawMessageText && strings.TrimSpace(m.Result) != "" {
				s.emitMessageChunk(m.Result)
			}
			s.updateContextWindow(m)
			s.logRawMessage(raw)
			contextWindow, _ := s.ContextWindow(context.Background())
			tokenUsage := claudeTokenUsage(m)
			s.emit(types.Event{
				Type:      types.EventTypeMessageDone,
				SessionID: s.SessionID(),
				Data:      types.MessageDone{ContextWindow: contextWindow, TokenUsage: tokenUsage},
			})
			s.completeTurn(resultErr(m))
			s.sawDelta = false
			s.sawSubagentText = nil
			s.sawMessageText = false
		default:
			s.logRawMessage(raw)
		}
	}

	s.failPendingTurns(errors.New("response stream ended unexpectedly"))
}

func (s *session) handlePartialAssistantMessage(rawEvent json.RawMessage, meta subagentMeta) {
	if meta.hasSubagentRef() {
		// Subagent partials describe the child's prompt size, not this
		// session's. Track them per ref so the child's own session page can
		// show context and output without touching the parent.
		s.recordSubagentPartialUsage(meta, rawEvent)
	} else if contextTokens := contextTokensFromPartialEvent(rawEvent); contextTokens > 0 {
		s.mu.Lock()
		changed := s.context.TotalTokens != contextTokens
		s.context.TotalTokens = contextTokens
		contextWindow := s.context
		s.mu.Unlock()
		// The model's maximum window is only reported in the end-of-turn
		// result. Emit used tokens as soon as they are known so clients
		// can show a token count before a percentage is available.
		if changed && contextWindow.TotalTokens > 0 {
			s.emit(types.Event{
				Type:      types.EventTypeContextUpdate,
				SessionID: s.SessionID(),
				Data:      types.ContextUpdate{ContextWindow: contextWindow},
			})
		}
	}
	textDelta, thinkingDelta := extractDeltas(rawEvent)
	if textDelta == "" && thinkingDelta == "" && len(rawEvent) > 0 && !isKnownNonDisplayPartialEvent(rawEvent) {
		log.Printf("[agent/claude] output.unhandled.partial session=%s raw=%s", s.sessionKey, truncateRaw(rawEvent))
	}
	if meta.hasSubagentRef() {
		s.flushAllDeltas()
		if thinkingDelta != "" {
			s.emitThoughtChunkWithMeta(thinkingDelta, meta)
		}
		if textDelta != "" {
			s.markSubagentTextDelta(meta)
			s.emitMessageChunkWithMeta(textDelta, meta)
		}
		return
	}
	// Thinking and visible text are rendered in separate UI lanes, so flush the
	// other lane before appending to the current one.
	if thinkingDelta != "" {
		s.flushDelta(deltaTypeText)
		s.appendDelta(deltaTypeThinking, thinkingDelta)
	}
	if textDelta != "" {
		s.flushDelta(deltaTypeThinking)
		s.appendDelta(deltaTypeText, textDelta)
	}
}

func (s *session) recordSubagentPartialUsage(meta subagentMeta, rawEvent json.RawMessage) {
	usage := partialUsageFromEvent(rawEvent)
	key := meta.refKey()
	if usage.kind == "" || key == "" {
		return
	}
	if s.subagentUsage == nil {
		s.subagentUsage = make(map[string]*subagentUsageState)
	}
	state := s.subagentUsage[key]
	if state == nil {
		state = &subagentUsageState{}
		s.subagentUsage[key] = state
	}
	switch usage.kind {
	case "message_start":
		// A new API message starts; the previous message's cumulative output
		// is now final.
		state.outputCommitted += state.outputCurrent
		state.outputCurrent = max(0, usage.OutputTokens)
		if contextTokens := usage.contextTokens(); contextTokens > 0 {
			state.contextUsed = contextTokens
			state.cacheRead = max(0, usage.CacheReadInputTokens)
			state.cacheWrite = max(0, usage.CacheCreationInputTokens)
		}
	case "message_delta":
		if contextTokens := usage.contextTokens(); contextTokens > 0 {
			state.contextUsed = contextTokens
			if usage.CacheReadInputTokens > 0 {
				state.cacheRead = usage.CacheReadInputTokens
			}
			if usage.CacheCreationInputTokens > 0 {
				state.cacheWrite = usage.CacheCreationInputTokens
			}
		}
		// message_delta carries the cumulative output for the current message.
		state.outputCurrent = max(state.outputCurrent, max(0, usage.OutputTokens))
	}
	s.emitSubagentContextUpdate(meta, state)
}

func (s *session) emitSubagentContextUpdate(meta subagentMeta, state *subagentUsageState) {
	totalOutput := state.outputCommitted + state.outputCurrent
	if state.contextUsed <= 0 && totalOutput <= 0 {
		return
	}
	if state.lastContextUsed == state.contextUsed && state.lastOutput == totalOutput {
		return
	}
	state.lastContextUsed = state.contextUsed
	state.lastOutput = totalOutput
	cacheRead := state.cacheRead
	cacheWrite := state.cacheWrite
	s.emit(types.Event{
		Type:      types.EventTypeContextUpdate,
		SessionID: s.SessionID(),
		Data: types.ContextUpdate{
			ContextWindow: types.ContextWindow{TotalTokens: state.contextUsed},
			TokenUsage: &types.TokenUsage{
				InputTokens:      state.contextUsed,
				OutputTokens:     totalOutput,
				CacheReadTokens:  &cacheRead,
				CacheWriteTokens: &cacheWrite,
			},
			ParentToolUseID: meta.ParentToolUseID,
			TaskID:          meta.TaskID,
			SubagentType:    meta.SubagentType,
			TaskDescription: meta.TaskDescription,
		},
	})
}

// claudeProjectsRoot is where Claude Code keeps per-project session folders.
func claudeProjectsRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".claude", "projects")
}

// preferredSubagentTranscriptDir is the subagent folder for this session's
// working directory. The CLI derives it from cwd, so it is only a hint; the
// session id itself is unique across projects.
func (s *session) preferredSubagentTranscriptDir() string {
	sessionID := strings.TrimSpace(s.SessionID())
	if sessionID == "" {
		return ""
	}
	root := claudeProjectsRoot()
	if root == "" {
		return ""
	}
	projectDir := claudeProjectDirName(s.rootPath)
	if projectDir == "" {
		return ""
	}
	return filepath.Join(root, projectDir, sessionID, "subagents")
}

func (s *session) subagentTranscriptDirs() []string {
	sessionID := strings.TrimSpace(s.SessionID())
	root := claudeProjectsRoot()
	if sessionID == "" || root == "" {
		return nil
	}
	dirs := make([]string, 0, 2)
	if preferred := s.preferredSubagentTranscriptDir(); preferred != "" {
		dirs = append(dirs, preferred)
	}
	matches, err := filepath.Glob(filepath.Join(root, "*", sessionID, "subagents"))
	if err == nil {
		for _, dir := range matches {
			duplicate := false
			for _, existing := range dirs {
				if filepath.Clean(existing) == filepath.Clean(dir) {
					duplicate = true
					break
				}
			}
			if !duplicate {
				dirs = append(dirs, dir)
			}
		}
	}
	return dirs
}

// resolveSubagentTranscriptPath prefers the task-id filename and falls back to
// the sibling meta file's toolUseId, so the lookup survives CLI versions that
// name subagent transcripts by agent id instead.
func (s *session) resolveSubagentTranscriptPath(taskID, toolUseID string) string {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return ""
	}
	if path := s.subagentTranscripts[taskID]; path != "" {
		return path
	}
	dirs := s.subagentTranscriptDirs()
	for _, dir := range dirs {
		candidate := filepath.Join(dir, "agent-"+taskID+".jsonl")
		if _, err := os.Stat(candidate); err == nil {
			s.cacheSubagentTranscriptPath(taskID, candidate)
			return candidate
		}
	}
	toolUseID = strings.TrimSpace(toolUseID)
	if toolUseID == "" {
		return ""
	}
	for _, dir := range dirs {
		metas, err := filepath.Glob(filepath.Join(dir, "*.meta.json"))
		if err != nil {
			continue
		}
		for _, metaPath := range metas {
			raw, err := os.ReadFile(metaPath)
			if err != nil {
				continue
			}
			var meta struct {
				ToolUseID string `json:"toolUseId"`
			}
			if json.Unmarshal(raw, &meta) != nil || strings.TrimSpace(meta.ToolUseID) != toolUseID {
				continue
			}
			candidate := strings.TrimSuffix(metaPath, ".meta.json") + ".jsonl"
			if _, err := os.Stat(candidate); err != nil {
				continue
			}
			s.cacheSubagentTranscriptPath(taskID, candidate)
			return candidate
		}
	}
	return ""
}

func (s *session) cacheSubagentTranscriptPath(taskID, path string) {
	if s.subagentTranscripts == nil {
		s.subagentTranscripts = make(map[string]string)
	}
	s.subagentTranscripts[taskID] = path
}

type claudeTranscriptUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
}

type claudeTranscriptLine struct {
	Type    string `json:"type"`
	Message struct {
		ID    string                 `json:"id"`
		Usage *claudeTranscriptUsage `json:"usage"`
	} `json:"message"`
}

// readClaudeSubagentTranscriptUsage aggregates a subagent transcript. Content
// blocks of one API message repeat the same usage, so output is summed once
// per message id while the latest entry supplies the current context size.
func readClaudeSubagentTranscriptUsage(path string) (types.ContextWindow, *types.TokenUsage, bool) {
	file, err := os.Open(path)
	if err != nil {
		return types.ContextWindow{}, nil, false
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	outputByMessage := make(map[string]int)
	totalOutput := 0
	contextUsed := 0
	cacheRead := 0
	cacheWrite := 0
	seen := false
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry claudeTranscriptLine
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			continue
		}
		if entry.Type != "assistant" || entry.Message.Usage == nil {
			continue
		}
		seen = true
		usage := entry.Message.Usage
		contextUsed = usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
		cacheRead = usage.CacheReadInputTokens
		cacheWrite = usage.CacheCreationInputTokens
		messageID := strings.TrimSpace(entry.Message.ID)
		if messageID == "" {
			messageID = "line-" + strconv.Itoa(lineNumber)
		}
		if output := max(0, usage.OutputTokens); output > outputByMessage[messageID] {
			totalOutput += output - outputByMessage[messageID]
			outputByMessage[messageID] = output
		}
	}
	if !seen {
		return types.ContextWindow{}, nil, false
	}
	return types.ContextWindow{TotalTokens: contextUsed}, &types.TokenUsage{
		InputTokens:      contextUsed,
		OutputTokens:     totalOutput,
		CacheReadTokens:  &cacheRead,
		CacheWriteTokens: &cacheWrite,
	}, true
}

func (s *session) emitSubagentTranscriptUsage(meta subagentMeta, taskID string, waitForOutput bool) {
	path := s.resolveSubagentTranscriptPath(taskID, meta.ParentToolUseID)
	if path == "" {
		return
	}
	contextWindow, usage, ok := readClaudeSubagentTranscriptUsage(path)
	if !ok {
		return
	}
	// The CLI writes the task's final transcript line just after the terminal
	// notification; poll briefly so the output count is not recorded as zero.
	deadline := time.Now().Add(800 * time.Millisecond)
	for waitForOutput && usage != nil && usage.OutputTokens == 0 && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		if window, next, found := readClaudeSubagentTranscriptUsage(path); found {
			contextWindow, usage, ok = window, next, true
		}
	}
	s.emit(types.Event{
		Type:      types.EventTypeContextUpdate,
		SessionID: s.SessionID(),
		Data: types.ContextUpdate{
			ContextWindow:   contextWindow,
			TokenUsage:      usage,
			ParentToolUseID: meta.ParentToolUseID,
			TaskID:          meta.TaskID,
			SubagentType:    meta.SubagentType,
			TaskDescription: meta.TaskDescription,
		},
	})
}

func (s *session) pendingBuilder(kind deltaType) *strings.Builder {
	if kind == deltaTypeThinking {
		return &s.pendingThinking
	}
	return &s.pendingText
}

func (s *session) flushAllDeltas() {
	s.flushDelta(deltaTypeText)
	s.flushDelta(deltaTypeThinking)
}

func (s *session) flushDelta(kind deltaType) {
	pending := s.pendingBuilder(kind)
	if pending.Len() == 0 {
		return
	}
	delta := pending.String()
	pending.Reset()
	if kind == deltaTypeThinking {
		s.emitThoughtChunk(delta)
		return
	}
	s.sawDelta = true
	s.emitMessageChunk(delta)
}

func (s *session) appendDelta(kind deltaType, delta string) {
	if delta == "" {
		return
	}
	pending := s.pendingBuilder(kind)
	pending.WriteString(delta)
	// Coalesce token-level fragments into readable chunks while keeping streaming feel.
	if pending.Len() >= chunkFlushThreshold || strings.ContainsAny(delta, "\n.!?;:") {
		s.flushDelta(kind)
	}
}

func (s *session) emitThoughtChunk(content string) {
	s.emitThoughtChunkWithMeta(content, subagentMeta{})
}

func (s *session) emitThoughtChunkWithMeta(content string, meta subagentMeta) {
	s.emit(types.Event{
		Type:      types.EventTypeThoughtChunk,
		SessionID: s.SessionID(),
		Data: types.ThoughtChunk{
			Content:         content,
			ParentToolUseID: meta.ParentToolUseID,
			TaskID:          meta.TaskID,
			SubagentType:    meta.SubagentType,
			TaskDescription: meta.TaskDescription,
		},
	})
}

func (s *session) handleAssistantMessage(msg claudeagent.AssistantMessage, sawDelta bool) {
	meta := subagentMetaFromAssistant(msg)
	sawFinalizedText := false
	for _, block := range msg.Message.Content {
		switch block.Type {
		case "text":
			sawFinalizedText = true
			// If text was already streamed via partial deltas, skip the duplicated
			// finalized text block. Subagent turns stream independently from the
			// parent, so they need their own per-ref marker instead of sawDelta.
			if meta.hasSubagentRef() {
				if s.subagentTextStreamed(meta) {
					continue
				}
			} else if sawDelta {
				continue
			}
			s.emitMessageChunkWithMeta(block.Text, meta)
		case "thinking":
			s.emitThoughtChunkWithMeta(block.Text, meta)
		case "tool_use":
			// tool_use is the structured tool invocation request. Its completion
			// arrives later as UserMessage + ToolUseResult.
			s.logRawToolCallBlock(block)
			toolCall := newRunningToolCall(block.ID, block.Name, block.Type, block.Input)
			toolCall.Meta = mergeToolCallMeta(toolCall.Meta, meta.toMap())
			if isTaskListToolName(block.Name) {
				toolCall.Meta = mergeToolCallMeta(toolCall.Meta, map[string]any{
					"taskTool":  canonicalTaskListToolName(block.Name),
					"toolUseId": block.ID,
				})
				s.trackPendingToolCall(toolCall)
				continue
			}
			s.trackPendingToolCall(toolCall)
			s.emit(types.Event{
				Type:      types.EventTypeToolCall,
				SessionID: s.SessionID(),
				Data:      toolCall,
			})
		}
	}
	if sawFinalizedText && meta.hasSubagentRef() {
		s.clearSubagentTextDelta(meta)
	}
}

func (s *session) handleUserMessage(msg claudeagent.UserMessage) {
	// Claude tool results do not come back on AssistantMessage. They arrive
	// here, and we map the result onto the earliest pending tool call.
	update, ok := s.toolResultUpdate(msg)
	if !ok {
		return
	}
	s.emit(types.Event{
		Type:      types.EventTypeToolUpdate,
		SessionID: s.SessionID(),
		Data:      update,
	})
}

func (s *session) handleTodoUpdateMessage(msg claudeagent.TodoUpdateMessage) {
	items := make([]types.TodoItem, 0, len(msg.Items))
	for _, item := range msg.Items {
		items = append(items, types.TodoItem{
			Content:    item.Content,
			ActiveForm: item.ActiveForm,
			Status:     string(item.Status),
		})
	}
	s.emit(types.Event{
		Type:      types.EventTypeTodoUpdate,
		SessionID: s.SessionID(),
		Data:      types.TodoUpdate{Items: items},
	})
}

func (s *session) handleStreamEvent(msg claudeagent.StreamEvent) {
	if msg.Delta != "" {
		s.emitMessageChunk(msg.Delta)
		return
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return
	}
	s.handlePartialAssistantMessage(raw, subagentMeta{})
}

func (s *session) handleCompactBoundaryMessage(msg claudeagent.CompactBoundaryMessage) {
	s.emit(types.Event{
		Type:      types.EventTypeCompact,
		SessionID: s.SessionID(),
		Data: types.CompactNotice{
			ID:      firstNonEmpty(msg.UUID, msg.SessionID),
			Status:  strings.TrimSpace(msg.CompactMetadata.Trigger),
			Summary: compactBoundarySummary(msg),
		},
	})
}

func (s *session) handleAuthStatusMessage(msg claudeagent.AuthStatusMessage) {
	status := "success"
	if msg.IsAuthenticating {
		status = "running"
	}
	if strings.TrimSpace(msg.Error) != "" {
		status = "failed"
	}
	lines := append([]string(nil), msg.Output...)
	if errText := strings.TrimSpace(msg.Error); errText != "" {
		lines = append(lines, errText)
	}
	callID := firstNonEmpty(msg.UUID, "auth-"+msg.SessionID, "auth-status")
	s.emit(types.Event{
		Type:      types.EventTypeToolUpdate,
		SessionID: s.SessionID(),
		Data: types.ToolCall{
			CallID:  callID,
			Title:   "authentication",
			Status:  status,
			Kind:    types.ToolKindOther,
			RawType: "auth_status",
			Content: []types.ToolCallContentItem{{Type: "text", Text: strings.Join(lines, "\n")}},
			Meta: map[string]any{
				"rawType":          "auth_status",
				"isAuthenticating": msg.IsAuthenticating,
			},
		},
	})
}

func (s *session) handleSubagentResultMessage(msg claudeagent.SubagentResultMessage) {
	agentName := strings.TrimSpace(msg.AgentName)
	title := firstNonEmpty(agentName, "subagent")
	status := "complete"
	if strings.EqualFold(strings.TrimSpace(msg.Status), "error") {
		status = "failed"
	}
	callID := "subagent-result-" + strings.ToLower(strings.ReplaceAll(title, " ", "-"))
	s.emit(types.Event{
		Type:      types.EventTypeToolUpdate,
		SessionID: s.SessionID(),
		Data: types.ToolCall{
			CallID:  callID,
			Title:   title,
			Status:  status,
			Kind:    types.ToolKindTask,
			RawType: "subagent_result",
			Content: []types.ToolCallContentItem{{Type: "text", Text: strings.TrimSpace(msg.Result)}},
			Meta: map[string]any{
				"rawType":      "subagent_result",
				"subagentType": agentName,
				"status":       strings.TrimSpace(msg.Status),
			},
		},
	})
}

func (s *session) handleTaskStartedMessage(msg claudeagent.TaskStartedMessage) {
	s.trackTaskInfo(msg.TaskID, claudeTaskInfo{
		ToolUseID:       msg.ToolUseID,
		TaskType:        msg.TaskType,
		Description:     msg.Description,
		SubagentType:    msg.SubagentType,
		TaskDescription: msg.Description,
	})
	if isIgnoredClaudeTaskType(msg.TaskType) {
		return
	}
	toolCall := claudeTaskToolCall(
		firstNonEmpty(msg.ToolUseID, msg.TaskID),
		"running",
		msg.Description,
		msg.Prompt,
		subagentMeta{
			ParentToolUseID: msg.ToolUseID,
			TaskID:          msg.TaskID,
			SubagentType:    msg.SubagentType,
			TaskDescription: msg.Description,
		},
		map[string]any{
			"subtype":      msg.Subtype,
			"taskType":     msg.TaskType,
			"workflowName": msg.WorkflowName,
		},
	)
	if strings.TrimSpace(toolCall.CallID) != "" {
		s.trackPendingToolCall(toolCall)
	}
	s.emit(types.Event{Type: types.EventTypeToolCall, SessionID: s.SessionID(), Data: toolCall})
}

func (s *session) handleTaskProgressMessage(msg claudeagent.TaskProgressMessage) {
	if isIgnoredClaudeTaskType(s.taskType(msg.TaskID)) {
		return
	}
	s.trackTaskInfo(msg.TaskID, claudeTaskInfo{
		ToolUseID:       msg.ToolUseID,
		Description:     msg.Description,
		SubagentType:    msg.SubagentType,
		TaskDescription: msg.Description,
	})
	callID := firstNonEmpty(msg.ToolUseID, msg.TaskID)
	meta := subagentMeta{
		ParentToolUseID: msg.ToolUseID,
		TaskID:          msg.TaskID,
		SubagentType:    msg.SubagentType,
		TaskDescription: msg.Description,
	}
	// Feed the child's live context/output from the on-disk transcript; the
	// CLI does not forward subagent partial usage on the main stream.
	s.emitSubagentTranscriptUsage(meta, msg.TaskID, false)
	toolCall := claudeTaskToolCall(
		callID,
		"running",
		msg.Description,
		msg.Summary,
		meta,
		map[string]any{
			"subtype":      msg.Subtype,
			"lastToolName": msg.LastToolName,
			"progress":     firstNonEmpty(msg.Summary, msg.Description),
		},
	)
	if s.hasPendingToolCall(callID) {
		toolCall.Title = ""
	}
	s.emit(types.Event{Type: types.EventTypeToolUpdate, SessionID: s.SessionID(), Data: toolCall})
}

func (s *session) handleTaskUpdatedMessage(msg claudeagent.TaskUpdatedMessage) {
	info := s.taskInfo(msg.TaskID)
	if isIgnoredClaudeTaskType(info.TaskType) {
		return
	}
	description := firstNonEmpty(msg.Patch.Description, info.TaskDescription, info.Description)
	toolCall := claudeTaskToolCall(
		firstNonEmpty(info.ToolUseID, msg.TaskID),
		claudeTaskRunStatus(string(msg.Patch.Status)),
		description,
		msg.Patch.Error,
		subagentMeta{
			ParentToolUseID: info.ToolUseID,
			TaskID:          msg.TaskID,
			SubagentType:    info.SubagentType,
			TaskDescription: description,
		},
		map[string]any{
			"subtype":        msg.Subtype,
			"error":          msg.Patch.Error,
			"isBackgrounded": boolPtrValue(msg.Patch.IsBackgrounded),
		},
	)
	s.emit(types.Event{Type: types.EventTypeToolUpdate, SessionID: s.SessionID(), Data: toolCall})
}

func (s *session) handleTaskNotificationMessage(msg claudeagent.TaskNotificationMessage) {
	info := s.taskInfo(msg.TaskID)
	if isIgnoredClaudeTaskType(info.TaskType) {
		return
	}
	status := "complete"
	switch msg.Status {
	case claudeagent.TaskNotificationStatusFailed:
		status = "failed"
	case claudeagent.TaskNotificationStatusStopped:
		status = "cancelled"
	}
	extra := map[string]any{
		"subtype":    msg.Subtype,
		"outputFile": msg.OutputFile,
	}
	if strings.TrimSpace(msg.Summary) != "" {
		extra["summary"] = msg.Summary
	}
	meta := subagentMeta{
		ParentToolUseID: firstNonEmpty(msg.ToolUseID, info.ToolUseID),
		TaskID:          msg.TaskID,
		SubagentType:    info.SubagentType,
		TaskDescription: msg.Summary,
	}
	// Emit usage before the terminal tool update, which closes the child. The
	// transcript's final output line can land just after this notification.
	s.emitSubagentTranscriptUsage(meta, msg.TaskID, true)
	toolCall := claudeTaskToolCall(
		firstNonEmpty(msg.ToolUseID, info.ToolUseID, msg.TaskID),
		status,
		msg.Summary,
		msg.Summary,
		meta,
		extra,
	)
	s.emit(types.Event{Type: types.EventTypeToolUpdate, SessionID: s.SessionID(), Data: toolCall})
}

func (s *session) awaitAskUserQuestion(ctx context.Context, qs claudeagent.QuestionSet) (claudeagent.Answers, error) {
	callID := strings.TrimSpace(qs.ToolUseID)
	if callID == "" {
		return nil, errors.New("ask user question missing tool use id")
	}

	waiter := make(chan askUserAnswerResult, 1)
	s.questionMu.Lock()
	if s.questionWaits == nil {
		s.questionWaits = make(map[string]chan askUserAnswerResult)
	}
	if _, exists := s.questionWaits[callID]; exists {
		s.questionMu.Unlock()
		return nil, errors.New("ask user question already pending: " + callID)
	}
	s.questionWaits[callID] = waiter
	s.questionMu.Unlock()
	defer func() {
		s.questionMu.Lock()
		delete(s.questionWaits, callID)
		s.questionMu.Unlock()
	}()

	// The assistant message that carries this tool_use is queued on the SDK
	// stream consumer. Wait for it to emit the tool card first: the control
	// callback runs on the SDK message pump, so emitting here immediately
	// races the consumer and can place the question before the text that was
	// streamed just before it (and after a reload the persisted aux line keeps
	// that wrong order). Fall back to a synthetic card when the assistant
	// message is not available.
	if !s.waitForAssistantAskUser(ctx, callID) {
		toolCall := askUserQuestionToolCall(qs)
		s.trackPendingToolCall(toolCall)
		s.emit(types.Event{
			Type:      types.EventTypeToolCall,
			SessionID: s.SessionID(),
			Data:      toolCall,
		})
	}

	select {
	case result := <-waiter:
		if result.err != nil {
			return nil, result.err
		}
		if len(result.answers) == 0 {
			return nil, errors.New("empty ask user answers")
		}
		return result.answers, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

const assistantAskUserWait = 300 * time.Millisecond

func (s *session) waitForAssistantAskUser(ctx context.Context, callID string) bool {
	if s == nil {
		return false
	}
	if s.hasPendingToolCall(callID) {
		return true
	}
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(assistantAskUserWait)
	defer deadline.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return s.hasPendingToolCall(callID)
		case <-ticker.C:
			if s.hasPendingToolCall(callID) {
				return true
			}
		}
	}
}

func askUserQuestionToolCall(qs claudeagent.QuestionSet) types.ToolCall {
	questions := make([]types.AskUserQuestionItem, 0, len(qs.Questions))
	for _, question := range qs.Questions {
		options := make([]types.AskUserQuestionOption, 0, len(question.Options))
		for _, option := range question.Options {
			options = append(options, types.AskUserQuestionOption{
				Label:       option.Label,
				Description: option.Description,
			})
		}
		questions = append(questions, types.AskUserQuestionItem{
			Question:    question.Question,
			Header:      question.Header,
			Options:     options,
			MultiSelect: question.MultiSelect,
		})
	}

	payload := claudeagent.AskUserQuestionInput{Questions: qs.Questions}
	raw, _ := json.Marshal(payload)
	toolCall := newRunningToolCall(qs.ToolUseID, "AskUserQuestion", "tool_use", raw)
	if toolCall.Meta == nil {
		toolCall.Meta = map[string]any{}
	}
	toolCall.Meta["toolUseId"] = qs.ToolUseID
	toolCall.Meta["questions"] = questions
	if qs.ParentToolUseID != nil && strings.TrimSpace(*qs.ParentToolUseID) != "" {
		toolCall.Meta["parentToolUseId"] = strings.TrimSpace(*qs.ParentToolUseID)
	}
	return toolCall
}

func newRunningToolCall(callID, name, rawType string, input json.RawMessage) types.ToolCall {
	title, meta, locations, content := summarizeToolCall(name, input)
	return types.ToolCall{
		CallID:    callID,
		Title:     title,
		Status:    "running",
		Kind:      mapToolKind(name),
		Locations: locations,
		Content:   content,
		RawType:   rawType,
		Meta:      meta,
	}
}

func summarizeToolCall(name string, input json.RawMessage) (string, map[string]any, []types.ToolCallLocation, []types.ToolCallContentItem) {
	rawInput := strings.TrimSpace(string(input))
	if rawInput == "" {
		return name, nil, nil, nil
	}

	meta := map[string]any{"input": rawInput}
	switch mapToolKind(name) {
	case types.ToolKindRead, types.ToolKindEdit:
		return summarizePathToolCall(name, input, meta)
	case types.ToolKindExecute:
		title, nextMeta := summarizeExecuteToolCall(name, input, meta)
		return title, nextMeta, nil, nil
	case types.ToolKindSearch:
		title, nextMeta := summarizeSearchToolCall(name, input, meta)
		return title, nextMeta, nil, nil
	case types.ToolKindWebSearch:
		title, nextMeta, content := summarizeWebSearchToolCall(input, meta)
		return title, nextMeta, nil, content
	case types.ToolKindTask:
		title, nextMeta, content := summarizeTaskToolCall(name, input, meta)
		return title, nextMeta, nil, content
	case types.ToolKindAskUser:
		title, nextMeta, content := summarizeAskUserToolCall(input, meta)
		return title, nextMeta, nil, content
	case types.ToolKindTodo:
		title, nextMeta, content := summarizeTodoToolCall(input, meta)
		return title, nextMeta, nil, content
	default:
		return name, meta, nil, nil
	}
}

func summarizePathToolCall(name string, input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallLocation, []types.ToolCallContentItem) {
	var payload struct {
		FilePath   string `json:"file_path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		Content    string `json:"content"`
		ReplaceAll bool   `json:"replace_all"`
	}
	if err := json.Unmarshal(input, &payload); err != nil {
		return name, fallbackMeta, nil, nil
	}

	path := strings.TrimSpace(payload.FilePath)
	if path == "" {
		return name, fallbackMeta, nil, nil
	}

	base := strings.TrimSpace(filepath.Base(path))
	if base == "" || base == "." || base == string(filepath.Separator) {
		return name, fallbackMeta, nil, nil
	}

	meta := map[string]any{"filePath": path}
	if fallbackMeta != nil {
		meta["input"] = fallbackMeta["input"]
	}
	if payload.ReplaceAll {
		meta["replaceAll"] = true
	}

	locations := []types.ToolCallLocation{{Path: path}}
	content := make([]types.ToolCallContentItem, 0, 1)

	switch strings.ToLower(strings.TrimSpace(name)) {
	case "write":
		if payload.Content != "" {
			content = append(content, types.ToolCallContentItem{
				Type:       "text",
				Text:       payload.Content,
				Path:       path,
				ChangeKind: "add",
			})
		}
	case "edit", "multiedit":
		if payload.OldString != "" || payload.NewString != "" {
			oldText := payload.OldString
			content = append(content, types.ToolCallContentItem{
				Type:    "diff",
				Path:    path,
				OldText: &oldText,
				NewText: payload.NewString,
			})
		}
	}

	return base, meta, locations, content
}

func summarizeExecuteToolCall(name string, input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any) {
	var payload claudeagent.BashInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return name, fallbackMeta
	}

	command := strings.TrimSpace(payload.Command)
	if command == "" {
		return name, fallbackMeta
	}

	meta := map[string]any{"command": command}
	if desc := strings.TrimSpace(payload.Description); desc != "" {
		meta["description"] = desc
		return desc, meta
	}
	return "Run command", meta
}

func summarizeSearchToolCall(name string, input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any) {
	var payload struct {
		Pattern string `json:"pattern"`
		Query   string `json:"query"`
		Path    string `json:"path"`
	}
	if err := json.Unmarshal(input, &payload); err != nil {
		return name, fallbackMeta
	}

	switch {
	case strings.TrimSpace(payload.Pattern) != "":
		return payload.Pattern, map[string]any{"pattern": payload.Pattern}
	case strings.TrimSpace(payload.Query) != "":
		return payload.Query, map[string]any{"query": payload.Query}
	case strings.TrimSpace(payload.Path) != "":
		return payload.Path, map[string]any{"path": payload.Path}
	default:
		return name, fallbackMeta
	}
}

func summarizeTodoToolCall(input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallContentItem) {
	var payload claudeagent.TodoWriteInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "todos", fallbackMeta, nil
	}
	if len(payload.Todos) == 0 {
		return "todos", fallbackMeta, nil
	}

	lines := make([]string, 0, len(payload.Todos))
	for _, todo := range payload.Todos {
		label := strings.TrimSpace(todo.Content)
		active := strings.TrimSpace(todo.ActiveForm)
		status := strings.ToLower(strings.TrimSpace(todo.Status))
		switch status {
		case "completed":
			if label == "" {
				label = active
			}
			if label == "" {
				continue
			}
			lines = append(lines, "- [x] "+label)
		case "in_progress":
			if active != "" {
				label = active
			}
			if label == "" {
				continue
			}
			lines = append(lines, "- [ ] "+label+" _(in progress)_")
		default:
			if label == "" {
				label = active
			}
			if label == "" {
				continue
			}
			lines = append(lines, "- [ ] "+label)
		}
	}
	if len(lines) == 0 {
		return "todos", fallbackMeta, nil
	}

	meta := map[string]any{"todoCount": len(lines)}
	if fallbackMeta != nil {
		for k, v := range fallbackMeta {
			meta[k] = v
		}
	}

	return "todos", meta, []types.ToolCallContentItem{{
		Type: "text",
		Text: strings.Join(lines, "\n"),
	}}
}

func summarizeTaskToolCall(name string, input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallContentItem) {
	if title, meta, content, ok := summarizeTaskListToolCall(name, input, fallbackMeta); ok {
		return title, meta, content
	}
	var payload claudeagent.TaskInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "task", fallbackMeta, nil
	}

	description := strings.TrimSpace(payload.Description)
	prompt := strings.TrimSpace(payload.Prompt)
	subagentType := strings.TrimSpace(payload.SubagentType)

	title := description
	if title == "" {
		title = prompt
	}
	if title == "" {
		title = "task"
	}

	meta := cloneToolMeta(fallbackMeta)
	if subagentType != "" {
		meta["subagentType"] = subagentType
	}
	if description != "" {
		meta["description"] = description
	}
	if prompt != "" {
		meta["prompt"] = prompt
	}

	lines := make([]string, 0, 3)
	if subagentType != "" {
		lines = append(lines, "**Subagent:** "+subagentType)
	}
	if description != "" {
		lines = append(lines, "**Description:** "+description)
	}
	if prompt != "" && prompt != description {
		lines = append(lines, "**Prompt:**\n"+prompt)
	}
	if len(lines) == 0 {
		return title, meta, nil
	}

	return title, meta, []types.ToolCallContentItem{{
		Type: "text",
		Text: strings.Join(lines, "\n\n"),
	}}
}

func summarizeTaskListToolCall(name string, input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallContentItem, bool) {
	switch normalizeToolName(name) {
	case "taskcreate":
		var payload struct {
			Subject     string `json:"subject"`
			Description string `json:"description"`
			ActiveForm  string `json:"activeForm"`
		}
		if err := json.Unmarshal(input, &payload); err != nil {
			return "task", fallbackMeta, nil, true
		}
		subject := strings.TrimSpace(payload.Subject)
		description := strings.TrimSpace(payload.Description)
		activeForm := strings.TrimSpace(payload.ActiveForm)
		title := firstNonEmpty(subject, activeForm, description, "task")
		meta := cloneToolMeta(fallbackMeta)
		if subject != "" {
			meta["subject"] = subject
		}
		if description != "" {
			meta["description"] = description
		}
		if activeForm != "" {
			meta["activeForm"] = activeForm
		}
		if description == "" || description == title {
			return title, meta, nil, true
		}
		return title, meta, []types.ToolCallContentItem{{Type: "text", Text: description}}, true
	case "taskupdate":
		var payload struct {
			TaskID string `json:"taskId"`
			Status string `json:"status"`
		}
		if err := json.Unmarshal(input, &payload); err != nil {
			return "", fallbackMeta, nil, true
		}
		meta := cloneToolMeta(fallbackMeta)
		if taskID := strings.TrimSpace(payload.TaskID); taskID != "" {
			meta["taskId"] = taskID
		}
		if status := normalizeTaskListStatus(payload.Status); status != "" {
			meta["taskStatus"] = status
		}
		return "", meta, nil, true
	case "tasklist":
		return "TaskList", cloneToolMeta(fallbackMeta), nil, true
	case "taskget":
		var payload struct {
			TaskID string `json:"taskId"`
		}
		meta := cloneToolMeta(fallbackMeta)
		if err := json.Unmarshal(input, &payload); err == nil {
			if taskID := strings.TrimSpace(payload.TaskID); taskID != "" {
				meta["taskId"] = taskID
			}
		}
		return "TaskGet", meta, nil, true
	default:
		return "", nil, nil, false
	}
}

func normalizeTaskListStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed", "complete", "done":
		return "complete"
	case "inprogress", "in_progress", "running":
		return "running"
	case "pending", "todo", "notstarted", "not_started":
		return "pending"
	case "failed", "error":
		return "failed"
	case "cancelled", "canceled":
		return "cancelled"
	case "deleted", "removed":
		return "deleted"
	default:
		return ""
	}
}

func taskListCallID(taskID string) string {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return ""
	}
	return "claude-task-list:" + taskID
}

func isTaskListToolName(name string) bool {
	return canonicalTaskListToolName(name) != ""
}

func canonicalTaskListToolName(name string) string {
	switch normalizeToolName(name) {
	case "taskcreate":
		return "TaskCreate"
	case "taskupdate":
		return "TaskUpdate"
	case "tasklist":
		return "TaskList"
	case "taskget":
		return "TaskGet"
	default:
		return ""
	}
}

func summarizeAskUserToolCall(input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallContentItem) {
	var payload claudeagent.AskUserQuestionInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "ask user", fallbackMeta, nil
	}
	if len(payload.Questions) == 0 {
		return "ask user", fallbackMeta, nil
	}

	meta := cloneToolMeta(fallbackMeta)
	meta["questionCount"] = len(payload.Questions)

	sections := make([]string, 0, len(payload.Questions))
	for index, question := range payload.Questions {
		lines := make([]string, 0, 2+len(question.Options))
		header := strings.TrimSpace(question.Header)
		text := strings.TrimSpace(question.Question)
		if header != "" {
			lines = append(lines, fmt.Sprintf("**Q%d · %s**", index+1, header))
		} else {
			lines = append(lines, fmt.Sprintf("**Q%d**", index+1))
		}
		if text != "" {
			lines = append(lines, text)
		}
		if question.MultiSelect {
			lines = append(lines, "_Multiple selection allowed._")
		}
		for _, option := range question.Options {
			label := strings.TrimSpace(option.Label)
			description := strings.TrimSpace(option.Description)
			if label == "" {
				continue
			}
			if description != "" {
				lines = append(lines, fmt.Sprintf("- **%s**: %s", label, description))
			} else {
				lines = append(lines, "- "+label)
			}
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}

	title := "ask user"
	if len(payload.Questions) == 1 {
		if header := strings.TrimSpace(payload.Questions[0].Header); header != "" {
			title = header
		} else if text := strings.TrimSpace(payload.Questions[0].Question); text != "" {
			title = text
		}
	}

	return title, meta, []types.ToolCallContentItem{{
		Type: "text",
		Text: strings.Join(sections, "\n\n"),
	}}
}

func summarizeWebSearchToolCall(input json.RawMessage, fallbackMeta map[string]any) (string, map[string]any, []types.ToolCallContentItem) {
	var payload claudeagent.WebSearchInput
	if err := json.Unmarshal(input, &payload); err != nil {
		return "web search", fallbackMeta, nil
	}

	query := strings.TrimSpace(payload.Query)
	title := query
	if title == "" {
		title = "web search"
	}

	meta := cloneToolMeta(fallbackMeta)
	if query != "" {
		meta["query"] = query
	}
	if len(payload.AllowedDomains) > 0 {
		meta["allowedDomains"] = payload.AllowedDomains
	}
	if len(payload.BlockedDomains) > 0 {
		meta["blockedDomains"] = payload.BlockedDomains
	}

	lines := make([]string, 0, 3)
	if query != "" {
		lines = append(lines, "**Query:** "+query)
	}
	if len(payload.AllowedDomains) > 0 {
		lines = append(lines, "**Allowed domains:** "+strings.Join(payload.AllowedDomains, ", "))
	}
	if len(payload.BlockedDomains) > 0 {
		lines = append(lines, "**Blocked domains:** "+strings.Join(payload.BlockedDomains, ", "))
	}
	if len(lines) == 0 {
		return title, meta, nil
	}

	return title, meta, []types.ToolCallContentItem{{
		Type: "text",
		Text: strings.Join(lines, "\n\n"),
	}}
}

func cloneToolMeta(meta map[string]any) map[string]any {
	if len(meta) == 0 {
		return nil
	}
	out := make(map[string]any, len(meta))
	for k, v := range meta {
		out[k] = v
	}
	return out
}

func subagentMetaFromPartial(msg claudeagent.PartialAssistantMessage) subagentMeta {
	meta := subagentMeta{}
	if msg.ParentToolUseID != nil {
		meta.ParentToolUseID = strings.TrimSpace(*msg.ParentToolUseID)
	}
	return meta
}

func subagentMetaFromAssistant(msg claudeagent.AssistantMessage) subagentMeta {
	meta := subagentMeta{
		SubagentType:    strings.TrimSpace(msg.SubagentType),
		TaskDescription: strings.TrimSpace(msg.TaskDescription),
	}
	if msg.ParentToolUseID != nil {
		meta.ParentToolUseID = strings.TrimSpace(*msg.ParentToolUseID)
	}
	return meta
}

func subagentMetaFromToolProgress(msg claudeagent.ToolProgressMessage) subagentMeta {
	meta := subagentMeta{}
	if msg.ParentToolUseID != nil {
		meta.ParentToolUseID = strings.TrimSpace(*msg.ParentToolUseID)
	}
	if msg.TaskID != nil {
		meta.TaskID = strings.TrimSpace(*msg.TaskID)
	}
	return meta
}

// isClaudeToolProgressHeartbeat reports whether a tool progress event is one of
// the periodic liveness heartbeats emitted for a still-running tool call. The
// CLI derives their id from the original tool_use_id, so they must not be
// re-emitted as standalone tool updates.
func isClaudeToolProgressHeartbeat(msg claudeagent.ToolProgressMessage) bool {
	const marker = "-heartbeat-"
	id := strings.TrimSpace(msg.ToolUseID)
	index := strings.LastIndex(id, marker)
	if index <= 0 {
		return false
	}
	_, err := strconv.Atoi(strings.TrimSpace(id[index+len(marker):]))
	return err == nil
}

func (m subagentMeta) hasSubagentRef() bool {
	return strings.TrimSpace(m.ParentToolUseID) != "" || strings.TrimSpace(m.TaskID) != ""
}

func (m subagentMeta) refKey() string {
	return firstNonEmpty(m.ParentToolUseID, m.TaskID)
}

// markSubagentTextDelta records that this subagent already streamed visible
// text, so its finalized assistant text must not be emitted a second time.
func (s *session) markSubagentTextDelta(meta subagentMeta) {
	key := meta.refKey()
	if key == "" {
		return
	}
	if s.sawSubagentText == nil {
		s.sawSubagentText = make(map[string]bool)
	}
	s.sawSubagentText[key] = true
}

func (s *session) subagentTextStreamed(meta subagentMeta) bool {
	key := meta.refKey()
	return key != "" && s.sawSubagentText[key]
}

// clearSubagentTextDelta ends the current message's marker so a later finalized
// assistant message without streamed deltas is still emitted.
func (s *session) clearSubagentTextDelta(meta subagentMeta) {
	key := meta.refKey()
	if key != "" {
		delete(s.sawSubagentText, key)
	}
}

func (m subagentMeta) toMap() map[string]any {
	out := map[string]any{}
	if value := strings.TrimSpace(m.ParentToolUseID); value != "" {
		out["parentToolUseId"] = value
	}
	if value := strings.TrimSpace(m.TaskID); value != "" {
		out["taskId"] = value
	}
	if value := strings.TrimSpace(m.SubagentType); value != "" {
		out["subagentType"] = value
	}
	if value := strings.TrimSpace(m.TaskDescription); value != "" {
		out["taskDescription"] = value
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func claudeTaskToolCall(callID, status, description, text string, meta subagentMeta, extra map[string]any) types.ToolCall {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		callID = strings.TrimSpace(meta.TaskID)
	}
	if callID == "" {
		callID = "claude-task"
	}
	title := strings.TrimSpace(description)
	if title == "" {
		title = strings.TrimSpace(text)
	}
	if title == "" {
		title = firstNonEmpty(meta.SubagentType, meta.TaskID, callID, "task")
	}
	status = strings.TrimSpace(status)
	if status == "" {
		status = "running"
	}
	content := []types.ToolCallContentItem(nil)
	if body := strings.TrimSpace(text); body != "" && body != title {
		content = []types.ToolCallContentItem{{Type: "text", Text: body}}
	}
	merged := mergeToolCallMeta(meta.toMap(), map[string]any{
		"rawType": "claude_task",
	})
	merged = mergeToolCallMeta(merged, extra)
	return types.ToolCall{
		CallID:  callID,
		Title:   title,
		Status:  status,
		Kind:    types.ToolKindTask,
		RawType: "claude_task",
		Content: content,
		Meta:    merged,
	}
}

func claudeTaskRunStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "completed":
		return "complete"
	case "failed", "killed":
		return "failed"
	case "paused":
		return "running"
	case "pending", "running":
		return "running"
	default:
		return "running"
	}
}

func compactBoundarySummary(msg claudeagent.CompactBoundaryMessage) string {
	parts := make([]string, 0, 2)
	if trigger := strings.TrimSpace(msg.CompactMetadata.Trigger); trigger != "" {
		parts = append(parts, "trigger: "+trigger)
	}
	if msg.CompactMetadata.PreTokens > 0 {
		parts = append(parts, fmt.Sprintf("tokens before compact: %d", msg.CompactMetadata.PreTokens))
	}
	return strings.Join(parts, "\n")
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func boolPtrValue(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}

func isIgnoredClaudeTaskType(taskType string) bool {
	switch strings.ToLower(strings.TrimSpace(taskType)) {
	case "local_bash":
		return true
	default:
		return false
	}
}

func (s *session) trackTaskInfo(taskID string, update claudeTaskInfo) {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return
	}
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	if s.taskInfos == nil {
		s.taskInfos = make(map[string]claudeTaskInfo)
	}
	info := s.taskInfos[taskID]
	if value := strings.TrimSpace(update.ToolUseID); value != "" {
		info.ToolUseID = value
	}
	if value := strings.TrimSpace(update.TaskType); value != "" {
		info.TaskType = value
	}
	if value := strings.TrimSpace(update.Description); value != "" {
		info.Description = value
	}
	if value := strings.TrimSpace(update.SubagentType); value != "" {
		info.SubagentType = value
	}
	if value := strings.TrimSpace(update.TaskDescription); value != "" {
		info.TaskDescription = value
	}
	s.taskInfos[taskID] = info
}

func (s *session) taskInfo(taskID string) claudeTaskInfo {
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return claudeTaskInfo{}
	}
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	if s.taskInfos == nil {
		return claudeTaskInfo{}
	}
	return s.taskInfos[taskID]
}

func (s *session) taskType(taskID string) string {
	return s.taskInfo(taskID).TaskType
}

func (s *session) trackPendingToolCall(toolCall types.ToolCall) {
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	if strings.TrimSpace(toolCall.CallID) == "" {
		return
	}
	if s.pendingToolCalls == nil {
		s.pendingToolCalls = make(map[string]types.ToolCall)
	}
	key := stringMeta(toolCall.Meta, "toolUseId")
	if key == "" {
		key = toolCall.CallID
	}
	if _, exists := s.pendingToolCalls[key]; !exists {
		s.pendingToolOrder = append(s.pendingToolOrder, key)
	}
	s.pendingToolCalls[key] = toolCall
}

func (s *session) hasPendingToolCall(callID string) bool {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return false
	}
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	_, ok := s.pendingToolCalls[callID]
	return ok
}

func (s *session) cancelPendingToolCall(callID, reason string) (types.ToolCall, bool) {
	callID = strings.TrimSpace(callID)
	if callID == "" {
		return types.ToolCall{}, false
	}
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	if len(s.pendingToolCalls) == 0 {
		return types.ToolCall{}, false
	}
	toolCall, ok := s.pendingToolCalls[callID]
	if !ok {
		return types.ToolCall{}, false
	}
	s.deletePendingToolCallLocked(callID)
	toolCall.Status = "failed"
	toolCall.Meta = mergeToolCallMeta(toolCall.Meta, map[string]any{"error": reason, "canceled": true})
	if len(toolCall.Content) == 0 && strings.TrimSpace(reason) != "" {
		toolCall.Content = []types.ToolCallContentItem{{Type: "text", Text: reason}}
	}
	return toolCall, true
}

func (s *session) toolResultUpdate(msg claudeagent.UserMessage) (types.ToolCall, bool) {
	if msg.ToolUseResult == nil {
		// Subagent tool results arrive without tool_use_result. The SDK also
		// drops the tool_result block's tool_use_id, so the only stable link is
		// parent_tool_use_id: complete the oldest matching subagent call.
		return s.subagentToolResultUpdate(msg)
	}

	parentToolUseID := ""
	if msg.ParentToolUseID != nil {
		parentToolUseID = strings.TrimSpace(*msg.ParentToolUseID)
	}
	callID := parentToolUseID
	if callID == "" {
		callID = extractToolResultCallID(msg.ToolUseResult)
	}
	base, ok := s.popPendingToolCallForResult(callID, msg.ToolUseResult)
	if !ok {
		return types.ToolCall{}, false
	}
	if isTaskListToolCall(base) {
		return s.taskListToolResultUpdate(base, msg.ToolUseResult)
	}

	result := summarizeToolResult(base.Kind, msg.ToolUseResult)
	if result == "" {
		result = summarizeUserToolResultMessage(msg)
	}
	update := base
	update.Status = "complete"
	if result != "" {
		update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"output": result})
		if base.Kind != types.ToolKindEdit || len(base.Content) == 0 {
			update.Content = []types.ToolCallContentItem{{Type: "text", Text: result}}
		}
	}
	return update, true
}

// subagentToolResultUpdate completes a tool call that belongs to a subagent.
// Claude reports the parent Task id for those messages while the tool result
// itself carries no tool_use_result, so neither the call id nor the output is
// available. Completing the oldest pending call under the parent keeps later
// top-level results from being attributed to a stale subagent entry.
func (s *session) subagentToolResultUpdate(msg claudeagent.UserMessage) (types.ToolCall, bool) {
	if msg.ParentToolUseID == nil || !userMessageHasToolResultBlock(msg) {
		return types.ToolCall{}, false
	}
	parentToolUseID := strings.TrimSpace(*msg.ParentToolUseID)
	if parentToolUseID == "" {
		return types.ToolCall{}, false
	}

	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()
	for _, key := range s.pendingKeysInOrderLocked() {
		toolCall, ok := s.pendingToolCalls[key]
		if !ok || stringMeta(toolCall.Meta, "parentToolUseId") != parentToolUseID {
			continue
		}
		s.deletePendingToolCallLocked(key)
		toolCall.Status = "complete"
		return toolCall, true
	}
	return types.ToolCall{}, false
}

func userMessageHasToolResultBlock(msg claudeagent.UserMessage) bool {
	for _, block := range msg.Message.Content {
		if strings.EqualFold(strings.TrimSpace(block.Type), "tool_result") {
			return true
		}
	}
	return false
}

func isTaskListToolCall(toolCall types.ToolCall) bool {
	return toolCall.Kind == types.ToolKindTask && canonicalTaskListToolName(stringMeta(toolCall.Meta, "taskTool")) != ""
}

type taskListResultPayload struct {
	Items   []types.TaskItem
	Replace bool
}

func (s *session) taskListToolResultUpdate(base types.ToolCall, raw any) (types.ToolCall, bool) {
	update, payload, ok := computeTaskListToolResultUpdate(base, raw)
	if !ok {
		return types.ToolCall{}, false
	}
	s.syncTaskList(update, payload)
	return update, true
}

func computeTaskListToolResultUpdate(base types.ToolCall, raw any) (types.ToolCall, *taskListResultPayload, bool) {
	taskTool := canonicalTaskListToolName(stringMeta(base.Meta, "taskTool"))
	if taskTool == "" {
		return types.ToolCall{}, nil, false
	}

	result := summarizeToolResult(base.Kind, raw)
	if result == "" {
		result = summarizeGenericToolResult(raw)
	}
	if isEmptyJSONResult(result) {
		result = ""
	}

	switch taskTool {
	case "TaskCreate":
		taskID := firstNonEmpty(extractTaskListResultID(raw), stringMeta(base.Meta, "taskId"))
		update := base
		update.Status = "running"
		if taskID != "" {
			update.CallID = taskListCallID(taskID)
			update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"taskId": taskID})
		}
		item, parsed := parseTaskGetResult(raw)
		if parsed {
			if taskID == "" {
				taskID = item.ID
				update.CallID = taskListCallID(taskID)
				update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"taskId": taskID})
			}
			return update, &taskListResultPayload{Items: []types.TaskItem{item}}, true
		}
		return update, nil, true
	case "TaskUpdate":
		taskID := firstNonEmpty(extractTaskListResultID(raw), stringMeta(base.Meta, "taskId"))
		status := firstNonEmpty(extractTaskListResultStatus(raw), stringMeta(base.Meta, "taskStatus"), "complete")
		update := base
		update.Title = ""
		update.Content = nil
		update.Status = status
		meta := map[string]any{"taskStatus": status}
		if taskID != "" {
			update.CallID = taskListCallID(taskID)
			meta["taskId"] = taskID
		}
		update.Meta = mergeToolCallMeta(update.Meta, meta)
		return update, nil, true
	case "TaskList":
		items, parsed := parseTaskListResult(raw)
		if parsed {
			if text := formatTaskListText(items); text != "" {
				result = text
			}
		}
		update := base
		update.Status = "complete"
		if result != "" {
			update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"output": result})
			update.Content = []types.ToolCallContentItem{{Type: "text", Text: result}}
		}
		var payload *taskListResultPayload
		if parsed {
			payload = &taskListResultPayload{Items: items, Replace: true}
		}
		return update, payload, true
	case "TaskGet":
		item, parsed := parseTaskGetResult(raw)
		if parsed {
			if text := formatTaskItemText(item); text != "" {
				result = text
			}
		}
		taskID := firstNonEmpty(extractTaskListResultID(raw), stringMeta(base.Meta, "taskId"))
		update := base
		update.Status = "complete"
		if taskID != "" {
			update.CallID = taskListCallID(taskID)
			update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"taskId": taskID})
		}
		if result != "" {
			update.Meta = mergeToolCallMeta(update.Meta, map[string]any{"output": result})
			update.Content = []types.ToolCallContentItem{{Type: "text", Text: result}}
		}
		var payload *taskListResultPayload
		if parsed {
			payload = &taskListResultPayload{Items: []types.TaskItem{item}}
		}
		return update, payload, true
	default:
		return types.ToolCall{}, nil, false
	}
}

func isEmptyJSONResult(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return true
	}
	return trimmed == "{}" || trimmed == "[]"
}

func (s *session) seedTaskList(snapshot *types.TaskListUpdate) {
	if snapshot == nil {
		return
	}
	s.taskListMu.Lock()
	defer s.taskListMu.Unlock()
	s.taskItems = make(map[string]types.TaskItem, len(snapshot.Items))
	s.taskOrder = s.taskOrder[:0]
	for _, item := range snapshot.Items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := s.taskItems[id]; exists {
			continue
		}
		item.ID = id
		if status := normalizeTaskListStatus(item.Status); status != "" && status != "deleted" {
			item.Status = status
		} else {
			item.Status = "pending"
		}
		s.taskItems[id] = item
		s.taskOrder = append(s.taskOrder, id)
	}
}

// syncTaskList applies a task-list tool result to the session state and emits a
// full snapshot when anything changed. Snapshots replace previous ones, so a
// client can also recover after reconnecting or reopening the session.
func (s *session) syncTaskList(update types.ToolCall, payload *taskListResultPayload) {
	tool := canonicalTaskListToolName(stringMeta(update.Meta, "taskTool"))
	if tool == "" {
		return
	}
	taskID := stringMeta(update.Meta, "taskId")
	status := normalizeTaskListStatus(firstNonEmpty(stringMeta(update.Meta, "taskStatus"), update.Status))

	s.taskListMu.Lock()
	changed := false
	switch tool {
	case "TaskCreate":
		item := types.TaskItem{
			ID:          taskID,
			Subject:     firstNonEmpty(stringMeta(update.Meta, "subject"), update.Title),
			Description: stringMeta(update.Meta, "description"),
			ActiveForm:  stringMeta(update.Meta, "activeForm"),
			Status:      "pending",
		}
		if payload != nil && len(payload.Items) == 1 {
			created := payload.Items[0]
			item.ID = firstNonEmpty(item.ID, created.ID)
			item.Subject = firstNonEmpty(item.Subject, created.Subject)
			item.Description = firstNonEmpty(item.Description, created.Description)
			item.ActiveForm = firstNonEmpty(item.ActiveForm, created.ActiveForm)
			item.Status = firstNonEmpty(created.Status, item.Status)
		}
		changed = s.upsertTaskLocked(item)
	case "TaskUpdate":
		if taskID != "" {
			if status == "deleted" {
				changed = s.removeTaskLocked(taskID)
			} else {
				changed = s.upsertTaskLocked(types.TaskItem{ID: taskID, Status: status})
			}
		}
	case "TaskList":
		if payload != nil && payload.Replace {
			changed = s.replaceTasksLocked(payload.Items)
		}
	case "TaskGet":
		if payload != nil {
			for _, item := range payload.Items {
				if s.upsertTaskLocked(item) {
					changed = true
				}
			}
		}
	}
	snapshot := s.taskSnapshotLocked()
	s.taskListMu.Unlock()
	if !changed {
		return
	}
	s.emit(types.Event{
		Type:      types.EventTypeTaskUpdate,
		SessionID: s.SessionID(),
		Data:      types.TaskListUpdate{Items: snapshot},
	})
}

func (s *session) upsertTaskLocked(item types.TaskItem) bool {
	id := strings.TrimSpace(item.ID)
	if id == "" {
		return false
	}
	if s.taskItems == nil {
		s.taskItems = make(map[string]types.TaskItem)
	}
	existing, exists := s.taskItems[id]
	next := existing
	next.ID = id
	changed := !exists
	if !exists {
		s.taskOrder = append(s.taskOrder, id)
	}
	if value := strings.TrimSpace(item.Subject); value != "" && value != next.Subject {
		next.Subject = value
		changed = true
	}
	if value := strings.TrimSpace(item.Description); value != "" && value != next.Description {
		next.Description = value
		changed = true
	}
	if value := strings.TrimSpace(item.ActiveForm); value != "" && value != next.ActiveForm {
		next.ActiveForm = value
		changed = true
	}
	if value := normalizeTaskListStatus(item.Status); value != "" && value != "deleted" && value != next.Status {
		next.Status = value
		changed = true
	}
	if next.Status == "" {
		next.Status = "pending"
		changed = true
	}
	s.taskItems[id] = next
	return changed
}

func (s *session) removeTaskLocked(id string) bool {
	if _, ok := s.taskItems[id]; !ok {
		return false
	}
	delete(s.taskItems, id)
	nextOrder := s.taskOrder[:0]
	for _, key := range s.taskOrder {
		if key != id {
			nextOrder = append(nextOrder, key)
		}
	}
	s.taskOrder = nextOrder
	return true
}

func (s *session) replaceTasksLocked(items []types.TaskItem) bool {
	previous := s.taskSnapshotLocked()
	nextItems := make(map[string]types.TaskItem, len(items))
	nextOrder := make([]string, 0, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if _, exists := nextItems[id]; exists {
			continue
		}
		item.ID = id
		status := normalizeTaskListStatus(item.Status)
		if status == "" || status == "deleted" {
			status = "pending"
		}
		item.Status = status
		nextItems[id] = item
		nextOrder = append(nextOrder, id)
	}
	s.taskItems = nextItems
	s.taskOrder = nextOrder
	return !taskItemsEqual(previous, s.taskSnapshotLocked())
}

func (s *session) taskSnapshotLocked() []types.TaskItem {
	if len(s.taskOrder) == 0 {
		return nil
	}
	items := make([]types.TaskItem, 0, len(s.taskOrder))
	for _, id := range s.taskOrder {
		if item, ok := s.taskItems[id]; ok {
			items = append(items, item)
		}
	}
	return items
}

func taskItemsEqual(left, right []types.TaskItem) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func parseTaskListResult(raw any) ([]types.TaskItem, bool) {
	value := normalizeToolResultValue(raw)
	payload, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	rawTasks, ok := payload["tasks"]
	if !ok {
		return nil, false
	}
	list, ok := rawTasks.([]any)
	if !ok {
		if rawTasks == nil {
			return []types.TaskItem{}, true
		}
		return nil, false
	}
	items := make([]types.TaskItem, 0, len(list))
	seen := make(map[string]struct{}, len(list))
	for _, rawItem := range list {
		item, ok := taskItemFromValue(rawItem)
		if !ok {
			continue
		}
		if _, exists := seen[item.ID]; exists {
			continue
		}
		seen[item.ID] = struct{}{}
		items = append(items, item)
	}
	return items, true
}

func parseTaskGetResult(raw any) (types.TaskItem, bool) {
	value := normalizeToolResultValue(raw)
	payload, ok := value.(map[string]any)
	if !ok {
		return types.TaskItem{}, false
	}
	if task, ok := payload["task"]; ok {
		if item, ok := taskItemFromValue(task); ok {
			return item, true
		}
	}
	return taskItemFromValue(payload)
}

func taskItemFromValue(value any) (types.TaskItem, bool) {
	payload, ok := value.(map[string]any)
	if !ok {
		return types.TaskItem{}, false
	}
	id := firstNonEmpty(stringField(payload, "id"), stringField(payload, "taskId"))
	if id == "" {
		return types.TaskItem{}, false
	}
	status := normalizeTaskListStatus(stringField(payload, "status"))
	if status == "" || status == "deleted" {
		status = "pending"
	}
	return types.TaskItem{
		ID:          id,
		Subject:     stringField(payload, "subject"),
		Description: stringField(payload, "description"),
		ActiveForm:  firstNonEmpty(stringField(payload, "activeForm"), stringField(payload, "active_form")),
		Status:      status,
	}, true
}

func formatTaskListText(items []types.TaskItem) string {
	if len(items) == 0 {
		return ""
	}
	lines := make([]string, 0, len(items))
	for _, item := range items {
		lines = append(lines, taskStatusMarker(item.Status)+" "+taskItemLabel(item))
	}
	return strings.Join(lines, "\n")
}

func formatTaskItemText(item types.TaskItem) string {
	label := taskItemLabel(item)
	if label == "" {
		return ""
	}
	lines := []string{taskStatusMarker(item.Status) + " " + label}
	if description := strings.TrimSpace(item.Description); description != "" && description != label {
		lines = append(lines, "", description)
	}
	return strings.Join(lines, "\n")
}

func taskItemLabel(item types.TaskItem) string {
	if item.Status == "running" {
		if activeForm := strings.TrimSpace(item.ActiveForm); activeForm != "" {
			return activeForm
		}
	}
	if subject := strings.TrimSpace(item.Subject); subject != "" {
		return subject
	}
	if activeForm := strings.TrimSpace(item.ActiveForm); activeForm != "" {
		return activeForm
	}
	if id := strings.TrimSpace(item.ID); id != "" {
		return "Task " + id
	}
	return ""
}

func taskStatusMarker(status string) string {
	switch normalizeTaskListStatus(status) {
	case "complete":
		return "☑"
	case "running":
		return "◐"
	case "failed", "cancelled":
		return "✕"
	default:
		return "☐"
	}
}

func extractTaskListResultID(raw any) string {
	value := normalizeToolResultValue(raw)
	switch v := value.(type) {
	case map[string]any:
		if taskID := stringField(v, "taskId"); taskID != "" {
			return taskID
		}
		if id := stringField(v, "id"); id != "" {
			return id
		}
		if task, ok := v["task"].(map[string]any); ok {
			if taskID := stringField(task, "taskId"); taskID != "" {
				return taskID
			}
			if id := stringField(task, "id"); id != "" {
				return id
			}
		}
		if result, ok := v["result"].(map[string]any); ok {
			if taskID := stringField(result, "taskId"); taskID != "" {
				return taskID
			}
			if id := stringField(result, "id"); id != "" {
				return id
			}
			if task, ok := result["task"].(map[string]any); ok {
				if taskID := stringField(task, "taskId"); taskID != "" {
					return taskID
				}
				if id := stringField(task, "id"); id != "" {
					return id
				}
			}
		}
	}
	return ""
}

func extractTaskListResultStatus(raw any) string {
	value := normalizeToolResultValue(raw)
	switch v := value.(type) {
	case map[string]any:
		if status := normalizeTaskListStatus(stringField(v, "status")); status != "" {
			return status
		}
		if statusChange, ok := v["statusChange"].(map[string]any); ok {
			if status := normalizeTaskListStatus(stringField(statusChange, "to")); status != "" {
				return status
			}
		}
		if task, ok := v["task"].(map[string]any); ok {
			if status := normalizeTaskListStatus(stringField(task, "status")); status != "" {
				return status
			}
		}
		if result, ok := v["result"].(map[string]any); ok {
			if status := normalizeTaskListStatus(stringField(result, "status")); status != "" {
				return status
			}
			if statusChange, ok := result["statusChange"].(map[string]any); ok {
				if status := normalizeTaskListStatus(stringField(statusChange, "to")); status != "" {
					return status
				}
			}
			if task, ok := result["task"].(map[string]any); ok {
				if status := normalizeTaskListStatus(stringField(task, "status")); status != "" {
					return status
				}
			}
		}
	}
	return ""
}

func normalizeToolResultValue(raw any) any {
	switch v := raw.(type) {
	case string:
		var decoded any
		if err := json.Unmarshal([]byte(v), &decoded); err == nil {
			return decoded
		}
		return raw
	case []byte:
		var decoded any
		if err := json.Unmarshal(v, &decoded); err == nil {
			return decoded
		}
		return raw
	case json.RawMessage:
		var decoded any
		if err := json.Unmarshal(v, &decoded); err == nil {
			return decoded
		}
		return raw
	default:
		data, err := json.Marshal(raw)
		if err != nil {
			return raw
		}
		var decoded any
		if err := json.Unmarshal(data, &decoded); err == nil {
			return decoded
		}
		return raw
	}
}

func stringField(data map[string]any, key string) string {
	value, ok := data[key]
	if !ok {
		return ""
	}
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		if v == float64(int64(v)) {
			return strconv.FormatInt(int64(v), 10)
		}
		return strings.TrimSpace(fmt.Sprint(v))
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

func mergeToolCallMeta(base map[string]any, extra map[string]any) map[string]any {
	if len(base) == 0 && len(extra) == 0 {
		return nil
	}
	out := make(map[string]any, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func stringMeta(meta map[string]any, key string) string {
	if len(meta) == 0 {
		return ""
	}
	value, ok := meta[key]
	if !ok {
		return ""
	}
	switch v := value.(type) {
	case string:
		return strings.TrimSpace(v)
	default:
		return strings.TrimSpace(fmt.Sprint(v))
	}
}

// popPendingToolCallForResult removes the pending tool call that a top-level
// tool result belongs to. Claude Code streams each result as its own user
// message and, for parallel tool calls, does not expose the tool_use_id to the
// SDK: parent_tool_use_id is null and only parented messages identify a
// subagent's Task. Results for parallel calls therefore have to be matched by
// the shape of tool_use_result (and by file/query when available). Falling back
// to the oldest matching call keeps the pending set draining; dropping
// unmatched results would leave stale entries that poison every later result.
func (s *session) popPendingToolCallForResult(callID string, raw any) (types.ToolCall, bool) {
	s.pendingToolMu.Lock()
	defer s.pendingToolMu.Unlock()

	if len(s.pendingToolCalls) == 0 {
		return types.ToolCall{}, false
	}
	callID = strings.TrimSpace(callID)
	kind, hasKind := claudeToolResultKind(raw)
	if callID != "" {
		if toolCall, ok := s.pendingToolCalls[callID]; ok {
			// Parented results reference the parent Task, not the tool that
			// produced them. Never let a child's output complete the Task.
			if !(toolCall.Kind == types.ToolKindTask && hasKind && kind != types.ToolKindTask) {
				s.deletePendingToolCallLocked(callID)
				return toolCall, true
			}
		}
	}

	keys := s.pendingKeysInOrderLocked()
	if callID != "" {
		// parent_tool_use_id can point at the parent Task instead of the tool
		// that produced the result. Restrict matching to that Task's children.
		scoped := make([]string, 0, len(keys))
		for _, key := range keys {
			if stringMeta(s.pendingToolCalls[key].Meta, "parentToolUseId") == callID {
				scoped = append(scoped, key)
			}
		}
		if len(scoped) > 0 {
			keys = scoped
		}
	}

	if hasKind {
		candidates := make([]string, 0, len(keys))
		for _, key := range keys {
			if s.pendingToolCalls[key].Kind == kind {
				candidates = append(candidates, key)
			}
		}
		if kind == types.ToolKindTask {
			if payload, ok := toolResultPayload(raw); ok {
				candidates = filterPendingTaskCandidates(s.pendingToolCalls, candidates, payload)
			}
		}
		keys = candidates
	} else {
		// Plain-string results come from fetch/other tools such as WebFetch
		// and TaskStop; never let one pop a read, edit, or command call.
		plausible := make([]string, 0, len(keys))
		for _, key := range keys {
			switch s.pendingToolCalls[key].Kind {
			case types.ToolKindFetch, types.ToolKindOther:
				plausible = append(plausible, key)
			}
		}
		keys = plausible
	}
	if len(keys) == 0 {
		if len(s.pendingToolCalls) == 1 {
			for key, toolCall := range s.pendingToolCalls {
				s.deletePendingToolCallLocked(key)
				return toolCall, true
			}
		}
		return types.ToolCall{}, false
	}
	if len(keys) > 1 {
		if key, ok := matchPendingToolCallIdentity(s.pendingToolCalls, keys, raw); ok {
			toolCall := s.pendingToolCalls[key]
			s.deletePendingToolCallLocked(key)
			return toolCall, true
		}
	}
	key := keys[0]
	toolCall := s.pendingToolCalls[key]
	s.deletePendingToolCallLocked(key)
	return toolCall, true
}

func (s *session) deletePendingToolCallLocked(key string) {
	delete(s.pendingToolCalls, key)
	for index, existing := range s.pendingToolOrder {
		if existing == key {
			s.pendingToolOrder = append(s.pendingToolOrder[:index], s.pendingToolOrder[index+1:]...)
			return
		}
	}
}

// pendingKeysInOrderLocked returns pending calls in tool_use order. Sessions
// restored or built by tests may hold entries without an order; those are
// appended deterministically so matching stays stable.
func (s *session) pendingKeysInOrderLocked() []string {
	keys := make([]string, 0, len(s.pendingToolCalls))
	seen := make(map[string]struct{}, len(s.pendingToolOrder))
	for _, key := range s.pendingToolOrder {
		if _, ok := s.pendingToolCalls[key]; !ok {
			continue
		}
		keys = append(keys, key)
		seen[key] = struct{}{}
	}
	extra := make([]string, 0)
	for key := range s.pendingToolCalls {
		if _, ok := seen[key]; !ok {
			extra = append(extra, key)
		}
	}
	sort.Strings(extra)
	return append(keys, extra...)
}

// claudeToolResultKind infers the ToolKind from the per-tool tool_use_result
// shape Claude sends with each result.
func claudeToolResultKind(raw any) (types.ToolKind, bool) {
	payload, ok := toolResultPayload(raw)
	if !ok {
		return "", false
	}
	has := func(keys ...string) bool {
		for _, key := range keys {
			if _, ok := payload[key]; ok {
				return true
			}
		}
		return false
	}
	switch {
	case has("stdout", "stderr", "interrupted", "noOutputExpected"):
		return types.ToolKindExecute, true
	case has("file"):
		return types.ToolKindRead, true
	case has("oldString", "newString", "structuredPatch", "originalFile"):
		return types.ToolKindEdit, true
	case has("filePath") && has("content"):
		return types.ToolKindEdit, true
	case has("mode", "filenames", "totalMatches", "countIsComplete"):
		return types.ToolKindSearch, true
	case has("query") && has("results"):
		return types.ToolKindWebSearch, true
	case has("questions") && has("answers"):
		return types.ToolKindAskUser, true
	case has("agentId", "agentType", "totalToolUseCount", "task", "tasks", "statusChange", "taskId"):
		return types.ToolKindTask, true
	case has("commandName") && has("success"):
		return types.ToolKindOther, true
	case has("plan"), has("message"):
		return types.ToolKindThink, true
	}
	return "", false
}

func toolResultPayload(raw any) (map[string]any, bool) {
	var payload map[string]any
	if !decodeToolResult(raw, &payload) || len(payload) == 0 {
		return nil, false
	}
	return payload, true
}

// matchPendingToolCallIdentity narrows same-kind parallel calls using the
// identifiers Claude repeats in tool_use_result (file paths, search queries,
// task tool subtype).
func matchPendingToolCallIdentity(pending map[string]types.ToolCall, candidates []string, raw any) (string, bool) {
	payload, ok := toolResultPayload(raw)
	if !ok {
		return "", false
	}
	if path := toolResultFilePath(payload); path != "" {
		matches := make([]string, 0, 1)
		for _, key := range candidates {
			if sameToolResultPath(stringMeta(pending[key].Meta, "filePath"), path) {
				matches = append(matches, key)
			}
		}
		if len(matches) == 1 {
			return matches[0], true
		}
		if len(matches) > 1 {
			return "", false
		}
	}
	if query := strings.TrimSpace(stringField(payload, "query")); query != "" {
		matches := make([]string, 0, 1)
		for _, key := range candidates {
			meta := pending[key].Meta
			if strings.TrimSpace(stringMeta(meta, "query")) == query || strings.TrimSpace(stringMeta(meta, "pattern")) == query {
				matches = append(matches, key)
			}
		}
		if len(matches) == 1 {
			return matches[0], true
		}
	}
	if tool := taskToolForResult(payload); tool != "" {
		matches := make([]string, 0, 1)
		taskID := taskResultID(payload)
		for _, key := range candidates {
			meta := pending[key].Meta
			pendingTool := pendingTaskTool(stringMeta(meta, "taskTool"))
			// The Agent/Task tool has no taskTool marker.
			if tool == "Agent" {
				if pendingTool == "" {
					matches = append(matches, key)
				}
				continue
			}
			if tool == "TaskCreate" {
				// TaskCreate and TaskGet share the {task: ...} shape. A
				// pending TaskGet names its task in the tool input, so it can
				// only be the sender when the ids agree.
				if pendingTool != "TaskCreate" && pendingTool != "TaskGet" {
					continue
				}
				if taskID != "" && pendingTool == "TaskGet" && pendingTaskID(meta) != taskID {
					continue
				}
				matches = append(matches, key)
				continue
			}
			if pendingTool == tool {
				matches = append(matches, key)
			}
		}
		if len(matches) == 1 {
			return matches[0], true
		}
	}
	return "", false
}

func toolResultFilePath(payload map[string]any) string {
	if file, ok := payload["file"].(map[string]any); ok {
		if path := strings.TrimSpace(stringField(file, "filePath")); path != "" {
			return path
		}
	}
	return strings.TrimSpace(stringField(payload, "filePath"))
}

func sameToolResultPath(left, right string) bool {
	left = filepath.Clean(strings.TrimSpace(left))
	right = filepath.Clean(strings.TrimSpace(right))
	if left == "" || right == "" || left == "." || right == "." {
		return false
	}
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

// filterPendingTaskCandidates keeps the pending calls that can belong to the
// task tool subtype indicated by the result, so a TaskUpdate result never
// completes an Agent/Task call (or vice versa).
func filterPendingTaskCandidates(pending map[string]types.ToolCall, candidates []string, payload map[string]any) []string {
	tool := taskToolForResult(payload)
	if tool == "" {
		return candidates
	}
	out := make([]string, 0, len(candidates))
	for _, key := range candidates {
		pendingTool := pendingTaskTool(stringMeta(pending[key].Meta, "taskTool"))
		switch tool {
		case "Agent":
			if pendingTool == "" {
				out = append(out, key)
			}
		case "TaskCreate":
			// TaskCreate and TaskGet share the {task: ...} result shape.
			if pendingTool == "TaskCreate" || pendingTool == "TaskGet" {
				out = append(out, key)
			}
		default:
			if pendingTool == tool {
				out = append(out, key)
			}
		}
	}
	if len(out) == 0 {
		return candidates
	}
	return out
}

func taskToolForResult(payload map[string]any) string {
	has := func(key string) bool {
		_, ok := payload[key]
		return ok
	}
	switch {
	case has("agentId") || has("agentType") || has("totalToolUseCount"):
		return "Agent"
	case has("statusChange") || has("taskId"):
		return "TaskUpdate"
	case has("tasks"):
		return "TaskList"
	case has("task"):
		return "TaskCreate"
	}
	return ""
}

func pendingTaskTool(tool string) string {
	if strings.TrimSpace(tool) == "" {
		return ""
	}
	return canonicalTaskListToolName(tool)
}

func taskResultID(payload map[string]any) string {
	if task, ok := payload["task"].(map[string]any); ok {
		if id := strings.TrimSpace(stringField(task, "id")); id != "" {
			return id
		}
	}
	return strings.TrimSpace(stringField(payload, "taskId"))
}

func pendingTaskID(meta map[string]any) string {
	raw := stringMeta(meta, "input")
	if raw == "" {
		return ""
	}
	var input struct {
		TaskID string `json:"taskId"`
	}
	if json.Unmarshal([]byte(raw), &input) != nil {
		return ""
	}
	return strings.TrimSpace(input.TaskID)
}

func summarizeToolResult(kind types.ToolKind, raw any) string {
	switch kind {
	case types.ToolKindExecute:
		return summarizeExecuteToolResult(raw)
	case types.ToolKindEdit:
		return summarizeEditToolResult(raw)
	case types.ToolKindRead:
		if text := summarizeReadToolResult(raw); text != "" {
			return text
		}
		return summarizeGenericToolResult(raw)
	case types.ToolKindSearch:
		if text := summarizeSearchToolResult(raw); text != "" {
			return text
		}
		return summarizeGenericToolResult(raw)
	case types.ToolKindWebSearch:
		if text := summarizeWebSearchToolResult(raw); text != "" {
			return text
		}
		return summarizeGenericToolResult(raw)
	case types.ToolKindFetch, types.ToolKindOther:
		return summarizeGenericToolResult(raw)
	default:
		return ""
	}
}

// Claude surfaces tool output only through tool_use_result structures: the SDK
// drops the readable tool_result text block. Read/Glob/Grep/WebSearch results
// therefore need to be pulled out of their per-tool shapes explicitly.
func summarizeReadToolResult(raw any) string {
	var payload struct {
		File struct {
			Content string `json:"content"`
		} `json:"file"`
	}
	if !decodeToolResult(raw, &payload) {
		return ""
	}
	if strings.TrimSpace(payload.File.Content) == "" {
		return ""
	}
	return payload.File.Content
}

func summarizeSearchToolResult(raw any) string {
	var payload struct {
		Mode      string   `json:"mode"`
		Filenames []string `json:"filenames"`
		Content   string   `json:"content"`
	}
	if !decodeToolResult(raw, &payload) {
		return ""
	}
	if strings.TrimSpace(payload.Content) != "" {
		return payload.Content
	}
	filenames := make([]string, 0, len(payload.Filenames))
	for _, name := range payload.Filenames {
		if name = strings.TrimSpace(name); name != "" {
			filenames = append(filenames, name)
		}
	}
	if len(filenames) > 0 {
		return strings.Join(filenames, "\n")
	}
	if payload.Mode == "files_with_matches" {
		return "No matching files."
	}
	return ""
}

func summarizeWebSearchToolResult(raw any) string {
	var payload struct {
		Results []any `json:"results"`
	}
	if !decodeToolResult(raw, &payload) {
		return ""
	}
	// Claude mixes link objects and a trailing plain-text summary in the same
	// results array, so each entry has to be handled by its actual type.
	links := make([]string, 0, len(payload.Results))
	seen := make(map[string]struct{}, len(payload.Results))
	summary := ""
	for _, entry := range payload.Results {
		switch value := entry.(type) {
		case string:
			if summary == "" {
				summary = strings.TrimSpace(value)
			}
		case map[string]any:
			content, _ := value["content"].([]any)
			for _, rawLink := range content {
				link, _ := rawLink.(map[string]any)
				if link == nil {
					continue
				}
				url := strings.TrimSpace(stringField(link, "url"))
				if url == "" {
					continue
				}
				if _, ok := seen[url]; ok {
					continue
				}
				seen[url] = struct{}{}
				title := strings.TrimSpace(stringField(link, "title"))
				if title == "" {
					title = url
				}
				links = append(links, fmt.Sprintf("- [%s](%s)", title, url))
			}
		}
	}
	parts := make([]string, 0, 2)
	if summary != "" {
		parts = append(parts, summary)
	}
	if len(links) > 0 {
		parts = append(parts, strings.Join(links, "\n"))
	}
	return strings.Join(parts, "\n\n")
}

func summarizeExecuteToolResult(raw any) string {
	var payload struct {
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
	}
	if decodeToolResult(raw, &payload) {
		if strings.TrimSpace(payload.Stdout) != "" {
			return payload.Stdout
		}
		if strings.TrimSpace(payload.Stderr) != "" {
			return payload.Stderr
		}
	}
	return summarizeGenericToolResult(raw)
}

func summarizeEditToolResult(raw any) string {
	var payload struct {
		Content string `json:"content"`
	}
	if decodeToolResult(raw, &payload) && strings.TrimSpace(payload.Content) != "" {
		return payload.Content
	}
	return summarizeGenericToolResult(raw)
}

func decodeToolResult(raw any, out any) bool {
	data, err := json.Marshal(raw)
	if err != nil {
		return false
	}
	if err := json.Unmarshal(data, out); err != nil {
		return false
	}
	return true
}

func extractToolResultCallID(raw any) string {
	var payload map[string]any
	if !decodeToolResult(raw, &payload) {
		return ""
	}
	for _, key := range []string{"parent_tool_use_id", "tool_use_id", "toolUseId", "id"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func summarizeUserToolResultMessage(msg claudeagent.UserMessage) string {
	for _, block := range msg.Message.Content {
		if strings.TrimSpace(block.Text) == "" {
			continue
		}
		if block.Type == "tool_result" || len(msg.Message.Content) == 1 {
			if text := summarizeGenericToolResult(block.Text); strings.TrimSpace(text) != "" {
				return text
			}
			return block.Text
		}
	}
	return ""
}

func summarizeGenericToolResult(raw any) string {
	var payload any
	data, err := json.Marshal(raw)
	if err != nil {
		return ""
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		if text, ok := raw.(string); ok {
			return strings.TrimSpace(text)
		}
		return ""
	}
	return summarizeGenericToolResultValue(payload)
}

func summarizeGenericToolResultValue(value any) string {
	switch v := value.(type) {
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return ""
		}
		var nested any
		if err := json.Unmarshal([]byte(trimmed), &nested); err == nil {
			if text := summarizeGenericToolResultValue(nested); text != "" {
				return text
			}
		}
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			if text := summarizeGenericToolResultValue(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		for _, key := range []string{"stdout", "stderr", "output", "content", "text", "error"} {
			if text := summarizeGenericToolResultValue(v[key]); text != "" {
				return text
			}
		}
	}
	return ""
}

func (s *session) emitMessageChunk(content string) {
	s.emitMessageChunkWithMeta(content, subagentMeta{})
}

func (s *session) emitMessageChunkWithMeta(content string, meta subagentMeta) {
	if strings.TrimSpace(content) != "" && !meta.hasSubagentRef() {
		s.sawMessageText = true
	}
	s.emit(types.Event{
		Type:      types.EventTypeMessageChunk,
		SessionID: s.SessionID(),
		Data: types.MessageChunk{
			Content:         content,
			ParentToolUseID: meta.ParentToolUseID,
			TaskID:          meta.TaskID,
			SubagentType:    meta.SubagentType,
			TaskDescription: meta.TaskDescription,
		},
	})
}

func (s *session) emitToolUpdate(callID, name string, meta subagentMeta) {
	toolCall := types.ToolCall{
		CallID: callID,
		Title:  name,
		Status: "running",
		Kind:   mapToolKind(name),
		Meta:   meta.toMap(),
	}
	s.emit(types.Event{
		Type:      types.EventTypeToolUpdate,
		SessionID: s.SessionID(),
		Data:      toolCall,
	})
}

func (s *session) emit(event types.Event) {
	s.mu.RLock()
	handler := s.onUpdate
	s.mu.RUnlock()
	if handler == nil {
		return
	}
	// Events arrive from the SDK stream consumer and from control callbacks
	// (AskUserQuestion) on different goroutines. The update handler keeps
	// turn-scoped state, so callbacks must never overlap.
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	handler(event)
}

func (s *session) logRawMessage(raw []byte) {
	log.Printf("[agent/claude] output.raw session=%s msg=%s", s.sessionKey, truncateRaw(raw))
}

func (s *session) logRawToolCallBlock(block claudeagent.ContentBlock) {
	raw, err := json.Marshal(block)
	if err != nil {
		return
	}
	s.agentDebugLog.AppendRaw(raw)
}

func (s *session) logRawToolResult(msg claudeagent.UserMessage) {
	if msg.ToolUseResult == nil {
		return
	}
	raw, err := json.Marshal(msg.ToolUseResult)
	if err != nil {
		return
	}
	s.agentDebugLog.AppendRaw(raw)
}

func (s *session) updateSessionID(msg any) {
	switch m := msg.(type) {
	case claudeagent.SystemMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.AssistantMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.ResultMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.ToolProgressMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.PartialAssistantMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.CompactBoundaryMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.AuthStatusMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.TaskStartedMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.TaskProgressMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.TaskUpdatedMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.TaskNotificationMessage:
		s.setSessionID(m.SessionID)
	case claudeagent.ThinkingTokensMessage:
		s.setSessionID(m.SessionID)
	}
}

func (s *session) setSessionID(sessionID string) {
	if strings.TrimSpace(sessionID) == "" {
		return
	}
	s.mu.Lock()
	s.sessionID = sessionID
	s.mu.Unlock()
}

func (s *session) updateContextWindow(msg claudeagent.ResultMessage) {
	modelContextWindow := 0
	switch len(msg.ModelUsage) {
	case 0:
	case 1:
		for _, usage := range msg.ModelUsage {
			modelContextWindow = usage.ContextWindow
		}
	default:
		maxUsageTokens := -1
		for _, usage := range msg.ModelUsage {
			usageTokens := usage.InputTokens + usage.OutputTokens
			if usageTokens <= maxUsageTokens {
				continue
			}
			maxUsageTokens = usageTokens
			modelContextWindow = usage.ContextWindow
		}
	}
	if modelContextWindow == 0 {
		return
	}

	s.mu.Lock()
	s.context.ModelContextWindow = modelContextWindow
	s.mu.Unlock()
}

func claudeTokenUsage(msg claudeagent.ResultMessage) *types.TokenUsage {
	inputTokens := 0
	outputTokens := 0
	cacheReadTokens := 0
	cacheWriteTokens := 0
	if msg.Usage != nil {
		inputTokens = max(0, msg.Usage.InputTokens)
		outputTokens = max(0, msg.Usage.OutputTokens)
		cacheReadTokens = max(0, msg.Usage.CacheReadInputTokens)
		cacheWriteTokens = max(0, msg.Usage.CacheCreationInputTokens)
	} else {
		for _, usage := range msg.ModelUsage {
			inputTokens += max(0, usage.InputTokens)
			outputTokens += max(0, usage.OutputTokens)
			cacheReadTokens += max(0, usage.CacheReadInputTokens)
			cacheWriteTokens += max(0, usage.CacheCreationInputTokens)
		}
	}
	if inputTokens == 0 && outputTokens == 0 && cacheReadTokens == 0 && cacheWriteTokens == 0 {
		return nil
	}
	logicalInputTokens := inputTokens + cacheReadTokens + cacheWriteTokens
	return &types.TokenUsage{
		InputTokens:      logicalInputTokens,
		OutputTokens:     outputTokens,
		CacheReadTokens:  &cacheReadTokens,
		CacheWriteTokens: &cacheWriteTokens,
	}
}

func (s *session) enqueueTurn(waiter chan error) {
	s.turnMu.Lock()
	s.turns = append(s.turns, waiter)
	s.turnMu.Unlock()
}

func (s *session) markTurnInterrupted() {
	s.turnMu.Lock()
	s.turnInterrupted = true
	s.turnMu.Unlock()
}

func (s *session) consumeTurnInterruptedLocked() bool {
	interrupted := s.turnInterrupted
	s.turnInterrupted = false
	return interrupted
}

func (s *session) dequeueTurn(waiter chan error) {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	for i, ch := range s.turns {
		if ch != waiter {
			continue
		}
		s.turns = append(s.turns[:i], s.turns[i+1:]...)
		if len(s.turns) == 0 {
			s.turnInterrupted = false
		}
		return
	}
}

func (s *session) completeTurn(err error) {
	s.turnMu.Lock()
	interrupted := s.consumeTurnInterruptedLocked()
	if len(s.turns) == 0 {
		s.turnMu.Unlock()
		return
	}
	waiter := s.turns[0]
	s.turns = s.turns[1:]
	s.turnMu.Unlock()

	if interrupted && err != nil {
		err = errors.New("turn canceled")
	}
	waiter <- err
}

func (s *session) failPendingTurns(err error) {
	s.turnMu.Lock()
	pending := s.turns
	s.turns = nil
	s.turnInterrupted = false
	s.turnMu.Unlock()
	for _, ch := range pending {
		ch <- err
	}
}

func resultErr(msg claudeagent.ResultMessage) error {
	status := strings.ToLower(strings.TrimSpace(msg.Status))
	subtype := strings.ToLower(strings.TrimSpace(msg.Subtype))
	if !msg.IsError && (status == "success" || subtype == "success") && !strings.HasPrefix(subtype, "error") {
		return nil
	}
	if len(msg.Errors) > 0 {
		return errors.New(strings.Join(msg.Errors, "; "))
	}
	if strings.TrimSpace(msg.Result) != "" && (msg.IsError || strings.EqualFold(msg.Status, "error")) {
		return errors.New(msg.Result)
	}
	if strings.TrimSpace(msg.Subtype) != "" {
		return errors.New("claude result: " + msg.Subtype)
	}
	return errors.New("claude turn failed")
}

func isTurnCanceledError(err error) bool {
	if err == nil {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(err.Error()))
	return value == "turn canceled" || value == "turn cancelled" || strings.Contains(value, "context canceled")
}

// partialEventUsage is the normalized usage carried by a Claude streaming
// partial event. message_start reports the prompt size, message_delta reports
// the cumulative output for the current message.
type partialEventUsage struct {
	kind                     string
	InputTokens              int
	OutputTokens             int
	CacheReadInputTokens     int
	CacheCreationInputTokens int
}

func (u partialEventUsage) contextTokens() int {
	return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
}

func partialUsageFromEvent(raw json.RawMessage) partialEventUsage {
	if len(raw) == 0 {
		return partialEventUsage{}
	}
	type usage struct {
		InputTokens              int `json:"input_tokens"`
		OutputTokens             int `json:"output_tokens"`
		CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	}
	var event struct {
		Type    string `json:"type"`
		Usage   usage  `json:"usage"`
		Message struct {
			Usage usage `json:"usage"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return partialEventUsage{}
	}
	kind := strings.TrimSpace(event.Type)
	var current usage
	switch kind {
	case "message_start":
		current = event.Message.Usage
	case "message_delta":
		current = event.Usage
	default:
		return partialEventUsage{}
	}
	return partialEventUsage{
		kind:                     kind,
		InputTokens:              current.InputTokens,
		OutputTokens:             current.OutputTokens,
		CacheReadInputTokens:     current.CacheReadInputTokens,
		CacheCreationInputTokens: current.CacheCreationInputTokens,
	}
}

func contextTokensFromPartialEvent(raw json.RawMessage) int {
	return partialUsageFromEvent(raw).contextTokens()
}

func extractDeltas(raw json.RawMessage) (string, string) {
	if len(raw) == 0 {
		return "", ""
	}
	var event struct {
		Delta struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
		} `json:"delta"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return "", ""
	}
	switch strings.TrimSpace(event.Delta.Type) {
	case "text_delta":
		if event.Delta.Text != "" {
			return event.Delta.Text, ""
		}
	case "thinking_delta":
		if strings.TrimSpace(event.Delta.Thinking) != "" {
			return "", event.Delta.Thinking
		}
	}
	if event.Delta.Text != "" {
		return event.Delta.Text, ""
	}
	if strings.TrimSpace(event.Delta.Thinking) != "" {
		return "", event.Delta.Thinking
	}
	return event.Text, ""
}

func isKnownNonDisplayPartialEvent(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var event struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		return false
	}
	switch strings.TrimSpace(event.Delta.Type) {
	case "input_json_delta", "signature_delta":
		return true
	}
	switch strings.TrimSpace(event.Type) {
	case "content_block_start", "content_block_stop", "message_start", "message_stop":
		return true
	default:
		return false
	}
}

func mapToolKind(name string) types.ToolKind {
	switch normalizeToolName(name) {
	case "read":
		return types.ToolKindRead
	case "edit", "write", "multiedit":
		return types.ToolKindEdit
	case "delete":
		return types.ToolKindDelete
	case "move", "rename":
		return types.ToolKindMove
	case "glob", "grep", "search":
		return types.ToolKindSearch
	case "websearch":
		return types.ToolKindWebSearch
	case "bash", "execute":
		return types.ToolKindExecute
	case "webfetch", "fetch":
		return types.ToolKindFetch
	case "agent", "task", "taskcreate", "taskupdate", "tasklist", "taskget":
		return types.ToolKindTask
	case "askuserquestion":
		return types.ToolKindAskUser
	case "todowrite", "todos":
		return types.ToolKindTodo
	case "think", "updateplan", "enterplanmode", "exitplanmode":
		return types.ToolKindThink
	case "switchmode":
		return types.ToolKindSwitchMode
	default:
		return types.ToolKindOther
	}
}

func normalizeToolName(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.ReplaceAll(name, "_", "")
	name = strings.ReplaceAll(name, "-", "")
	return name
}

func preview(content string) string {
	trimmed := strings.TrimSpace(content)
	if len(trimmed) <= 300 {
		return trimmed
	}
	return trimmed[:300] + "...(truncated)"
}

func toolCallLogValue(toolCall types.ToolCall) string {
	raw, err := json.Marshal(toolCall)
	if err != nil {
		return `{"marshal_error":true}`
	}
	return string(raw)
}

func truncateRaw(raw []byte) string {
	const maxRawLogBytes = 1024
	if len(raw) > maxRawLogBytes {
		raw = append(raw[:maxRawLogBytes], []byte("...(truncated)")...)
	}
	return string(raw)
}
