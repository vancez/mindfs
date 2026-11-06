import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

assert.match(
  app,
  /const isNewDraft = !sendSessionKey && !!tempKey/,
  "the composer should distinguish a brand-new draft from an existing session",
);
assert.match(
  app,
  /if \(!isBoundInMain && !isNewDraft\) \{[\s\S]*?setDrawerOpenForRoot\(activeRoot, true\)/,
  "a new draft should not open the bottom sheet over the task board",
);
const autoStart = app.indexOf("if (sent && isNewDraft && session && !navigatedDuringSend) {");
const autoEnd = app.indexOf('console.info("[session/send] dispatched"', autoStart);
assert.ok(autoStart >= 0 && autoEnd > autoStart, "new draft auto-open block should exist");
const autoOpen = app.slice(autoStart, autoEnd);
assert.match(autoOpen, /selectedSessionRef\.current = draftItem/, "the accepted draft should become the selected session");
assert.match(autoOpen, /selectedSessionByRootRef\.current\[activeRoot\] = tempKey/, "the draft should be remembered for the active project");
assert.match(autoOpen, /setSelectedSession\(draftItem\)/, "the main workspace should switch to the draft immediately");
assert.match(autoOpen, /setMainViewPreferenceForRoot\(activeRoot, "session"\)/, "the project should prefer the session view");
assert.match(autoOpen, /setDrawerOpenForRoot\(activeRoot, false\)/, "opening the session in the main view should close the bottom sheet");
assert.match(autoOpen, /setFile\(null\)/, "file preview should be dismissed when entering the new session");
assert.match(autoOpen, /setGitDiff\(null\)/, "diff view should be dismissed when entering the new session");
assert.match(autoOpen, /if \(isMobile\) setIsRightOpen\(false\)/, "mobile should leave the session list for the main session view");

assert.match(
  app,
  /const selectedPendingInMain =[\s\S]*?selectedRoot === rootID[\s\S]*?selectedKey === pendingKey[\s\S]*?mainViewPreferenceByRootRef\.current\[rootID\] === "session"/,
  "promotion should detect a selected pending session still shown in the main workspace",
);
assert.match(
  app,
  /if \([\s\S]*?selectedPendingInMain[\s\S]*?currentRootIdRef\.current === rootID[\s\S]*?mainViewPreferenceByRootRef\.current\[rootID\] === "session"[\s\S]*?session: sessionKey/,
  "promotion should put the real session key into the URL only while the session view is active",
);
assert.match(app, /const navigationAtSend =/, "sending should snapshot the current navigation state");
assert.match(app, /fileOpenRequestRef\.current !== navigationAtSend\.fileRequest/, "auto-open must be skipped when a file was opened while sending");
assert.match(app, /sent && isNewDraft && session && !navigatedDuringSend/, "auto-open should not override user navigation");
