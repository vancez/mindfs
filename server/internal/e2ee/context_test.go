package e2ee

import "testing"

func TestBuildStreamMetadataProofGoldenVector(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	got := BuildStreamMetadataProof(
		key,
		"GET",
		"/api/file?path=a.txt&raw=1&root=r",
		"MDEyMzQ1Njc4OWFiY2RlZg",
		"image/png",
		"1234",
		"",
		"download",
	)
	want := "yJZgeh+1F9rNRcaHqagoPaWjQsmLzjq8rVHTH8zBmFQ="
	if got != want {
		t.Fatalf("metadata proof = %q, want %q", got, want)
	}
}

func TestEnvelopeAndWSFrameAAD(t *testing.T) {
	if got, want := string(RequestEnvelopeAAD("POST", "/api/x", "nonce")), "mindfs-envelope-v1\x1frequest\x1fPOST\x1f/api/x\x1fnonce"; got != want {
		t.Fatalf("request AAD = %q, want %q", got, want)
	}
	if got, want := string(ResponseEnvelopeAAD("GET", "/api/x", "nonce")), "mindfs-envelope-v1\x1fresponse\x1fGET\x1f/api/x\x1fnonce"; got != want {
		t.Fatalf("response AAD = %q, want %q", got, want)
	}
	if got, want := string(WSAAD(WSFrameClientToServer, 0)), "mindfs-ws-frame-v1\x1fc2s\x1f0"; got != want {
		t.Fatalf("ws AAD = %q, want %q", got, want)
	}
	if string(WSAAD(WSFrameServerToClient, 1)) == string(WSAAD(WSFrameClientToServer, 1)) {
		t.Fatal("ws AAD must distinguish directions")
	}
}

func TestEnvelopeAADRejectsSwappedBodies(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	plaintext := []byte(`{"content":"secret"}`)
	envelope, err := EncryptBytesWithAAD(key, RequestEnvelopeAAD("POST", "/api/file", "nonce-a"), plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecryptBytesWithAAD(key, RequestEnvelopeAAD("POST", "/api/file", "nonce-b"), envelope); err == nil {
		t.Fatal("expected a different request context to reject the envelope")
	}
	got, err := DecryptBytesWithAAD(key, RequestEnvelopeAAD("POST", "/api/file", "nonce-a"), envelope)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(plaintext) {
		t.Fatalf("plaintext = %q", got)
	}
}
