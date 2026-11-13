import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const highlight = readFileSync(new URL("../src/components/codeHighlight.tsx", import.meta.url), "utf8");
const highlightCss = readFileSync(new URL("../src/components/codeHighlight.css", import.meta.url), "utf8");
const codeViewer = readFileSync(new URL("../src/components/CodeViewer.tsx", import.meta.url), "utf8");
const markdownViewer = readFileSync(new URL("../src/components/MarkdownViewer.tsx", import.meta.url), "utf8");
const diffViewer = readFileSync(new URL("../src/components/GitDiffViewer.tsx", import.meta.url), "utf8");
const editorState = readFileSync(new URL("../src/components/editor/codeEditorState.ts", import.meta.url), "utf8");
const fileEditorCss = readFileSync(new URL("../src/components/FileEditor.css", import.meta.url), "utf8");

assert.match(highlight, /const LANGUAGE_BY_EXTENSION: Record<string, string>/, "preview and diff should share one extension table");
assert.match(highlight, /export function languageForPath/, "diff language detection should live in the shared module");
assert.match(highlight, /export function highlightCodeToHtml/, "preview should use the shared highlighter");
assert.match(highlight, /export function renderHighlightedCode/, "diff should use the shared token renderer");
assert.match(highlight, /prismjs\/components\/prism-typescript/, "shared module should own grammar imports");
assert.match(highlight, /prismjs\/components\/prism-lua/, "Lua grammar should be loaded for preview, Markdown fences, and diff");
assert.match(highlight, /"\.lua": "lua"/, "Lua files should resolve to the Lua grammar");

assert.match(codeViewer, /from "\.\/codeHighlight"/, "CodeViewer should use the shared highlighting module");
assert.doesNotMatch(codeViewer, /prismjs\/themes/, "CodeViewer should not import a separate Prism theme");
assert.match(markdownViewer, /highlightCodeToHtml/, "Markdown code fences should use the shared highlighter");
assert.doesNotMatch(markdownViewer, /from "prismjs"/, "Markdown should not own a separate Prism setup");

assert.match(diffViewer, /languageForPath/, "diff viewer should resolve the language from the file path");
assert.match(diffViewer, /renderHighlightedCode/, "diff lines should be syntax highlighted");
assert.match(diffViewer, /renderDiffLineContent\([^)]*diffLanguage\)/, "diff highlighting should be passed through line rendering");

assert.match(highlightCss, /--code-token-keyword:/, "shared token colors should be CSS variables");
assert.match(highlightCss, /:root\[data-theme="dark"\][\s\S]*?--code-token-keyword:/, "dark theme should override the shared token colors");
assert.match(highlightCss, /\.token\.keyword[\s\S]*?var\(--code-token-keyword\)/, "Prism tokens should use the shared colors");
assert.match(editorState, /var\(--code-token-keyword\)/, "CodeMirror should use the same token colors");
assert.doesNotMatch(editorState, /--file-code-/, "CodeMirror should not use a separate token color palette");
assert.doesNotMatch(fileEditorCss, /--file-code-/, "FileEditor.css should not duplicate the token color palette");
assert.match(highlight, /MAX_HIGHLIGHT_LINE_LENGTH/, "very long diff lines should skip tokenization");
assert.match(highlight, /LINE_CACHE_BYTE_BUDGET/, "the per-line cache should be bounded by bytes, not only entries");
assert.match(highlight, /languageForPath[\s\S]*?\|\| ""/, "unknown extensions should stay unhighlighted");
assert.match(diffViewer, /React\.memo\(function GitDiffViewer/, "the diff viewer should be memoized");
