import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { findBrowserExecutable, getFreePort } from "./browserExecutable.mjs";

// Shared runner for the SessionViewer fixture. Every regression check boots
// the same fixture page in a fresh tab; keeping the Vite/Chromium setup here
// avoids repeating the same before/after boilerplate in each test file.
//
// A check is:
//   { run: "runXChecks", label, waitFor?, viewports?, verify?(result) }
// `run` is the function registered on window by session-virtualization.tsx.

export const MOBILE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };
export const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

export function registerSessionViewerChecks(checks) {
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

  for (const check of checks) {
    for (const viewport of check.viewports ?? [MOBILE, DESKTOP]) {
      test(`${check.label} (${viewport.width}px)`, async () => {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
          ...(viewport.userAgent ? { userAgent: viewport.userAgent } : {}),
          ...(viewport.hasTouch ? { hasTouch: true } : {}),
        });
        try {
          await page.goto(
            `${server.resolvedUrls.local[0]}tests/session-virtualization.html`,
          );
          const selectors = check.waitFor ?? "[data-session-seq]";
          for (const selector of Array.isArray(selectors) ? selectors : [selectors]) {
            await page.waitForSelector(selector);
          }
          const result = await page.evaluate((name) => window[name](), check.run);
          assert.ok(result?.passed, `${check.label} did not pass`);
          check.verify?.(result);
        } finally {
          await page.close();
        }
      });
    }
  }
}
