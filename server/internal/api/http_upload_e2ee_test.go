package api

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mindfs/server/internal/api/usecase"
	"mindfs/server/internal/e2ee"
)

const emptyFinalFrameBytes = 4 + 1 + 12 + 16

func buildPlainUpload(t *testing.T, content []byte) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	if err := form.WriteField("dir", "docs"); err != nil {
		t.Fatal(err)
	}
	part, err := form.CreateFormFile("files", "note.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	boundary := form.Boundary()
	if err := form.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), boundary
}

func buildPaddedUpload(t *testing.T, size int) ([]byte, string) {
	t.Helper()
	build := func(padding int) ([]byte, string) {
		var buf bytes.Buffer
		form := multipart.NewWriter(&buf)
		if err := form.WriteField("dir", "docs"); err != nil {
			t.Fatal(err)
		}
		part, err := form.CreateFormFile("files", "note.txt")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte("padded upload")); err != nil {
			t.Fatal(err)
		}
		if err := form.WriteField("padding", strings.Repeat("A", padding)); err != nil {
			t.Fatal(err)
		}
		boundary := form.Boundary()
		if err := form.Close(); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes(), boundary
	}
	base, _ := build(0)
	if len(base) > size {
		t.Fatalf("multipart base size %d exceeds %d", len(base), size)
	}
	body, boundary := build(size - len(base))
	if len(body) != size {
		t.Fatalf("padded multipart size = %d, want %d", len(body), size)
	}
	return body, boundary
}

func encryptUploadBody(t *testing.T, plaintext, key []byte, nonce string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer, err := e2ee.NewStreamWriter(&buf, key, e2ee.StreamPurposeUpload, nonce)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(plaintext); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func performEncryptedUpload(t *testing.T, app *AppContext, rootID, contentType string, body []byte, key []byte, nonce string, stream bool) *httptest.ResponseRecorder {
	t.Helper()
	target := "/api/upload?" + url.Values{"root": {rootID}}.Encode()
	req := newE2EEProofRequest(t, http.MethodPost, target, bytes.NewReader(body), key, nonce)
	req.Header.Set("Content-Type", contentType)
	if stream {
		req.Header.Set(e2eeStreamHeaderName, e2eeStreamUpload)
	}
	resp := httptest.NewRecorder()
	(&HTTPHandler{AppContext: app}).Routes().ServeHTTP(resp, req)
	return resp
}

func TestUploadEncryptedWithE2EE(t *testing.T) {
	app, rootID, dir, key := newE2EETestApp(t)
	content := []byte("hello encrypted upload")
	plainBody, boundary := buildPlainUpload(t, content)
	nonce := testE2EENonce(1)
	ciphertext := encryptUploadBody(t, plainBody, key, nonce)
	target := "/api/upload?" + url.Values{"root": {rootID}}.Encode()
	resp := performEncryptedUpload(t, app, rootID, "multipart/form-data; boundary="+boundary, ciphertext, key, nonce, true)
	if resp.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body = %s", resp.Code, resp.Body.String())
	}
	if resp.Header().Get(e2eeHeaderName) != "1" {
		t.Fatalf("upload response is not E2EE protected")
	}
	var envelope e2ee.CipherEnvelope
	if err := json.Unmarshal(resp.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Files []usecase.UploadedFile `json:"files"`
	}
	if err := e2ee.DecryptJSONWithAAD(key, e2ee.ResponseEnvelopeAAD(http.MethodPost, target, nonce), &envelope, &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Files) != 1 || result.Files[0].Path != "docs/note.txt" {
		t.Fatalf("uploaded files = %+v", result.Files)
	}
	saved, err := os.ReadFile(filepath.Join(dir, "docs", "note.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(saved, content) {
		t.Fatalf("saved content = %q", saved)
	}
}

func TestUploadRejectsPlaintextWhenE2EEEnabled(t *testing.T) {
	app, rootID, _, key := newE2EETestApp(t)
	plainBody, boundary := buildPlainUpload(t, []byte("plaintext"))
	nonce := testE2EENonce(1)
	resp := performEncryptedUpload(t, app, rootID, "multipart/form-data; boundary="+boundary, plainBody, key, nonce, true)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "e2ee_stream_invalid") {
		t.Fatalf("plaintext upload response = %d %s", resp.Code, resp.Body.String())
	}
}

func TestUploadRejectsMissingStreamMarker(t *testing.T) {
	app, rootID, _, key := newE2EETestApp(t)
	plainBody, boundary := buildPlainUpload(t, []byte("body"))
	nonce := testE2EENonce(1)
	ciphertext := encryptUploadBody(t, plainBody, key, nonce)
	resp := performEncryptedUpload(t, app, rootID, "multipart/form-data; boundary="+boundary, ciphertext, key, nonce, false)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "e2ee_stream_required") {
		t.Fatalf("missing marker response = %d %s", resp.Code, resp.Body.String())
	}
}

func TestUploadRejectsTamperedCiphertext(t *testing.T) {
	app, rootID, dir, key := newE2EETestApp(t)
	plainBody, boundary := buildPlainUpload(t, []byte("tamper me"))
	nonce := testE2EENonce(1)
	ciphertext := encryptUploadBody(t, plainBody, key, nonce)
	ciphertext[len(e2ee.StreamMagic)+17+1] ^= 0xff
	resp := performEncryptedUpload(t, app, rootID, "multipart/form-data; boundary="+boundary, ciphertext, key, nonce, true)
	if resp.Code != http.StatusBadRequest || !strings.Contains(resp.Body.String(), "e2ee_stream_invalid") {
		t.Fatalf("tampered upload response = %d %s", resp.Code, resp.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", "note.txt")); !os.IsNotExist(err) {
		t.Fatalf("tampered upload created a destination file: %v", err)
	}
}

func TestUploadRejectsTruncatedFinalFrame(t *testing.T) {
	app, rootID, dir, key := newE2EETestApp(t)
	paddedBody, boundary := buildPaddedUpload(t, e2ee.StreamChunkSize)
	nonce := testE2EENonce(1)
	ciphertext := encryptUploadBody(t, paddedBody, key, nonce)
	if len(ciphertext) <= emptyFinalFrameBytes {
		t.Fatalf("ciphertext too short: %d", len(ciphertext))
	}
	truncated := ciphertext[:len(ciphertext)-emptyFinalFrameBytes]
	resp := performEncryptedUpload(t, app, rootID, "multipart/form-data; boundary="+boundary, truncated, key, nonce, true)
	if resp.Code != http.StatusBadRequest {
		t.Fatalf("truncated upload response = %d %s", resp.Code, resp.Body.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "docs", "note.txt")); !os.IsNotExist(err) {
		t.Fatalf("truncated upload created a destination file: %v", err)
	}
}
