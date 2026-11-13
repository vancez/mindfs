import assert from "node:assert/strict";
import test from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { remarkTrimQuotedAutolinks } from "../src/components/markdownAutolinks.ts";

function renderParagraph(markdown) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm, { singleTilde: false })
    .use(remarkTrimQuotedAutolinks);
  const tree = processor.parse(markdown);
  processor.runSync(tree);
  return tree.children[0].children.map((node) =>
    node.type === "link"
      ? {
          type: "link",
          url: node.url,
          text: node.children.map((child) => child.value || "").join(""),
        }
      : { type: node.type, text: node.value || "" }
  );
}

test("autolinks inside inline JSON stop at the closing quote", () => {
  const json = '{"url":"https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rewrite/Loon/Advertising/Advertising.plugin","prompt":"Show the first 40 lines including metadata, [Script], and [Mitm]/[MITM] sections verbatim. Does the MitM hostname line use %APPEND%?"}';
  const nodes = renderParagraph(json);
  const link = nodes.find((node) => node.type === "link");

  assert.equal(
    link.url,
    "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rewrite/Loon/Advertising/Advertising.plugin",
    "the href should end where the JSON string ends",
  );
  assert.equal(link.text, link.url, "the link label should not include the following JSON fields");
  assert.ok(
    nodes.some((node) => node.type === "text" && node.text.startsWith('","prompt":"')),
    "the rest of the JSON should remain plain text",
  );
});

test("ordinary prose autolinks are unchanged", () => {
  const nodes = renderParagraph("See https://example.com/path?q=1 for details.");
  assert.deepEqual(nodes, [
    { type: "text", text: "See " },
    { type: "link", url: "https://example.com/path?q=1", text: "https://example.com/path?q=1" },
    { type: "text", text: " for details." },
  ]);
});

test("labeled links that contain a quote keep their label", () => {
  const nodes = renderParagraph('[docs](https://example.com/a"b)');
  assert.deepEqual(nodes, [
    { type: "link", url: 'https://example.com/a"b', text: "docs" },
  ]);
});
