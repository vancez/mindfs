import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findBrowserExecutable, getFreePort } from "./browserExecutable.mjs";

// Mobile drawer engine regression suite. The user-visible contract:
//  - an edge swipe opens the drawer from the natural screen edge,
//  - swiping back on the drawer body and tapping the dimmed area close it,
//  - a gesture interrupted by the OS/PWA lifecycle (no touchend) must not
//    wedge the engine for the rest of the session,
//  - horizontally scrollable content keeps its own panning, but only while it
//    can still scroll in the direction of the finger.

const VIEWPORT = { width: 393, height: 851 };
const EDGE = 6;

let server;
let browser;
before(async () => {
  const executablePath = await findBrowserExecutable();
  assert.ok(executablePath, "Requires an installed Chromium browser");
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { host: "127.0.0.1", port: await getFreePort() },
  });
  await server.listen();
  browser = await chromium.launch({ executablePath, headless: true });
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function openFixture() {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: "zh-CN",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page);
  await page.goto(`${server.resolvedUrls.local[0]}tests/drawer-gesture.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const aside = document.querySelector("aside");
    return !!aside && getComputedStyle(aside).position === "fixed";
  });
  return { context, page, cdp };
}

async function drawerState(page) {
  const state = page.getByTestId("state");
  return {
    left: await state.getAttribute("data-left"),
    right: await state.getAttribute("data-right"),
  };
}

async function tapToggle(page, side) {
  const box = await page.getByRole("button", { name: `toggle-${side}` }).boundingBox();
  assert.ok(box, `${side} toggle is visible`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(450);
}

async function touchStart(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
}

async function touchMove(cdp, x, y) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  await new Promise((resolve) => setTimeout(resolve, 16));
}

async function touchEnd(cdp) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function swipe(cdp, x0, y0, dx, dy, steps = 12) {
  await touchStart(cdp, x0, y0);
  for (let step = 1; step <= steps; step += 1) {
    await touchMove(cdp, Math.round(x0 + (dx * step) / steps), Math.round(y0 + (dy * step) / steps));
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  await touchEnd(cdp);
  await new Promise((resolve) => setTimeout(resolve, 450));
}

test("tapping the dimmed area closes a tapped-open drawer", async () => {
  const { context, page } = await openFixture();
  try {
    await tapToggle(page, "left");
    assert.equal((await drawerState(page)).left, "open");
    await page.touchscreen.tap(VIEWPORT.width - 18, 300);
    await page.waitForTimeout(450);
    assert.equal((await drawerState(page)).left, "closed");
  } finally {
    await context.close();
  }
});

test("swiping back on the drawer body closes it", async () => {
  const { context, page, cdp } = await openFixture();
  try {
    await tapToggle(page, "left");
    await swipe(cdp, 200, 400, -170, 12);
    assert.equal((await drawerState(page)).left, "closed");

    await tapToggle(page, "right");
    await swipe(cdp, 200, 400, 170, 12);
    assert.equal((await drawerState(page)).right, "closed");
  } finally {
    await context.close();
  }
});

test("edge swipes open the drawers from the natural screen edge", async () => {
  const { context, page, cdp } = await openFixture();
  try {
    await swipe(cdp, EDGE, 420, 180, 8);
    assert.equal((await drawerState(page)).left, "open", "left edge swipe from x=6");

    await page.touchscreen.tap(VIEWPORT.width - 18, 300);
    await page.waitForTimeout(450);

    await swipe(cdp, VIEWPORT.width - EDGE, 420, -180, 8);
    assert.equal((await drawerState(page)).right, "open", "right edge swipe from the screen edge");
  } finally {
    await context.close();
  }
});

test("a vertical scroll starting at the edge stays a scroll", async () => {
  const { context, page, cdp } = await openFixture();
  try {
    const main = await page.locator("main").boundingBox();
    await swipe(cdp, EDGE, Math.round(main.y + main.height - 120), 2, -160);
    assert.equal((await drawerState(page)).left, "closed");
    const scrolled = await page.evaluate(() => {
      const scrollable = Array.from(document.querySelectorAll("main *")).find(
        (node) => node.scrollHeight > node.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(node).overflowY),
      );
      return scrollable ? scrollable.scrollTop : -1;
    });
    assert.ok(scrolled > 20, `main content scrolled (scrollTop=${scrolled})`);
  } finally {
    await context.close();
  }
});

test("an interrupted gesture (pagehide without touchend) does not wedge the drawer", async () => {
  const { context, page, cdp } = await openFixture();
  try {
    await tapToggle(page, "left");
    // Start a close drag, then simulate the PWA being backgrounded mid-touch:
    // the OS never delivers touchend for the finger that was down.
    await touchStart(cdp, 200, 400);
    await touchMove(cdp, 182, 402);
    await touchMove(cdp, 160, 404);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await touchEnd(cdp);
    await page.waitForTimeout(450);

    // The closed drag must not leave a frozen preview or a stuck flag: swiping
    // back on the body has to keep working.
    await swipe(cdp, 200, 400, -170, 12);
    assert.equal((await drawerState(page)).left, "closed", "swipe close after interruption");

    // And the dimmed-area tap has to keep working too.
    await tapToggle(page, "left");
    assert.equal((await drawerState(page)).left, "open");
    await page.touchscreen.tap(VIEWPORT.width - 18, 300);
    await page.waitForTimeout(450);
    assert.equal((await drawerState(page)).left, "closed", "overlay tap after interruption");
  } finally {
    await context.close();
  }
});

test("an active text selection suppresses drawer swipes", async () => {
  const { context, page, cdp } = await openFixture();
  const selectContents = (testId) => page.evaluate((testId) => {
    const target = document.querySelector(`[data-testid="${testId}"]`);
    const selection = window.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.addRange(range);
    return !selection.isCollapsed;
  }, testId);
  const clearSelection = () => page.evaluate(() => window.getSelection().removeAllRanges());
  try {
    // A selection in the transcript must not turn a drag into an edge swipe.
    assert.equal(await selectContents("code"), true, "dom selection created");
    await swipe(cdp, EDGE, 420, 180, 8);
    assert.equal((await drawerState(page)).left, "closed", "selection blocks edge open");
    await clearSelection();
    await swipe(cdp, EDGE, 420, 180, 8);
    assert.equal((await drawerState(page)).left, "open", "cleared selection restores edge open");

    // Same while closing: selecting a file/session name keeps the drawer put.
    assert.equal(await selectContents("left-scroll"), true, "drawer selection created");
    await swipe(cdp, 200, 400, -170, 12);
    assert.equal((await drawerState(page)).left, "open", "selection blocks swipe close");
    await clearSelection();
    await swipe(cdp, 200, 400, -170, 12);
    assert.equal((await drawerState(page)).left, "closed", "cleared selection restores swipe close");

    // Input/textarea selections are not exposed by window.getSelection.
    const selectComposer = (start, end) => page.evaluate(({ start, end }) => {
      const composer = document.querySelector('[data-testid="composer"]');
      composer.focus();
      composer.setSelectionRange(start, end);
    }, { start, end });
    await selectComposer(0, 8);
    await swipe(cdp, EDGE, 420, 180, 8);
    assert.equal((await drawerState(page)).left, "closed", "textarea selection blocks edge open");
    await selectComposer(0, 0);
    await swipe(cdp, EDGE, 420, 180, 8);
    assert.equal((await drawerState(page)).left, "open", "collapsed caret restores edge open");
  } finally {
    await context.close();
  }
});

test("horizontal scrollers keep panning only while they can scroll that way", async () => {
  const { context, page, cdp } = await openFixture();
  try {
    const code = await page.getByTestId("code").boundingBox();
    const codeY = Math.round(code.y + 120);
    const codeX = Math.round(code.x + 18);

    // At the start of its scroll range the code block cannot follow a
    // rightward pan; the edge drawer gets the gesture instead of silently
    // swallowing it.
    await swipe(cdp, codeX, codeY, 180, 6);
    assert.equal((await drawerState(page)).left, "open", "edge swipe over an unscrolled code block");
    await page.touchscreen.tap(VIEWPORT.width - 18, 300);
    await page.waitForTimeout(450);

    // Once scrolled it owns the rightward pan again, and the drawer stays shut.
    await page.getByTestId("code").evaluate((node) => {
      node.scrollLeft = 120;
    });
    await swipe(cdp, codeX, codeY, 120, 6);
    const scrolledLeft = await page.getByTestId("code").evaluate((node) => node.scrollLeft);
    assert.ok(scrolledLeft < 120 - 20, `code block consumed the pan (scrollLeft=${scrolledLeft})`);
    assert.equal((await drawerState(page)).left, "closed");

    // Same rule while closing: the chips row at its left end cannot scroll
    // further back, so the right drawer closes instead of ignoring the swipe.
    await tapToggle(page, "right");
    const chips = await page.getByTestId("chips").boundingBox();
    await swipe(cdp, Math.round(chips.x + chips.width / 2), Math.round(chips.y + chips.height / 2), 170, 4);
    assert.equal((await drawerState(page)).right, "closed", "swipe close starting on the chips row");
  } finally {
    await context.close();
  }
});
