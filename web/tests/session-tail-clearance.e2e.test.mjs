import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findBrowserExecutable, getFreePort } from "./browserExecutable.mjs";

// Boots the session virtualization fixture and checks that the floating
// user-message-summary button (and its count badge) stay below the last
// message at the tail. Without the tail clearance in SessionViewer the button
// covers the right edge of the final reply.

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

for (const [width, height] of [[390, 844], [1280, 800]]) test(`the transcript tail clears the summary control (${width}px)`, async () => {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}tests/session-virtualization.html`);
    await page.waitForSelector('[data-mindfs-user-summary="1"]');
    await page.waitForSelector('[data-session-seq]');
    const result = await page.evaluate(() => window.runTailClearanceChecks());
    assert.ok(result.passed, "tail clearance check did not pass");
    assert.ok(result.clearance >= 0, `expected no overlap, got ${result.clearance}px`);
  } finally {
    await page.close();
  }
});
