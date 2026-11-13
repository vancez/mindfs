package e2ee

import "testing"

func TestBuildRequestProofGoldenVector(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	got := BuildRequestProof(
		key,
		"GET",
		"/api/file?path=a.txt&raw=1&root=r",
		"2026-01-01T00:00:00Z",
		"MDEyMzQ1Njc4OWFiY2RlZg",
		"test-client",
	)
	want := "l3lM8gycLcCFW1t3jusJVhq26goHGVmXOS4uahoAcGg="
	if got != want {
		t.Fatalf("proof = %q, want %q", got, want)
	}
	if other := BuildRequestProof(
		key,
		"GET",
		"/api/file?path=a.txt&raw=1&root=r",
		"2026-01-01T00:00:00Z",
		"AAAAAAAAAAAAAAAAAAAAAA",
		"test-client",
	); other == got {
		t.Fatal("changing the nonce must change the proof")
	}
}
