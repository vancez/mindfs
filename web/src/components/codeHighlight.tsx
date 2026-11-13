import React from "react";
import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-go";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-css";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-diff";
import "./codeHighlight.css";

// Keep language detection in one place so preview, diff, and Markdown fences
// agree on how a path or fence identifier maps to Prism.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".py": "python",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rs": "rust",
  ".lua": "lua",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".html": "markup",
  ".htm": "markup",
  ".xml": "markup",
  ".svg": "markup",
  ".css": "css",
  ".md": "markdown",
  ".markdown": "markdown",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  cs: "csharp",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  golang: "go",
  "c++": "cpp",
  cxx: "cpp",
  "c#": "csharp",
};

const LINE_CACHE_LIMIT = 5000;
const LINE_CACHE_BYTE_BUDGET = 1 << 20;
const MAX_HIGHLIGHT_LINE_LENGTH = 2000;
const lineRenderCache = new Map<string, React.ReactNode>();
let lineRenderCacheBytes = 0;

function cacheLine(key: string, value: React.ReactNode) {
  const size = key.length;
  if (size > MAX_HIGHLIGHT_LINE_LENGTH) {
    return;
  }
  while (
    lineRenderCache.size >= LINE_CACHE_LIMIT ||
    lineRenderCacheBytes + size > LINE_CACHE_BYTE_BUDGET
  ) {
    const oldest = lineRenderCache.keys().next();
    if (oldest.done) {
      break;
    }
    const oldestKey = oldest.value;
    lineRenderCache.delete(oldestKey);
    lineRenderCacheBytes -= oldestKey.length;
  }
  lineRenderCache.set(key, value);
  lineRenderCacheBytes += size;
}

function normalizeExtension(ext?: string): string {
  const value = String(ext || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  return value.startsWith(".") ? value : `.${value}`;
}

function extensionFromPath(path?: string): string {
  const value = String(path || "").trim().split(/[?#]/, 1)[0];
  if (!value) {
    return "";
  }
  const base = value.replace(/\\/g, "/").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    return "";
  }
  return base.slice(dot).toLowerCase();
}

export function languageForExtension(ext?: string): string {
  return LANGUAGE_BY_EXTENSION[normalizeExtension(ext)] || "markup";
}

export function languageForPath(path?: string): string {
  // Unknown extensions stay unhighlighted: tokenizing them as markup is both
  // misleading and expensive for large diffs.
  return LANGUAGE_BY_EXTENSION[extensionFromPath(path)] || "";
}

export function supportsLineSelection(ext?: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    LANGUAGE_BY_EXTENSION,
    normalizeExtension(ext),
  );
}

function resolvedLanguage(language?: string): string {
  const raw = String(language || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  const alias = LANGUAGE_ALIASES[raw] || raw;
  if (Prism.languages[alias]) {
    return alias;
  }
  return Prism.languages[raw] ? raw : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlightCodeToHtml(code: string, language?: string): string {
  if (!code) {
    return "";
  }
  const resolved = resolvedLanguage(language);
  if (!resolved) {
    return "";
  }
  try {
    return Prism.highlight(code, Prism.languages[resolved], resolved);
  } catch {
    return escapeHtml(code);
  }
}

function renderPrismToken(
  token: string | Prism.Token,
  key: string,
): React.ReactNode {
  if (typeof token === "string") {
    return token;
  }
  const types = Array.isArray(token.type) ? [...token.type] : [token.type];
  if (token.alias) {
    types.push(...(Array.isArray(token.alias) ? token.alias : [token.alias]));
  }
  const content = token.content;
  return (
    <span key={key} className={`token ${types.join(" ")}`}>
      {typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((child, index) =>
              renderPrismToken(child, `${key}-${index}`),
            )
          : renderPrismToken(content, `${key}-0`)}
    </span>
  );
}

/**
 * Tokenize one line into React spans for diff rows. Per-line tokenization is
 * deliberate: a diff only contains hunks, so full-file context is unavailable
 * without another backend round trip. The cache keeps large/multi-render diffs
 * from retokenizing every line.
 */
export function renderHighlightedCode(
  text: string,
  language?: string,
): React.ReactNode {
  if (!text) {
    return null;
  }
  const resolved = resolvedLanguage(language);
  if (!resolved || text.length > MAX_HIGHLIGHT_LINE_LENGTH) {
    return text;
  }
  const cacheKey = `${resolved}|${text}`;
  const cached = lineRenderCache.get(cacheKey);
  if (cached !== undefined) {
    // Refresh LRU order.
    lineRenderCache.delete(cacheKey);
    lineRenderCache.set(cacheKey, cached);
    return cached;
  }
  let rendered: React.ReactNode;
  try {
    rendered = Prism.tokenize(text, Prism.languages[resolved]).map(
      (token, index) => renderPrismToken(token, `${index}`),
    );
  } catch {
    rendered = text;
  }
  cacheLine(cacheKey, rendered);
  return rendered;
}
