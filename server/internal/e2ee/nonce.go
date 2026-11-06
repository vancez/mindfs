package e2ee

import (
	"container/list"
	"sync"
	"time"
)

const (
	requestNonceTTL   = 15 * time.Minute
	defaultNonceLimit = 65536
)

type nonceEntry struct {
	key string
	at  time.Time
}

// nonceCache rejects replayed request proofs. Entries are kept slightly longer
// than the maximum proof lifetime (timestamp skew is ±5 minutes, so a proof first
// seen at now can remain valid for up to 10 minutes).
type nonceCache struct {
	mu      sync.Mutex
	entries map[string]*list.Element
	order   *list.List
	limit   int
}

func newNonceCache(limit int) *nonceCache {
	return &nonceCache{
		entries: make(map[string]*list.Element),
		order:   list.New(),
		limit:   limit,
	}
}

func (c *nonceCache) pruneLocked(now time.Time) {
	if c.order == nil {
		c.order = list.New()
	}
	for {
		front := c.order.Front()
		if front == nil {
			return
		}
		entry := front.Value.(nonceEntry)
		if now.Sub(entry.at) < requestNonceTTL {
			return
		}
		c.order.Remove(front)
		delete(c.entries, entry.key)
	}
}

// consumeAt records the nonce and reports whether it was unused. Lookup and
// insertion happen under one lock so concurrent identical requests have exactly
// one winner.
func (c *nonceCache) consumeAt(sessionID, nonce string, now time.Time) bool {
	if c == nil || sessionID == "" || nonce == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]*list.Element)
	}
	if c.order == nil {
		c.order = list.New()
	}
	if c.limit <= 0 {
		c.limit = defaultNonceLimit
	}
	c.pruneLocked(now)
	key := sessionID + "\x1f" + nonce
	if _, exists := c.entries[key]; exists {
		return false
	}
	if c.order.Len() >= c.limit {
		if front := c.order.Front(); front != nil {
			c.order.Remove(front)
			delete(c.entries, front.Value.(nonceEntry).key)
		}
	}
	element := c.order.PushBack(nonceEntry{key: key, at: now})
	c.entries[key] = element
	return true
}

func (c *nonceCache) prune(now time.Time) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked(now)
}

// ValidRequestNonce reports whether nonce has the expected base64url shape.
func ValidRequestNonce(nonce string) bool {
	if len(nonce) < 16 || len(nonce) > 128 {
		return false
	}
	for i := 0; i < len(nonce); i++ {
		c := nonce[i]
		switch {
		case c >= 'a' && c <= 'z':
		case c >= 'A' && c <= 'Z':
		case c >= '0' && c <= '9':
		case c == '-' || c == '_':
		default:
			return false
		}
	}
	return true
}
