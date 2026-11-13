import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIDEBAR_MAIN_MIN_WIDTH,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEYS,
  clearStoredSidebarWidth,
  clampSidebarWidth,
  defaultSidebarWidth,
  readStoredSidebarWidth,
  resizedSidebarWidth,
  writeStoredSidebarWidth,
} from "../src/layout/sidebarWidth.ts";

assert.equal(defaultSidebarWidth("file", false), 260);
assert.equal(defaultSidebarWidth("file", true), 200);
assert.equal(defaultSidebarWidth("session", false), 280);
assert.equal(defaultSidebarWidth("session", true), 240);

assert.equal(clampSidebarWidth(100, 900), SIDEBAR_WIDTH_MIN);
assert.equal(clampSidebarWidth(900, 900), SIDEBAR_WIDTH_MAX);
assert.equal(clampSidebarWidth(320, 240), 240);
assert.equal(SIDEBAR_MAIN_MIN_WIDTH, 320);

assert.equal(resizedSidebarWidth("left", 260, 40, 900), 300);
assert.equal(resizedSidebarWidth("left", 260, -80, 900), SIDEBAR_WIDTH_MIN);
assert.equal(resizedSidebarWidth("right", 280, -40, 900), 320);
assert.equal(resizedSidebarWidth("right", 280, 80, 900), 200);
assert.equal(resizedSidebarWidth("left", 260, 500, 380), 380);

const values = new Map();
const storage = {
  getItem(key) {
    return values.has(key) ? values.get(key) : null;
  },
  setItem(key, value) {
    values.set(key, value);
  },
  removeItem(key) {
    values.delete(key);
  },
};
assert.equal(readStoredSidebarWidth(storage, "file"), undefined);
writeStoredSidebarWidth(storage, "file", 321.4);
assert.equal(values.get(SIDEBAR_WIDTH_STORAGE_KEYS.file), "321");
assert.equal(readStoredSidebarWidth(storage, "file"), 321);
clearStoredSidebarWidth(storage, "file");
assert.equal(readStoredSidebarWidth(storage, "file"), undefined);

const appShell = readFileSync(new URL("../src/layout/AppShell.tsx", import.meta.url), "utf8");
assert.match(appShell, /onPointerDown=\{beginSidebarResize\("left"/, "left rail should start resizing from a pointer drag");
assert.match(appShell, /onPointerDown=\{beginSidebarResize\("right"/, "right rail should start resizing from a pointer drag");
assert.match(appShell, /onDoubleClick=\{handleRailDoubleClick\("left"/, "double-clicking the left rail should reset its width");
assert.match(appShell, /onDoubleClick=\{handleRailDoubleClick\("right"/, "double-clicking the right rail should reset its width");
assert.match(appShell, /resizedSidebarWidth\(/, "drag movement should use the shared resize math");
assert.match(appShell, /writeStoredSidebarWidth\(/, "resized widths should be persisted");
assert.match(appShell, /clearStoredSidebarWidth\(/, "double-click reset should clear the stored override");
assert.match(appShell, /transition: resizingSide \? "none"/, "grid width transitions must not lag behind the pointer");
assert.match(appShell, /data-sidebar-resize="left"/, "left rail should expose a stable resize hook");
assert.match(appShell, /data-sidebar-resize="right"/, "right rail should expose a stable resize hook");

const zh = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const en = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");
for (const locale of [zh, en]) {
  assert.match(locale, /"sidebar\.resizeHint":/);
}
assert.match(appShell, /const \[viewportWidth, setViewportWidth\]/, "the sidebar clamp must react to viewport resize");
assert.match(appShell, /sidebarResizeRef\.current = null;[\s\S]*?setResizingSide\(null\);/, "crossing the mobile breakpoint should clear drag state");
assert.match(appShell, /RAIL_DOUBLE_CLICK_REVERT_MS/, "double-click should undo a toggle that raced with a slow double click");
