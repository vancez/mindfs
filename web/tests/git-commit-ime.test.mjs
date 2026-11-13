import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const gitStatusPanel = readFileSync(
  new URL("../src/components/GitStatusPanel.tsx", import.meta.url),
  "utf8",
);

assert.match(
  gitStatusPanel,
  /<textarea[\s\S]*?rows=\{3\}/,
  "Git commit messages should use a multiline textarea",
);
assert.match(
  gitStatusPanel,
  /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)[\s\S]*?isComposing[\s\S]*?void submitCommit\(\)/,
  "Ctrl/Cmd+Enter should submit, and IME confirmation must not submit a Git commit",
);
assert.doesNotMatch(
  gitStatusPanel,
  /if \(event\.key === "Enter"\) \{\s+if \(event\.nativeEvent\.isComposing\)/,
  "plain Enter must insert a newline instead of committing",
);
