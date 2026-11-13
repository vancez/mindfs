import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const service = readFileSync(new URL("../src/services/session.ts", import.meta.url), "utf8");
const hook = readFileSync(new URL("../src/hooks/useSessionStream.ts", import.meta.url), "utf8");

assert.match(
  service,
  /type === "session\.done"[\s\S]*?this\.pendingStreams\.delete\(sessionKey\)/,
  "a completed session must drop queued stream events",
);
assert.match(
  hook,
  /sessionService\.subscribe\(sessionKey[\s\S]*?isSessionStreaming\(sessionKey\)[\s\S]*?setIsStreaming\(streaming\)/,
  "a remounted viewer must not replay a finished stream into the generating state",
);

console.log("session stream completion passed");
