import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");

assert.match(
  fileTree,
  /PROJECT_SCOPED_TREE_TABS[\s\S]*?"git"[\s\S]*?"svn"[\s\S]*?"worktrees"[\s\S]*?"related"/,
  "git, svn, worktree and related tabs should be scoped to the current project",
);
assert.match(
  fileTree,
  /PROJECT_SCOPED_TREE_TABS\.has\(projectTreeTab\)[\s\S]*?entry\.path === rootId/,
  "scoped tabs should only list the current managed root",
);

console.log("project tree scoped tabs passed");
