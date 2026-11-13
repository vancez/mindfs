package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mindfs/server/internal/agent"
	agenttypes "mindfs/server/internal/agent/types"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/session"
)

// Runs as an isolated ACP subprocess. No model requests or real files are used.
func TestForkACPProcess(t *testing.T) {
	if os.Getenv("MINDFS_FORK_ACP_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	nextID := 0
	for scanner.Scan() {
		var req struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		switch req.Method {
		case "initialize":
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"protocolVersion": 1, "agentCapabilities": map[string]any{"loadSession": true}}})
		case "session/new":
			nextID++
			_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"sessionId": fmt.Sprintf("fork-fake-%d", nextID)}})
		default:
			if req.ID != nil {
				_ = encoder.Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}})
			}
		}
	}
	os.Exit(0)
}

func TestSessionForkResponseIncludesCopiedExchangeAux(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	pool := agent.NewPool(agent.Config{Agents: []agent.Definition{{
		Name:     "fork-test",
		Protocol: agent.ProtocolACP,
		Command:  executable,
		Args:     []string{"-test.run=^TestForkACPProcess$"},
		Env:      map[string]string{"MINDFS_FORK_ACP_HELPER": "1"},
	}}})
	defer pool.CloseAll()
	app := &AppContext{Dirs: registry, Agents: pool}
	manager, err := app.GetSessionManager(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Agent: "fork-test", Name: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.AddExchangeForAgent(ctx, parent, "user", "question", "fork-test", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := manager.AddExchangeForAgent(ctx, parent, "agent", "answer", "fork-test", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if err := manager.AddExchangeAux(ctx, parent.Key, session.ExchangeAux{Seq: 2, Line: 1, Thought: "weigh the options", ThoughtID: "thought-1"}); err != nil {
		t.Fatal(err)
	}
	if err := manager.AddExchangeAux(ctx, parent.Key, session.ExchangeAux{Seq: 2, Line: 2, ToolCall: &agenttypes.ToolCall{
		CallID:  "call-1",
		Title:   "Read config",
		Status:  "completed",
		Kind:    agenttypes.ToolKindRead,
		RawType: "tool_use",
	}}); err != nil {
		t.Fatal(err)
	}
	if err := manager.UpdateAgentState(ctx, parent, "fork-test", 0, "parent-agent-session"); err != nil {
		t.Fatal(err)
	}

	body, err := json.Marshal(map[string]any{"root_id": root.ID, "session_key": parent.Key, "seq": 2})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).handleSessionFork(rec, httptest.NewRequest(http.MethodPost, "/api/sessions/fork", strings.NewReader(string(body))))
	if rec.Code != http.StatusOK {
		t.Fatalf("fork status=%d: %s", rec.Code, rec.Body.String())
	}
	var payload struct {
		SessionKey string `json:"session_key"`
		Session    struct {
			ExchangeAux map[string][]session.ExchangeAux `json:"exchange_aux"`
		} `json:"session"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.SessionKey == "" {
		t.Fatalf("missing forked session key: %s", rec.Body.String())
	}
	aux := payload.Session.ExchangeAux["2"]
	thought, toolCall := false, false
	for _, item := range aux {
		if strings.TrimSpace(item.Thought) == "weigh the options" {
			thought = true
		}
		if item.ToolCall != nil && item.ToolCall.CallID == "call-1" {
			toolCall = true
		}
	}
	if !thought || !toolCall {
		t.Fatalf("fork response dropped copied exchange aux: %s", rec.Body.String())
	}
}
