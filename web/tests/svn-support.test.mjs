import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("../src/components/FileTree.tsx", import.meta.url), "utf8");
const diffViewer = readFileSync(new URL("../src/components/GitDiffViewer.tsx", import.meta.url), "utf8");
const sessionViewer = readFileSync(new URL("../src/components/SessionViewer.tsx", import.meta.url), "utf8");
const svnPanel = readFileSync(new URL("../src/components/SvnStatusPanel.tsx", import.meta.url), "utf8");
const svnService = readFileSync(new URL("../src/services/svn.ts", import.meta.url), "utf8");
const zhCN = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
const enUS = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");

assert.match(
  fileTree,
  /export type ProjectTreeTab = "files" \| "git" \| "svn" \| "worktrees" \| "related";/,
  "svn should be a project tree tab",
);
assert.match(
  fileTree,
  /currentRootIsSvnRepo[\s\S]*?\["files", "svn", "related"\]/,
  "an SVN root should only expose files, svn, and related tabs",
);
assert.match(
  fileTree,
  /projectTreeTab === "svn"[\s\S]*?renderRootSvnContent/,
  "the svn tab should render the SVN status panel",
);
assert.match(
  fileTree,
  /if \(!rootId \|\| availableProjectTreeTabs\.includes\(projectTreeTab\)\)/,
  "the persisted svn tab should not be discarded before the root is known",
);
assert.match(
  app,
  /is_svn_repo\?: boolean/,
  "managed root payload should expose is_svn_repo",
);
assert.match(
  app,
  /fetchSvnStatus/,
  "App should load SVN status",
);
assert.match(
  app,
  /fetchSvnRelatedFileDiff/,
  "App should route SVN related files to the SVN diff endpoint",
);
assert.match(
  app,
  /repoKind === "svn"[\s\S]*?fetchSvnRelatedFileDiff/,
  "related file diffs should dispatch on repo_kind svn",
);
assert.match(
  app,
  /renderRootSvnContent=\{renderRootSvnContent\}/,
  "App should pass the SVN root renderer to FileTree",
);
assert.doesNotMatch(
  app,
  /useRelatedFileStats/,
  "related files should not auto-fetch per-file diff stats",
);
assert.doesNotMatch(
  sessionViewer,
  /useRelatedFileStats/,
  "the session viewer should not auto-fetch per-file diff stats",
);
assert.match(
  svnService,
  /\/api\/svn\/status[\s\S]*?\/api\/svn\/diff[\s\S]*?\/api\/svn\/related-file\/diff/,
  "SVN service should call the SVN endpoints",
);
assert.match(
  svnService,
  /\/api\/svn\/update[\s\S]*?\/api\/svn\/commit[\s\S]*?\/api\/svn\/revert/,
  "SVN service should expose update, commit, and revert actions",
);
assert.match(
  svnPanel,
  /onRevert/,
  "SVN panel should expose a revert action",
);
assert.match(
  app,
  /svn\.revertConfirm/,
  "SVN revert should ask for confirmation",
);
assert.match(
  svnPanel,
  /onDismissAction[\s\S]*?t\("common\.close"\)/,
  "SVN action output should have a close button",
);
assert.match(
  app,
  /onDismissAction=\{handleSvnDismissAction\}/,
  "App should clear SVN action output when dismissed",
);
assert.match(
  svnPanel,
  /onUpdate[\s\S]*?onCommit[\s\S]*?<textarea/,
  "SVN panel should expose update and multiline commit controls",
);
assert.match(
  svnPanel,
  /event\.key === "Enter" && \(event\.metaKey \|\| event\.ctrlKey\)/,
  "SVN commit should submit with Ctrl/Cmd+Enter while allowing multiline input",
);
assert.match(
  svnPanel,
  /type="checkbox"[\s\S]*?selectedPaths/,
  "SVN panel should allow selecting files for commit",
);
assert.match(
  svnPanel,
  /useState<Set<string>>\(\s*\(\) => new Set\(persisted\?\.selectedPaths \?\? \[\]\),?\s*\)/,
  "SVN commit selection should be restored per root and start empty by default",
);
assert.match(
  svnPanel,
  /panelStateCache/,
  "commit selection and draft should survive tab/root remounts",
);
assert.doesNotMatch(
  svnPanel,
  /selectionInitializedRef/,
  "SVN commit selection must not auto-select every file",
);
assert.match(
  svnPanel,
  /item\.status !== "C" && item\.status !== "~"/,
  "versioned files and directories (except conflicts/obstructions) should be selectable",
);
assert.match(svnService, /resolveSvn[\s\S]*?\/api\/svn\/resolve/, "SVN service should expose a resolve action");
assert.match(app, /onResolve=/, "App should pass the resolve action to the SVN panel");
assert.match(app, /navigatedDuringSend/, "new-draft auto-open must not override user navigation");
assert.match(
  svnPanel,
  /const commitDisabled =[\s\S]*?selectedPaths\.size === 0[\s\S]*?disabled=\{commitDisabled && !commitOpen\}/,
  "SVN commit should stay disabled until a file is selected but remain closable once opened",
);
assert.match(
  fileTree,
  /tabRootCollapsed/,
  "root expansion in non-files tabs should use independent state",
);
assert.match(
  fileTree,
  /usesTabRootExpansion[\s\S]*?tabRootStateKey\(projectTreeTab, entry\.path\)/,
  "managed root expansion should be keyed by project tree tab",
);
assert.match(
  fileTree,
  /usesTabRootExpansion[\s\S]*?setTabRootCollapsed/,
  "toggling a root in a non-files tab should not change the Files tab expansion",
);
assert.match(
  svnService,
  /commitSvn[\s\S]*?paths[\s\S]*?\/api\/svn\/commit/,
  "SVN commit service should send the selected paths",
);
assert.match(
  diffViewer,
  /svn\.binaryDiff[\s\S]*?svn\.propertyOnlyDiff[\s\S]*?svn\.propertyChangesOmitted/,
  "diff viewer should surface SVN binary/property notices",
);
for (const key of [
  "fileTree.svn",
  "session.svnRevision",
  "svn.binaryDiff",
  "svn.propertyOnlyDiff",
  "svn.propertyChangesOmitted",
]) {
  assert.match(zhCN, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `zh-CN should define ${key}`);
  assert.match(enUS, new RegExp(`"${key.replaceAll(".", "\\.")}"`), `en-US should define ${key}`);
}
assert.match(svnPanel, /svn\.resolveFile/, "conflicted entries should expose a resolve action");
assert.match(svnPanel, /onRefresh/, "a failed status load should offer an in-place retry");
assert.match(
  app,
  /projectTreeTabRef\.current === "svn"[\s\S]*?refreshSvnStatus/,
  "watcher-driven SVN status refresh should only run while the SVN tab is visible",
);
