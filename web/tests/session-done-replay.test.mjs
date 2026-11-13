import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression guard: a replayed session.done is the server's response to
// session.ready. Restoring/syncing again in that handler sends another
// session.ready, which makes the server replay done again and keeps the page
// in an endless getSession + session-list request loop.
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  app,
  /const replayedDone = payload\?\.replay === true;/,
  "session.done should distinguish replayed completions",
);

assert.match(
  app,
  /if \(!replayedDone\) \{[\s\S]*?restoreActiveSession\(rootID, sessionKey\)[\s\S]*?loadSessionsForRoot\(\s*rootID[\s\S]*?loadMultiProjectSessionGroups\(\)/,
  "replayed session.done must not re-sync the session or reload the session lists",
);

console.log("session done replay loop guard passed");
assert.match(
  app,
  /else if \(!isVisible\) \{[\s\S]*?markSessionStale\(rootID, sessionKey\)/,
  "background sessions should be marked stale so reopening them syncs real seqs",
);
