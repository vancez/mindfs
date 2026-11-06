package session

import (
	"context"
	"testing"

	agenttypes "mindfs/server/internal/agent/types"
	rootfs "mindfs/server/internal/fs"
)

func TestCompactExchangeAuxKeepsThoughts(t *testing.T) {
	thought := ExchangeAux{Seq: 2, Line: 4, Thought: "weigh the options", ThoughtID: "thought-1"}
	got, ok := CompactExchangeAux(thought)
	if !ok {
		t.Fatal("thought-only aux was dropped")
	}
	if got.Thought != thought.Thought || got.ThoughtID != thought.ThoughtID || got.Line != thought.Line {
		t.Fatalf("thought aux changed: %+v", got)
	}

	if _, ok := CompactExchangeAux(ExchangeAux{Seq: 2}); ok {
		t.Fatal("empty aux should still be dropped")
	}

	toolCall := agenttypes.ToolCall{CallID: "call-1", Kind: agenttypes.ToolKindRead, Status: "complete"}
	got, ok = CompactExchangeAux(ExchangeAux{
		Seq:      2,
		Thought:  "thinking attached to a tool call",
		ToolCall: &toolCall,
	})
	if !ok || got.ToolCall == nil || got.ToolCall.CallID != "call-1" {
		t.Fatalf("tool call aux dropped: %+v", got)
	}
	if got.Thought != "" {
		t.Fatalf("tool call aux should not duplicate thinking: %+v", got)
	}
}

func TestLoadExchangeAuxReturnsPersistedThoughts(t *testing.T) {
	ctx := context.Background()
	manager := NewManager(rootfs.NewRootInfo("thoughts", "thoughts", t.TempDir()))
	key := "thought-session"
	thought := ExchangeAux{Seq: 2, Line: 3, Thought: "considering options", ThoughtID: "thought-1"}
	if err := manager.AddExchangeAux(ctx, key, thought); err != nil {
		t.Fatal(err)
	}

	aux, err := manager.GetExchangeAux(ctx, key, 0)
	if err != nil {
		t.Fatal(err)
	}
	items := aux[thought.Seq]
	if len(items) != 1 {
		t.Fatalf("expected one thought aux for seq %d, got %+v", thought.Seq, aux)
	}
	if items[0].Thought != thought.Thought || items[0].ThoughtID != thought.ThoughtID || items[0].Line != thought.Line {
		t.Fatalf("thought aux did not round-trip: %+v", items[0])
	}
}
