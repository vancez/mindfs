package acp

import (
	"context"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func availableCommands(names ...string) []acpsdk.AvailableCommand {
	commands := make([]acpsdk.AvailableCommand, 0, len(names))
	for _, name := range names {
		commands = append(commands, acpsdk.AvailableCommand{Name: name})
	}
	return commands
}

func commandNotification(sessionID string, commands []acpsdk.AvailableCommand) acpsdk.SessionNotification {
	return acpsdk.SessionNotification{
		SessionId: acpsdk.SessionId(sessionID),
		Update: acpsdk.SessionUpdate{
			AvailableCommandsUpdate: &acpsdk.SessionAvailableCommandsUpdate{
				AvailableCommands: commands,
			},
		},
	}
}

func TestSessionStateWaitCommandsWakesOnUpdate(t *testing.T) {
	state := &sessionState{}
	done := make(chan error, 1)
	go func() {
		done <- state.waitCommands(context.Background(), 2*time.Second)
	}()
	time.Sleep(20 * time.Millisecond)
	state.setCommands(availableCommands("goal", "compact"))

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("waitCommands returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("waitCommands did not wake after commands were published")
	}
	if got := state.getCommands(); len(got) != 2 || got[0].Name != "goal" || got[1].Name != "compact" {
		t.Fatalf("commands = %#v", got)
	}
}

func TestSessionStateWaitCommandsTimesOutWithoutCommands(t *testing.T) {
	state := &sessionState{}
	start := time.Now()
	if err := state.waitCommands(context.Background(), 30*time.Millisecond); err != nil {
		t.Fatalf("waitCommands returned error: %v", err)
	}
	if elapsed := time.Since(start); elapsed < 20*time.Millisecond {
		t.Fatalf("waitCommands returned too early: %v", elapsed)
	}
}

func TestSessionUpdateAppliesCommandsWithoutHandler(t *testing.T) {
	state := &sessionState{ID: acpsdk.SessionId("session-1")}
	proc := &Process{
		sessions:        map[string]*sessionState{"key": state},
		sessionsByID:    map[string]*sessionState{"session-1": state},
		pendingCommands: make(map[string][]acpsdk.AvailableCommand),
	}
	client := &mindfsClient{proc: proc}

	if err := client.SessionUpdate(context.Background(), commandNotification("session-1", availableCommands("goal"))); err != nil {
		t.Fatalf("SessionUpdate returned error: %v", err)
	}
	if got := state.getCommands(); len(got) != 1 || got[0].Name != "goal" {
		t.Fatalf("commands = %#v", got)
	}
}

func TestSessionUpdateBuffersCommandsBeforeSessionRegistration(t *testing.T) {
	proc := &Process{
		sessions:        make(map[string]*sessionState),
		sessionsByID:    make(map[string]*sessionState),
		pendingCommands: make(map[string][]acpsdk.AvailableCommand),
	}
	client := &mindfsClient{proc: proc}

	if err := client.SessionUpdate(context.Background(), commandNotification("session-1", availableCommands("goal"))); err != nil {
		t.Fatalf("SessionUpdate returned error: %v", err)
	}
	if got := proc.pendingCommands["session-1"]; len(got) != 1 || got[0].Name != "goal" {
		t.Fatalf("pending commands = %#v", got)
	}

	state := &sessionState{ID: acpsdk.SessionId("session-1")}
	proc.mu.Lock()
	proc.sessions["key"] = state
	proc.sessionsByID["session-1"] = state
	pending := proc.takePendingCommandsLocked("session-1")
	state.setCommands(pending)
	proc.mu.Unlock()

	if got := state.getCommands(); len(got) != 1 || got[0].Name != "goal" {
		t.Fatalf("commands after registration = %#v", got)
	}
	if len(proc.pendingCommands) != 0 {
		t.Fatalf("pending commands not cleared: %#v", proc.pendingCommands)
	}
}

func TestBufferPendingCommandsAppliesWhenSessionAlreadyRegistered(t *testing.T) {
	state := &sessionState{ID: acpsdk.SessionId("session-1")}
	proc := &Process{
		sessions:        map[string]*sessionState{"key": state},
		sessionsByID:    map[string]*sessionState{"session-1": state},
		pendingCommands: make(map[string][]acpsdk.AvailableCommand),
	}

	proc.bufferPendingCommands("session-1", availableCommands("goal"))
	if got := state.getCommands(); len(got) != 1 || got[0].Name != "goal" {
		t.Fatalf("commands = %#v", got)
	}
	if len(proc.pendingCommands) != 0 {
		t.Fatalf("commands were buffered for a registered session: %#v", proc.pendingCommands)
	}
}
