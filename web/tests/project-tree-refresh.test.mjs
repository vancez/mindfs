import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");
const fileService = readFileSync(new URL("../src/services/file.ts", import.meta.url), "utf8");
const zhCN = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUS = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

assert.match(
  fileTree,
  /onRefresh\?: \(tab: ProjectTreeTab\) => void \| Promise<void>/,
  "FileTree refresh should identify the active project tab",
);
assert.match(
  fileTree,
  /\(\) => onRefresh\?\.\(projectTreeTab\)/,
  "FileTree should refresh the tab that is active when the button is clicked",
);
assert.match(
  fileTree,
  /flexShrink: 0, gap: 0, overflow: "visible"[\s\S]*?maxWidth: "calc\(100% - 56px\)", marginRight: "6px"/,
  "refresh should keep a 6px tab gap while reclaiming refresh control width",
);
assert.match(
  fileTree,
  /data-onboarding="sidebar-refresh"[\s\S]*?width: "22px"[\s\S]*?justifyContent: "flex-end"/,
  "refresh hit area should shrink without moving its right edge",
);
assert.match(
  fileTree,
  /data-refresh-visual[\s\S]*?width: "18px"[\s\S]*?background: treePressed \|\| treeRefreshing[\s\S]*?justifyContent: "center"/,
  "refresh feedback background should center tightly around the icon",
);

assert.match(
  app,
  /case "files":[\s\S]*?await refreshTreeDir\(root, dir, true\)/,
  "files refresh should await the current directory request",
);
assert.match(
  app,
  /case "git":[\s\S]*?refreshGitStatus\(root\)[\s\S]*?refreshGitHistory\(root, \{ waitForIncremental: true \}\)/,
  "git refresh should reload status and await an incremental history probe",
);
assert.match(
  app,
  /case "svn":[\s\S]*?await refreshSvnStatus\(root\)/,
  "svn refresh should reload the current working copy status",
);
assert.match(
  app,
  /case "worktrees":[\s\S]*?loadProjectTreeWorktrees\(root\)[\s\S]*?expandedWorktreeByRoot\[root\][\s\S]*?loadProjectTreeWorktreeStatus\(expandedPath\)/,
  "worktree refresh should reload the list and only the expanded worktree status",
);
assert.match(
  app,
  /fetchGitHistory\(rootID, \{ afterCommit: newest \}\)[\s\S]*?options\?\.waitForIncremental[\s\S]*?return refreshAfterNewest\(\)/,
  "manual history refresh should await the existing after_commit probe",
);
assert.match(
  app,
  /data-onboarding="task-refresh"[\s\S]*?width: "22px"[\s\S]*?data-task-refresh-visual[\s\S]*?width: "18px"/,
  "task refresh should use a compact hit area and centered feedback background",
);
assert.match(
  app,
  /data-onboarding="task-create"[\s\S]*?width: "28px"[\s\S]*?background: taskCreateTemplateMenuOpen[\s\S]*?justifyContent: "center"/,
  "task create should retain its normal button size",
);
assert.match(
  app,
  /case "related":[\s\S]*?refreshProjectTreeRelatedFiles\(\)[\s\S]*?rootIsSvn \? refreshSvnStatus\(root\) : refreshGitStatus\(root\)/,
  "related refresh should reload relationships and the current VCS file statistics",
);
assert.match(
  fileTree,
  /SIDEBAR_FOOTER_HIDDEN_STORAGE_KEY = "mindfs-sidebar-footer-hidden"/,
  "the sidebar footer visibility should be persisted",
);
assert.match(
  fileTree,
  /setHideSidebarFooter\(\(hidden\) => !hidden\)/,
  "the sidebar menu should expose a footer visibility toggle",
);
assert.match(
  fileTree,
  /display: hideSidebarFooter \? "none" : "flex"/,
  "the whole sidebar footer should be hidden by the toggle",
);
for (const key of ["fileTree.hideSidebarFooter"]) {
  assert.match(zhCN, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `zh-CN should define ${key}`);
  assert.match(enUS, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `en-US should define ${key}`);
}

assert.match(
  fileService,
  /export function invalidateFileCache[\s\S]*?rawFileFailures\.delete\(buildRawFileFailureKey\(rootId, path\)\)/,
  "file-change invalidation should clear the matching raw 404 cache entry",
);
assert.match(
  fileService,
  /export function clearFileCacheForRoot[\s\S]*?for \(const key of rawFileFailures\.keys\(\)\)[\s\S]*?rawFileFailures\.delete\(key\)/,
  "root cache clearing should remove raw 404 entries",
);
assert.match(
  fileService,
  /if \(failedAt !== undefined\)[\s\S]*?Date\.now\(\) - failedAt < RAW_FILE_FAILURE_TTL_MS[\s\S]*?rawFileFailures\.delete\(cacheKey\)/,
  "expired raw 404 entries should be removed instead of accumulating",
);
