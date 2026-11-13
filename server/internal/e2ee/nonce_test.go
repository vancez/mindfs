package e2ee

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestValidRequestNonce(t *testing.T) {
	valid := []string{
		"MDEyMzQ1Njc4OWFiY2RlZg",
		"abcdefghijklmnop",
		"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz01234567",
	}
	for _, nonce := range valid {
		if !ValidRequestNonce(nonce) {
			t.Fatalf("expected %q to be valid", nonce)
		}
	}
	invalid := []string{
		"",
		"short",
		"has spaces here",
		"abcdefghijklmno+",
		"abcdefghijklmno=",
		"abcdefghijklmno/",
	}
	for _, nonce := range invalid {
		if ValidRequestNonce(nonce) {
			t.Fatalf("expected %q to be invalid", nonce)
		}
	}
	if ValidRequestNonce(string(make([]byte, 129))) {
		t.Fatal("expected overlong nonce to be invalid")
	}
}

func TestNonceCacheRejectsReplayAndIsolatesSessions(t *testing.T) {
	cache := newNonceCache(16)
	now := time.Unix(1700000000, 0)
	nonce := "MDEyMzQ1Njc4OWFiY2RlZg"
	if !cache.consumeAt("session-a", nonce, now) {
		t.Fatal("first use should be accepted")
	}
	if cache.consumeAt("session-a", nonce, now.Add(time.Second)) {
		t.Fatal("replay should be rejected")
	}
	if !cache.consumeAt("session-b", nonce, now.Add(time.Second)) {
		t.Fatal("the same nonce in another session should be accepted")
	}
}

func TestNonceCacheExpiresEntries(t *testing.T) {
	cache := newNonceCache(16)
	now := time.Unix(1700000000, 0)
	nonce := "MDEyMzQ1Njc4OWFiY2RlZg"
	if !cache.consumeAt("session-a", nonce, now) {
		t.Fatal("first use should be accepted")
	}
	if cache.consumeAt("session-a", nonce, now.Add(requestNonceTTL-time.Second)) {
		t.Fatal("replay inside the TTL should be rejected")
	}
	if !cache.consumeAt("session-a", nonce, now.Add(requestNonceTTL+time.Second)) {
		t.Fatal("reuse after TTL should be accepted")
	}
}

func TestNonceCacheConcurrentSingleWinner(t *testing.T) {
	cache := newNonceCache(16)
	now := time.Unix(1700000000, 0)
	nonce := "MDEyMzQ1Njc4OWFiY2RlZg"
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if cache.consumeAt("session-a", nonce, now) {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := accepted.Load(); got != 1 {
		t.Fatalf("accepted = %d, want exactly 1", got)
	}
}

func TestNonceCacheEvictsOldestAtLimit(t *testing.T) {
	cache := newNonceCache(2)
	now := time.Unix(1700000000, 0)
	first := "abcdefghijklmnop"
	second := "bcdefghijklmnopq"
	third := "cdefghijklmnopqr"
	for i, nonce := range []string{first, second} {
		if !cache.consumeAt("session-a", nonce, now.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("insert %q failed", nonce)
		}
	}
	if !cache.consumeAt("session-a", third, now.Add(2*time.Second)) {
		t.Fatal("third insert failed")
	}
	if !cache.consumeAt("session-a", first, now.Add(3*time.Second)) {
		t.Fatal("oldest entry should have been evicted")
	}
	if cache.consumeAt("session-a", third, now.Add(3*time.Second)) {
		t.Fatal("newest entry should still be present")
	}
}

func TestManagerConsumeRequestNonce(t *testing.T) {
	manager := NewManager(Config{Enabled: true, NodeID: "node", PairingSecret: "secret"})
	nonce := "MDEyMzQ1Njc4OWFiY2RlZg"
	if !manager.ConsumeRequestNonce("session-a", nonce) {
		t.Fatal("first use should be accepted")
	}
	if manager.ConsumeRequestNonce("session-a", nonce) {
		t.Fatal("replay should be rejected")
	}
}

func TestNonceKeyFormat(t *testing.T) {
	cache := newNonceCache(4)
	now := time.Unix(1700000000, 0)
	// Keys are scoped by session id and nonce, so identical nonces with
	// different session ids must not collide.
	for i := 0; i < 4; i++ {
		if !cache.consumeAt(fmt.Sprintf("session-%d", i), "abcdefghijklmnop", now) {
			t.Fatalf("session %d rejected", i)
		}
	}
}
