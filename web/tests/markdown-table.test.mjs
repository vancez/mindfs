import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let MarkdownViewer;
let I18nProvider;

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  ({ MarkdownViewer } = await server.ssrLoadModule("/src/components/MarkdownViewer.tsx"));
  ({ I18nProvider } = await server.ssrLoadModule("/src/i18n/index.tsx"));
});

after(async () => {
  await server?.close();
});

function renderMarkdown(content) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownViewer, { content }),
    ),
  );
}

test("aligned GFM tables keep base th/td styles alongside column text-align", () => {
  const plainHtml = renderMarkdown([
    "| A | B | C |",
    "|---|---|---|",
    "| 1 | 2 | 3 |",
  ].join("\n"));

  const alignedHtml = renderMarkdown([
    "| A | B | C |",
    "| :--- | :---: | ---: |",
    "| 1 | 2 | 3 |",
  ].join("\n"));

  const plainThs = [...plainHtml.matchAll(/<th\s+style="([^"]+)"/g)].map((m) => m[1]);
  const plainTds = [...plainHtml.matchAll(/<td\s+style="([^"]+)"/g)].map((m) => m[1]);
  const alignedThs = [...alignedHtml.matchAll(/<th\s+style="([^"]+)"/g)].map((m) => m[1]);
  const alignedTds = [...alignedHtml.matchAll(/<td\s+style="([^"]+)"/g)].map((m) => m[1]);

  assert.equal(plainThs.length, 3);
  assert.equal(plainTds.length, 3);
  assert.equal(alignedThs.length, 3);
  assert.equal(alignedTds.length, 3);

  for (const style of alignedThs) {
    assert.match(style, /padding:10px 12px/);
    assert.match(style, /font-weight:600/);
    assert.match(style, /white-space:nowrap/);
    assert.match(style, /vertical-align:top/);
  }
  assert.match(alignedThs[0], /text-align:left/);
  assert.match(alignedThs[1], /text-align:center/);
  assert.match(alignedThs[2], /text-align:right/);

  for (const style of alignedTds) {
    assert.match(style, /padding:10px 12px/);
    assert.match(style, /vertical-align:top/);
    assert.match(style, /border-top:1px solid rgba\(0,0,0,0\.03\)/);
  }
  assert.match(alignedTds[0], /text-align:left/);
  assert.match(alignedTds[1], /text-align:center/);
  assert.match(alignedTds[2], /text-align:right/);

  assert.doesNotMatch(alignedHtml, /\bnode="/);
});
