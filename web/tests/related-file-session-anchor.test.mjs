import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

const snapshotStart = app.indexOf("const lastMainSessionRoot =");
const snapshotEnd = app.indexOf("const relatedSessionRootId =", snapshotStart);
assert.ok(
  snapshotStart >= 0 && snapshotEnd > snapshotStart,
  "the related-session snapshot block should exist",
);
const snapshot = app.slice(snapshotStart, snapshotEnd);

assert.match(
  snapshot,
  /lastMainSessionRoot === currentRootId[\s\S]*?lastMainSessionSnapshotRef\.current/,
  "a last-main snapshot from another project must not leak into the related list",
);
assert.match(
  snapshot,
  /selectedSessionSnapshot \|\|\s*\(isDrawerOpen \? drawerSessionSnapshot : null\) \|\|\s*lastMainSessionSnapshotForRoot \|\|\s*drawerSessionSnapshot/,
  "the last viewed session should stay ahead of the drawer session unless the drawer is open",
);

const newSessionStart = app.indexOf("lastMainSessionSnapshotRef.current = null;");
assert.ok(
  newSessionStart > 0,
  "starting a new session should drop the previous related-file context",
);
assert.match(
  app,
  /selectedSessionByRootRef\.current\[root\] = null;[\s\S]*?lastMainSessionSnapshotRef\.current = null;[\s\S]*?setSelectedSession\(null\)/,
  "the new-session handler should reset the related-file context together with the selection",
);

console.log("related file session anchor passed");
