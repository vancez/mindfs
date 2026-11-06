package api

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mindfs/server/internal/e2ee"
	"mindfs/server/internal/fs"
)

func newE2EETestApp(t *testing.T) (*AppContext, string, string, []byte) {
	t.Helper()
	dir := t.TempDir()
	registry := fs.NewRegistry(filepath.Join(t.TempDir(), "registry.json"))
	root, err := registry.Upsert(dir)
	if err != nil {
		t.Fatal(err)
	}
	app := &AppContext{Dirs: registry}
	t.Cleanup(func() {
		for _, ctx := range app.roots {
			if ctx.Watcher != nil {
				ctx.Watcher.Close()
			}
		}
	})
	key := []byte("0123456789abcdef0123456789abcdef")
	app.E2EE = e2ee.NewManager(e2ee.Config{Enabled: true, NodeID: "node", PairingSecret: "test-secret"})
	if _, err := app.E2EE.OpenSessionForClient("test-client", e2ee.DerivedKey{Transport: key}); err != nil {
		t.Fatal(err)
	}
	return app, root.ID, dir, key
}

func testE2EENonce(seq int) string {
	return fmt.Sprintf("testnonce%012d", seq)
}

func newE2EEProofRequest(t *testing.T, method, target string, body io.Reader, key []byte, nonce string) *http.Request {
	t.Helper()
	ts := time.Now().UTC().Format(time.RFC3339)
	req := httptest.NewRequest(method, target, body)
	req.Header.Set(e2eeHeaderName, "1")
	req.Header.Set(clientIDHeaderName, "test-client")
	req.Header.Set(e2eeTSHeaderName, ts)
	req.Header.Set(e2eeNonceHeaderName, nonce)
	req.Header.Set(e2eeProofHeaderName, e2ee.BuildRequestProof(key, method, target, ts, nonce, "test-client"))
	return req
}

func TestRawDownloadEncryptedWithE2EE(t *testing.T) {
	app, rootID, dir, key := newE2EETestApp(t)
	payload := append([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}, bytes.Repeat([]byte("raw-secret-"), 120000)...)
	if err := os.WriteFile(filepath.Join(dir, "photo.png"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	target := "/api/file?" + url.Values{"root": {rootID}, "path": {"photo.png"}, "raw": {"1"}}.Encode()
	nonce := testE2EENonce(1)
	req := newE2EEProofRequest(t, http.MethodGet, target, nil, key, nonce)
	resp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(resp, req)

	if resp.Code != http.StatusOK {
		t.Fatalf("raw download status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if got := resp.Header().Get(e2eeStreamHeaderName); got != e2eeStreamDownload {
		t.Fatalf("stream marker = %q", got)
	}
	if got := resp.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("content type = %q", got)
	}
	if want := e2ee.EncryptedStreamLength(int64(len(payload))); resp.Header().Get("Content-Length") != fmt.Sprint(want) {
		t.Fatalf("content length = %q, want %d", resp.Header().Get("Content-Length"), want)
	}
	expectedMeta := e2ee.BuildStreamMetadataProof(
		key,
		http.MethodGet,
		target,
		nonce,
		resp.Header().Get("Content-Type"),
		resp.Header().Get("Content-Length"),
		resp.Header().Get("Content-Disposition"),
		e2eeStreamDownload,
	)
	if got := resp.Header().Get(e2eeMetaHeaderName); got == "" || got != expectedMeta {
		t.Fatalf("metadata proof = %q, want %q", got, expectedMeta)
	}
	if bytes.Contains(resp.Body.Bytes(), []byte("raw-secret-")) {
		t.Fatal("plaintext file bytes leaked in the encrypted response")
	}
	reader, err := e2ee.NewStreamReader(bytes.NewReader(resp.Body.Bytes()), key, e2ee.StreamPurposeDownload, nonce)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Finish(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("decrypted payload mismatch: got %d bytes, want %d", len(got), len(payload))
	}

	replay := newE2EEProofRequest(t, http.MethodGet, target, nil, key, nonce)
	replayResp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(replayResp, replay)
	if replayResp.Code != http.StatusUnauthorized || !strings.Contains(replayResp.Body.String(), "e2ee_proof_replayed") {
		t.Fatalf("replay response = %d %s", replayResp.Code, replayResp.Body.String())
	}

	missingNonce := newE2EEProofRequest(t, http.MethodGet, target, nil, key, testE2EENonce(2))
	missingNonce.Header.Del(e2eeNonceHeaderName)
	missingResp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(missingResp, missingNonce)
	if missingResp.Code != http.StatusUnauthorized || !strings.Contains(missingResp.Body.String(), "e2ee_nonce_required") {
		t.Fatalf("missing nonce response = %d %s", missingResp.Code, missingResp.Body.String())
	}
}

func TestRawDownloadEncryptsEmptyFile(t *testing.T) {
	app, rootID, dir, key := newE2EETestApp(t)
	if err := os.WriteFile(filepath.Join(dir, "empty.bin"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	target := "/api/file?" + url.Values{"root": {rootID}, "path": {"empty.bin"}, "raw": {"1"}}.Encode()
	nonce := testE2EENonce(1)
	req := newE2EEProofRequest(t, http.MethodGet, target, nil, key, nonce)
	resp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(resp, req)
	if resp.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.Code, resp.Body.String())
	}
	reader, err := e2ee.NewStreamReader(bytes.NewReader(resp.Body.Bytes()), key, e2ee.StreamPurposeDownload, nonce)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("decrypted empty file = %d bytes", len(got))
	}
}
