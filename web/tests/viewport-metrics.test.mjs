import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("viewport offset is only applied by the mobile fixed layout", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  t.after(() => server.close());

  const { MOBILE_LAYOUT_QUERY, computeViewportOffsetTop } =
    await server.ssrLoadModule("/src/services/viewport.ts");

  assert.equal(MOBILE_LAYOUT_QUERY, "(max-width: 767px)");
  // Portrait web layout consumes the visual-viewport offset.
  assert.equal(computeViewportOffsetTop(false, true, 34), 34);
  // Landscape/desktop must not leak an offset into the next portrait layout.
  assert.equal(computeViewportOffsetTop(false, false, 34), 0);
  // Native shells pin #root at 0 and inject safe-area insets separately.
  assert.equal(computeViewportOffsetTop(true, true, 34), 0);
  // Defensive inputs.
  assert.equal(computeViewportOffsetTop(false, true, undefined), 0);
  assert.equal(computeViewportOffsetTop(false, true, Number.NaN), 0);
  assert.equal(computeViewportOffsetTop(false, true, -12), 0);
});
