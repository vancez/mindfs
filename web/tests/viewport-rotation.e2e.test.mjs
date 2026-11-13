import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findBrowserExecutable, getFreePort } from "./browserExecutable.mjs";

// Boots the real app with a controllable visual viewport to replay the iOS
// rotation sequence: a landscape offset survives until the portrait layout
// starts consuming it, then iOS settles the offset without firing an event.

let server;
let browser;
before(async () => {
  const executablePath = await findBrowserExecutable();
  assert.ok(executablePath, "This E2E requires an installed Chromium browser");
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

async function installFakeViewport(page) {
  await page.addInitScript(() => {
    const listeners = new Map();
    const viewport = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(handler);
      },
      removeEventListener(type, handler) {
        listeners.get(type)?.delete(handler);
      },
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      get: () => viewport,
    });
    window.__viewportProbe = {
      setOffsetTop(value) {
        viewport.offsetTop = value;
      },
      emit(type) {
        for (const handler of listeners.get(type) || []) {
          handler(new Event(type));
        }
      },
    };
  });
}

function offsetTopVar(page) {
  return page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--mindfs-viewport-offset-top")
      .trim(),
  );
}

test("orientation change clears a stale viewport offset", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
    await installFakeViewport(page);
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--mindfs-viewport-height")
        .trim() !== "",
    );

    // Mobile layout pins #root to the visual-viewport offset.
    await page.evaluate(() => {
      window.__viewportProbe.setOffsetTop(34);
      window.__viewportProbe.emit("scroll");
    });
    assert.equal(await offsetTopVar(page), "34px");

    // Crossing into the landscape/desktop breakpoint must drop the offset,
    // otherwise it leaks back into the next portrait layout.
    await page.setViewportSize({ width: 900, height: 844 });
    await page.waitForTimeout(80);
    assert.equal(await offsetTopVar(page), "0px");

    // Back in portrait: the value may be re-measured as non-zero before iOS
    // settles, which is the state that used to remain on screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(80);
    assert.equal(await offsetTopVar(page), "34px");

    // Rotation resets the offset immediately. iOS then settles the offset to
    // zero without firing a viewport event; the rAF/timeout passes must adopt
    // that final value instead of the pre-settle measurement.
    const immediate = await page.evaluate(() => {
      window.dispatchEvent(new Event("orientationchange"));
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--mindfs-viewport-offset-top")
        .trim();
      window.__viewportProbe.setOffsetTop(0);
      return value;
    });
    assert.equal(immediate, "0px");
    await page.waitForTimeout(700);
    assert.equal(await offsetTopVar(page), "0px");
  } finally {
    await page.close();
  }
});
