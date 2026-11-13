import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const stream = readFileSync(new URL("../src/hooks/useSessionStream.ts", import.meta.url), "utf8");
const viewer = readFileSync(new URL("../src/components/SessionViewer.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  stream,
  /const persisted = Number\(ex\.seq \|\| 0\) > 0;/,
  "timeline items should track whether the exchange has a server seq",
);
assert.match(
  stream,
  /id: stableTimelineID\("user"[\s\S]*?seq,\s*persisted,/,
  "user timeline items should expose the persisted flag",
);
assert.match(
  stream,
  /buildAssistantTimeline\(\{ \.\.\.ex, seq, persisted \}/,
  "assistant timeline items should expose the persisted flag",
);
assert.match(
  viewer,
  /const canForkAgentMessage =[\s\S]*?item\.persisted === true[\s\S]*?onForkAgentMessage/,
  "fork should only be offered for persisted messages",
);
assert.doesNotMatch(
  viewer,
  /const canForkAgentMessage = !isUser && Number\(item\.seq \|\| 0\) > 0/,
  "fork must not use the inferred seq of a streamed message",
);
assert.match(
  app,
  /case "session\.done"[\s\S]*?restoreActiveSession\(rootID, sessionKey\)/,
  "a finished turn should re-sync the visible session to get real seqs",
);
assert.match(
  app,
  /hasQueuedContinuation[\s\S]*?restoreActiveSession\(rootID, sessionKey\)/,
  "the re-sync should be skipped when a queued turn starts immediately",
);
console.log("session fork persistence passed");
