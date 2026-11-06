import { appURL } from "./base";
import { protectedJSON } from "./api";
import type { GitDiffPayload } from "./git";

export type SvnStatusCode = "M" | "A" | "D" | "R" | "C" | "??" | "!" | "~";

export type SvnStatusItem = {
  path: string;
  old_path?: string;
  status: SvnStatusCode | string;
  svn_status?: string;
  props_status?: string;
  additions: number;
  deletions: number;
  is_dir?: boolean;
  conflicted?: boolean;
};

export type SvnStatusPayload = {
  available: boolean;
  wc_root?: string;
  revision?: string;
  url?: string;
  dirty_count: number;
  items: SvnStatusItem[];
};

export type SvnDiffPayload = GitDiffPayload;

export type SvnActionPayload = {
  output: string;
  status: SvnStatusPayload;
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSvnStatusItem(payload: any): SvnStatusItem {
  return {
    path: typeof payload?.path === "string" ? payload.path : "",
    old_path: typeof payload?.old_path === "string" ? payload.old_path : undefined,
    status: typeof payload?.status === "string" ? payload.status : "",
    svn_status: typeof payload?.svn_status === "string" ? payload.svn_status : undefined,
    props_status: typeof payload?.props_status === "string" ? payload.props_status : undefined,
    additions: numberValue(payload?.additions),
    deletions: numberValue(payload?.deletions),
    is_dir: payload?.is_dir === true,
    conflicted: payload?.conflicted === true,
  };
}

function normalizeSvnStatusPayload(payload: any): SvnStatusPayload {
  const items = Array.isArray(payload?.items)
    ? payload.items.map(normalizeSvnStatusItem).filter((item: SvnStatusItem) => !!item.path)
    : [];
  return {
    available: payload?.available === true,
    wc_root: typeof payload?.wc_root === "string" ? payload.wc_root : undefined,
    revision: typeof payload?.revision === "string" ? payload.revision : undefined,
    url: typeof payload?.url === "string" ? payload.url : undefined,
    dirty_count: Number.isFinite(Number(payload?.dirty_count))
      ? Number(payload.dirty_count)
      : items.length,
    items,
  };
}

function normalizeSvnDiffPayload(payload: any, fallbackPath: string): SvnDiffPayload {
  return {
    path: typeof payload?.path === "string" ? payload.path : fallbackPath,
    display_path: typeof payload?.display_path === "string" ? payload.display_path : undefined,
    old_path: typeof payload?.old_path === "string" ? payload.old_path : undefined,
    status: typeof payload?.status === "string" ? payload.status : "",
    additions: numberValue(payload?.additions),
    deletions: numberValue(payload?.deletions),
    content: typeof payload?.content === "string" ? payload.content : "",
    commit: typeof payload?.commit === "string" ? payload.commit : undefined,
    base_head: typeof payload?.base_head === "string" ? payload.base_head : undefined,
    target_head: typeof payload?.target_head === "string" ? payload.target_head : undefined,
    source:
      payload?.source === "commit" || payload?.source === "commit_range" || payload?.source === "worktree"
        ? payload.source
        : undefined,
    svn_status: typeof payload?.svn_status === "string" ? payload.svn_status : undefined,
    binary: payload?.binary === true,
    property_changes: payload?.property_changes === true,
    property_only: payload?.property_only === true,
    base_revision: typeof payload?.base_revision === "string" ? payload.base_revision : undefined,
    target_revision: typeof payload?.target_revision === "string" ? payload.target_revision : undefined,
    file_meta: Array.isArray(payload?.file_meta) ? payload.file_meta : undefined,
  };
}

function normalizeSvnActionPayload(payload: any): SvnActionPayload {
  return {
    output: typeof payload?.output === "string" ? payload.output : "",
    status: normalizeSvnStatusPayload(payload?.status || {}),
  };
}

export async function updateSvn(rootId: string): Promise<SvnActionPayload> {
  const payload = await protectedJSON<any>(appURL("/api/svn/update"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId }),
  });
  return normalizeSvnActionPayload(payload);
}

export async function commitSvn(
  rootId: string,
  message: string,
  paths: string[] = [],
): Promise<SvnActionPayload> {
  const payload = await protectedJSON<any>(appURL("/api/svn/commit"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId, message, paths }),
  });
  return normalizeSvnActionPayload(payload);
}

export async function revertSvn(rootId: string, path: string): Promise<SvnActionPayload> {
  const payload = await protectedJSON<any>(appURL("/api/svn/revert"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId, path }),
  });
  return normalizeSvnActionPayload(payload);
}

export async function resolveSvn(rootId: string, path: string): Promise<SvnActionPayload> {
  const payload = await protectedJSON<any>(appURL("/api/svn/resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root: rootId, path }),
  });
  return normalizeSvnActionPayload(payload);
}

export async function fetchSvnStatus(rootId: string): Promise<SvnStatusPayload> {
  const payload = await protectedJSON<any>(
    appURL("/api/svn/status", new URLSearchParams({ root: rootId })),
  );
  return normalizeSvnStatusPayload(payload);
}

export async function fetchSvnDiff(rootId: string, path: string): Promise<SvnDiffPayload> {
  const payload = await protectedJSON<any>(
    appURL("/api/svn/diff", new URLSearchParams({ root: rootId, path })),
  );
  return normalizeSvnDiffPayload(payload, path);
}

export async function fetchSvnRelatedFileDiff(
  rootId: string,
  file: { path: string; head?: string; repo_path?: string; repo_kind?: string },
): Promise<SvnDiffPayload> {
  const params = new URLSearchParams({
    root: rootId,
    path: file.path,
  });
  if (file.repo_path) {
    params.set("repo_path", file.repo_path);
  }
  if (file.head) {
    params.set("revision", file.head);
  }
  const payload = await protectedJSON<any>(appURL("/api/svn/related-file/diff", params));
  return normalizeSvnDiffPayload(payload, file.path);
}
