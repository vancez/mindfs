package kanban

import (
	"context"
	"os"
	"testing"
)

func TestCloseRootReleasesTaskDatabase(t *testing.T) {
	s, store, _ := orchestrationFixture(t)
	rootID := store.root.ID

	s.CloseRoot(rootID)

	if err := store.db.Ping(); err == nil {
		t.Fatal("task store still open after CloseRoot")
	}
	s.mu.Lock()
	_, cached := s.stores[rootID]
	s.mu.Unlock()
	if cached {
		t.Fatal("task store still cached after CloseRoot")
	}
	// Removing the project directory fails on Windows while SQLite keeps the
	// database file open, so this asserts the handle was actually released.
	if err := os.RemoveAll(store.root.RootPath); err != nil {
		t.Fatalf("remove project directory after CloseRoot: %v", err)
	}
}

func TestCloseRootCancelsOnlyMatchingExecutions(t *testing.T) {
	s := NewService(nil, nil)
	rootCtx, cancelRoot := context.WithCancel(context.Background())
	groupCtx, cancelGroup := context.WithCancel(context.Background())
	otherCtx, cancelOther := context.WithCancel(context.Background())
	defer cancelOther()
	s.executionCancels = map[string]context.CancelFunc{
		"root/task-1":                  cancelRoot,
		"group-session/root/session-1": cancelGroup,
		"root-2/task-1":                cancelOther,
		"group-session/root-2/session": cancelOther,
	}
	s.running = map[string]bool{
		"root/task-1":                  true,
		"group-session/root/session-1": true,
		"root-2/task-1":                true,
	}

	s.CloseRoot("root")

	if rootCtx.Err() == nil {
		t.Fatal("task execution for removed root was not cancelled")
	}
	if groupCtx.Err() == nil {
		t.Fatal("group execution for removed root was not cancelled")
	}
	if otherCtx.Err() != nil {
		t.Fatal("execution for another root was cancelled")
	}
	if s.running["root/task-1"] || s.running["group-session/root/session-1"] {
		t.Fatal("running state for removed root was retained")
	}
	if !s.running["root-2/task-1"] {
		t.Fatal("running state for another root was dropped")
	}
}
