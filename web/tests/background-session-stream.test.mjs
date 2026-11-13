import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// Regression for the background-session state machine in SessionService.
//
// A session that receives stream events while nobody is subscribed queues them
// in pendingStreams. If the turn then finishes, those queued events must be
// dropped so the first visit cannot replay them and render a stale "replying"
// state. The still-running case must keep replaying the queue.
//
// Loading the service through Vite exercises the real TypeScript module
// without a browser; DOM-bound listeners are skipped via the service's own
// `typeof window` guards.
let server;
let sessionService;
let keySeq = 0;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ sessionService } = await server.ssrLoadModule("/src/services/session.ts"));
});

after(async () => {
  await server?.close();
});

function nextKey(label) {
  keySeq += 1;
  return `background-${label}-${keySeq}`;
}

function emitStream(sessionKey, eventType = "message_chunk") {
  sessionService.dispatchDecrypted(
    "session.stream",
    sessionKey,
    {
      root_id: "test",
      session_key: sessionKey,
      event: { type: eventType, data: { content: "Background reply" } },
    },
    {},
  );
}

function emitTerminal(type, sessionKey) {
  sessionService.dispatchDecrypted(
    type,
    sessionKey,
    { root_id: "test", session_key: sessionKey },
    {},
  );
}

function recordSubscriber(sessionKey) {
  const calls = { streams: [], done: 0, errors: [] };
  const unsubscribe = sessionService.subscribe(sessionKey, {
    onStream: (event) => calls.streams.push(event),
    onDone: () => {
      calls.done += 1;
    },
    onError: (message) => calls.errors.push(message),
  });
  return { calls, unsubscribe };
}

for (const terminal of ["session.done", "session.error", "session.truncated"]) {
  test(`first visit to background session stays idle after ${terminal}`, () => {
    const sessionKey = nextKey(terminal);
    emitStream(sessionKey);
    emitStream(sessionKey, "thought_chunk");
    emitTerminal(terminal, sessionKey);

    const { calls, unsubscribe } = recordSubscriber(sessionKey);
    try {
      // The queue must be discarded, not replayed as a live turn.
      assert.deepEqual(calls.streams, []);
      assert.equal(calls.done, 0);
      assert.deepEqual(calls.errors, []);
      assert.equal(sessionService.isSessionStreaming(sessionKey), false);

      // A subsequent turn must still stream normally in this same session.
      emitStream(sessionKey);
      assert.equal(calls.streams.length, 1);
      assert.equal(sessionService.isSessionStreaming(sessionKey), true);

      emitTerminal("session.done", sessionKey);
      assert.equal(calls.done, 1);
      assert.equal(sessionService.isSessionStreaming(sessionKey), false);
    } finally {
      unsubscribe();
    }
  });
}

test("first visit to a still-running background session replays its stream", () => {
  const sessionKey = nextKey("running");
  emitStream(sessionKey);

  const { calls, unsubscribe } = recordSubscriber(sessionKey);
  try {
    assert.equal(calls.streams.length, 1);
    assert.equal(calls.streams[0].type, "message_chunk");
    assert.equal(sessionService.isSessionStreaming(sessionKey), true);
  } finally {
    unsubscribe();
  }
});

test("terminal event reaches a subscribed viewer", () => {
  const sessionKey = nextKey("subscribed-error");
  const { calls, unsubscribe } = recordSubscriber(sessionKey);
  try {
    emitTerminal("session.error", sessionKey);
    assert.deepEqual(calls.errors, ["Unknown error"]);
    assert.equal(sessionService.isSessionStreaming(sessionKey), false);
  } finally {
    unsubscribe();
  }
});
