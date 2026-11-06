package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"mindfs/server/internal/fs"
	"mindfs/server/internal/kanban"
	"mindfs/server/internal/session"
)

func TestSessionPendingBroadcastReachesUnboundClients(t *testing.T) {
	hub := NewStreamHub(nil)
	registered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		id := r.URL.Query().Get("client")
		hub.RegisterClient(id, conn)
		defer hub.UnregisterClient(id, conn)
		registered <- struct{}{}
		<-release
	}))
	defer server.Close()
	defer close(release)

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?client=other-browser", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	<-registered

	hub.BroadcastSessionUserMessageAt("root", "chat", session.TypeChat, "Chat", "codex", "", "", "", "", false, "hello", time.Now().UTC(), "", false)
	hub.ClearSessionPending("chat")
	hub.BroadcastSessionPending("root", "chat", false)

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for _, want := range []bool{true, false} {
		for {
			var event struct {
				Type    string         `json:"type"`
				Payload map[string]any `json:"payload"`
			}
			if err := conn.ReadJSON(&event); err != nil {
				t.Fatalf("read pending event: %v", err)
			}
			if event.Type != "session.pending.updated" {
				continue
			}
			if event.Payload["root_id"] != "root" || event.Payload["session_key"] != "chat" || event.Payload["pending"] != want {
				t.Fatalf("pending event = %+v, want pending=%v", event.Payload, want)
			}
			break
		}
	}
}

func TestDeleteSessionBroadcastsDeletedKeys(t *testing.T) {
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := &AppContext{Dirs: registry}
	app.Kanban = kanban.NewService(nil, app)
	defer app.Kanban.Close()
	manager, err := app.GetSessionManager(root.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	parent, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, Name: "parent"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := manager.Create(ctx, session.CreateInput{Type: session.TypeChat, ParentSessionKey: parent.Key, Name: "child"})
	if err != nil {
		t.Fatal(err)
	}

	hub := app.GetSessionStreamHub()
	registered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		id := r.URL.Query().Get("client")
		hub.RegisterClient(id, conn)
		defer hub.UnregisterClient(id, conn)
		registered <- struct{}{}
		<-release
	}))
	defer server.Close()
	defer close(release)

	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?client=other-browser", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	<-registered

	req := httptest.NewRequest(http.MethodDelete, "/api/sessions/"+parent.Key+"?root="+root.ID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("key", parent.Key)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	w := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).handleSessionDelete(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d: %s", w.Code, w.Body.String())
	}

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var event struct {
			Type    string         `json:"type"`
			Payload map[string]any `json:"payload"`
		}
		if err := conn.ReadJSON(&event); err != nil {
			t.Fatalf("read delete event: %v", err)
		}
		if event.Type != "session.deleted" {
			continue
		}
		if event.Payload["root_id"] != root.ID || event.Payload["session_key"] != parent.Key || event.Payload["keep_children"] != false {
			t.Fatalf("unexpected delete payload: %+v", event.Payload)
		}
		rawKeys, _ := event.Payload["keys"].([]any)
		keys := make(map[string]bool, len(rawKeys))
		for _, key := range rawKeys {
			if text, ok := key.(string); ok {
				keys[text] = true
			}
		}
		if !keys[parent.Key] || !keys[child.Key] {
			t.Fatalf("deleted keys = %v, want parent and child", rawKeys)
		}
		return
	}
}
