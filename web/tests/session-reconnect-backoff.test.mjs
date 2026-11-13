import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression guard: a socket that opens and closes repeatedly (proxy flap,
// server restart, relay hiccup) must back off instead of reconnecting at 1s
// forever. The reconnect watchdog must also respect the scheduled delay.
const service = readFileSync(
  new URL("../src/services/session.ts", import.meta.url),
  "utf8",
);

assert.match(
  service,
  /private reconnectFailures = 0;/,
  "reconnect attempts should track consecutive failures",
);
assert.match(
  service,
  /private readonly stableConnectionMs = 10000;/,
  "a connection must stay up before its failure count is reset",
);
assert.match(
  service,
  /Date\.now\(\) - openedAt >= this\.stableConnectionMs[\s\S]*?this\.reconnectFailures = 0;/,
  "only stable connections reset the reconnect backoff",
);
assert.match(
  service,
  /const exponent = Math\.min\(this\.reconnectFailures, this\.maxReconnectFailures\);[\s\S]*?this\.fastReconnectDelayMs \* 2 \*\* exponent/,
  "reconnect delay should grow exponentially",
);
assert.doesNotMatch(
  service,
  /fastReconnectUntil/,
  "the old always-fast reconnect window should be removed",
);
assert.match(
  service,
  /private ensureReconnectLoop\(\) \{[\s\S]*?!this\.ws \|\| this\.ws\.readyState >= WebSocket\.CLOSING[\s\S]*?if \(!this\.reconnectTimer\) \{\s*this\.scheduleReconnect\(\);/,
  "the watchdog should schedule a backoff retry instead of reconnecting immediately",
);

console.log("session reconnect backoff guard passed");
assert.match(service, /private nextReconnectAt = 0;/, "reconnects should keep a monotonic next-attempt deadline");
assert.match(service, /private failConnectingAttempt\(reason: string\)[\s\S]*?this\.reconnectFailures = Math\.min/, "handshake timeouts should count as failures");
assert.match(service, /nextReconnectAt > Date\.now\(\)[\s\S]*?this\.scheduleReconnect\(\)/, "lifecycle events must respect the pending backoff");

// E2EE WebSocket frames are bound to a per-connection, per-direction sequence.
assert.match(service, /private wsInboundSeq = 0;/, "inbound frame sequence must reset per socket");
assert.match(service, /private wsOutboundSeq = 0;/, "outbound frame sequence must reset per socket");
assert.match(service, /decodeWSMessage<any>\(raw, sequence\)/, "inbound frames must use the expected sequence");
assert.match(service, /encodeWSMessage\(message, sequence\)/, "outbound frames must use the next sequence");
assert.match(service, /const next = this\.wsSendChain\.then\(send, send\);/, "outbound sends must stay ordered");
assert.match(service, /this\.wsReceiveChain = this\.wsReceiveChain/, "inbound frames must be processed in order");
