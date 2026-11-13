type MarkdownNode = {
  type: string;
  url?: string;
  value?: string;
  children?: MarkdownNode[];
};

/**
 * GFM autolinks end at whitespace, so a URL inside inline JSON such as
 * `{"url":"https://example.com","prompt":"..."}` becomes one link whose href
 * swallows `","prompt":"..."`. Raw quotes cannot appear in a real URL, so cut
 * such links at the first quote and leave the remainder as plain text.
 */
export function remarkTrimQuotedAutolinks() {
  return (tree: MarkdownNode) => {
    splitChildLinks(tree);
  };
}

function splitChildLinks(node: MarkdownNode) {
  if (!Array.isArray(node.children)) return;
  const next: MarkdownNode[] = [];
  for (const child of node.children) {
    const parts = splitQuotedAutolink(child);
    if (parts) {
      next.push(...parts);
      continue;
    }
    splitChildLinks(child);
    next.push(child);
  }
  node.children = next;
}

function splitQuotedAutolink(node: MarkdownNode): MarkdownNode[] | null {
  if (node.type !== "link" || typeof node.url !== "string") return null;
  const quoteIndex = node.url.indexOf('"');
  if (quoteIndex <= 0) return null;
  // Only split bare autolinks (link text mirrors the URL), never a labeled
  // `[text](href)` link whose label happens to differ from the href.
  const child = node.children?.length === 1 ? node.children[0] : undefined;
  if (!child || child.type !== "text" || child.value !== node.url) return null;
  const url = node.url.slice(0, quoteIndex);
  return [
    { ...node, url, children: [{ ...child, value: url }] },
    { type: "text", value: node.url.slice(quoteIndex) },
  ];
}
