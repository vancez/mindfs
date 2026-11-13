import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  app,
  /const lastActionBarSessionKeyRef = useRef\(""\);/,
  "the app should track the previous input session",
);
assert.match(
  app,
  /lastActionBarSessionKeyRef\.current = key;[\s\S]*?if \(!key \|\| key === previous\) return;[\s\S]*?handleClearFileContext\(\);/,
  "returning to a session from a diff or another session should clear the chip",
);
assert.match(
  app,
  /lastActionBarSessionKeyRef\.current = key;[\s\S]*?if \(!key \|\| key === previous\) return;/,
  "an empty input session must still advance the tracked key so returning to the same session clears",
);
assert.match(
  app,
  /key\.startsWith\("pending-"\) \|\| previous\.startsWith\("pending-"\)/,
  "draft promotion should keep the file context that was just sent",
);
assert.match(
  app,
  /const handleClearFileContext = useCallback\(\(\) => \{[\s\S]*?setAttachedFileContext\(null\);/,
  "clearing the file context should drop the chip state",
);
console.log("session switch file context passed");
