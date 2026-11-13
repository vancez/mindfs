package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCORSAllowsE2EEHeaders(t *testing.T) {
	handler := CORSMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodOptions, "/api/upload", nil)
	req.Header.Set("Origin", "http://localhost")
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, req)

	allow := resp.Header().Get("Access-Control-Allow-Headers")
	for _, header := range []string{
		"X-MindFS-E2EE",
		"X-MindFS-Client-ID",
		"X-MindFS-Proof",
		"X-MindFS-TS",
		"X-MindFS-Nonce",
		"X-MindFS-E2EE-Stream",
	} {
		if !strings.Contains(allow, header) {
			t.Fatalf("Access-Control-Allow-Headers missing %s: %q", header, allow)
		}
	}
	expose := resp.Header().Get("Access-Control-Expose-Headers")
	for _, header := range []string{"X-MindFS-E2EE", "X-MindFS-E2EE-Stream", "X-MindFS-E2EE-Meta"} {
		if !strings.Contains(expose, header) {
			t.Fatalf("Access-Control-Expose-Headers missing %s: %q", header, expose)
		}
	}
}
