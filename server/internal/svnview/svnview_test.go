package svnview

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseInfoXMLSVN17(t *testing.T) {
	root := filepath.Join(t.TempDir(), "wc")
	data := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<info>
<entry kind="dir" path="." revision="42">
<url>file:///repo/trunk</url>
<repository><root>file:///repo</root></repository>
<wc-info><wcroot-abspath>` + root + `</wcroot-abspath></wc-info>
</entry>
</info>`)
	info, err := parseInfoXML(data, "/fallback")
	if err != nil {
		t.Fatalf("parseInfoXML: %v", err)
	}
	if info.Revision != "42" || info.WCRoot != root || info.URL != "file:///repo/trunk" || info.RepoRoot != "file:///repo" {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestParseInfoXMLFallsBackToRoot(t *testing.T) {
	data := []byte(`<info><entry kind="dir" path="." revision="7"><url>u</url></entry></info>`)
	info, err := parseInfoXML(data, "/fallback")
	if err != nil {
		t.Fatalf("parseInfoXML: %v", err)
	}
	if info.WCRoot != filepath.Clean("/fallback") || info.Revision != "7" {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func TestStatusItemFromEntryMapping(t *testing.T) {
	root := t.TempDir()
	cases := []struct {
		name       string
		entry      svnStatusEntry
		wantStatus string
		wantOK     bool
		conflicted bool
	}{
		{"modified", svnStatusEntry{Path: "a.txt", Item: "modified"}, "M", true, false},
		{"added", svnStatusEntry{Path: "a.txt", Item: "added"}, "A", true, false},
		{"deleted", svnStatusEntry{Path: "a.txt", Item: "deleted"}, "D", true, false},
		{"missing", svnStatusEntry{Path: "a.txt", Item: "missing"}, "!", true, false},
		{"unversioned", svnStatusEntry{Path: "a.txt", Item: "unversioned"}, "??", true, false},
		{"conflicted", svnStatusEntry{Path: "a.txt", Item: "conflicted"}, "C", true, true},
		{"tree conflicted", svnStatusEntry{Path: "a.txt", Item: "modified", TreeConflicted: true}, "C", true, true},
		{"prop modified", svnStatusEntry{Path: "a.txt", Item: "normal", Props: "modified"}, "M", true, false},
		{"prop conflicted", svnStatusEntry{Path: "a.txt", Item: "normal", Props: "conflicted"}, "C", true, true},
		{"ignored", svnStatusEntry{Path: "a.txt", Item: "ignored"}, "", false, false},
		{"normal", svnStatusEntry{Path: "a.txt", Item: "normal"}, "", false, false},
		{"mindfs", svnStatusEntry{Path: ".mindfs/project.json", Item: "unversioned"}, "", false, false},
		{"svn metadata", svnStatusEntry{Path: ".svn/entries", Item: "modified"}, "", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			item, ok := statusItemFromEntry(root, tc.entry)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if item.Status != tc.wantStatus {
				t.Fatalf("status = %q, want %q", item.Status, tc.wantStatus)
			}
			if item.Conflicted != tc.conflicted {
				t.Fatalf("conflicted = %v, want %v", item.Conflicted, tc.conflicted)
			}
		})
	}
}

func TestParseStatusXML(t *testing.T) {
	data := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<status>
<target path=".">
<entry path="src/a.ts">
<wc-status item="modified" props="none" revision="41" tree-conflicted="false"></wc-status>
</entry>
<entry path="newdir" kind="dir">
<wc-status item="unversioned" props="none" revision="0"></wc-status>
</entry>
</target>
</status>`)
	entries, err := parseStatusXML(data)
	if err != nil {
		t.Fatalf("parseStatusXML: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %d, want 2", len(entries))
	}
	if entries[0].Path != "src/a.ts" || entries[0].Item != "modified" || entries[0].Revision != "41" {
		t.Fatalf("unexpected first entry: %+v", entries[0])
	}
	if entries[1].Kind != "dir" || entries[1].Item != "unversioned" {
		t.Fatalf("unexpected second entry: %+v", entries[1])
	}
}

func TestNormalizeSVNDiffModifiedWithProperties(t *testing.T) {
	section := diffSection{
		path: "src/a.ts",
		lines: strings.Split(`===================================================================
--- src/a.ts	(revision 41)
+++ src/a.ts	(working copy)
@@ -1,3 +1,3 @@
 a
-old
+new
 b
Property changes on: src/a.ts
___________________________________________________________________
Modified: svn:executable
## -0,0 +1 ##
+*`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if got.additions != 1 || got.deletions != 1 {
		t.Fatalf("stats = +%d/-%d, want +1/-1", got.additions, got.deletions)
	}
	if !got.propertyChanges || got.propertyOnly || got.binary {
		t.Fatalf("flags = changes:%v only:%v binary:%v", got.propertyChanges, got.propertyOnly, got.binary)
	}
	if strings.Contains(got.content, "Property changes") || strings.Contains(got.content, "Index:") || strings.Contains(got.content, "=====") {
		t.Fatalf("content was not normalized:\n%s", got.content)
	}
	if !strings.Contains(got.content, "-old\n+new") {
		t.Fatalf("content missing hunk lines:\n%s", got.content)
	}
}

func TestNormalizeSVNDiffLocalizedPropertySection(t *testing.T) {
	section := diffSection{
		path: "foo.txt",
		lines: strings.Split(`===================================================================
--- foo.txt	(revision 1)
+++ foo.txt	(working copy)
@@ -1 +1 @@
-old
+new

属性变更于: foo.txt
___________________________________________________________________
Added: svn:keywords
## -0,0 +1 ##
+Id`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if got.additions != 1 || got.deletions != 1 {
		t.Fatalf("stats = +%d/-%d, want +1/-1", got.additions, got.deletions)
	}
	if !got.propertyChanges {
		t.Fatal("property changes should be detected from the separator line")
	}
	if got.propertyOnly || got.binary {
		t.Fatalf("flags = only:%v binary:%v", got.propertyOnly, got.binary)
	}
	if strings.Contains(got.content, "属性变更") || strings.Contains(got.content, "+Id") {
		t.Fatalf("localized property content leaked into body:\n%s", got.content)
	}
}

func TestDecodeSVNBodyMixedUTF8AndGBK(t *testing.T) {
	raw := "@@ -1 +1 @@\n-" + string(gbkEncoded(t, "旧内容\n")) + "+新内容\n"
	got := decodeSVNBody(raw, ".txt")
	if !strings.Contains(got, "旧内容") || !strings.Contains(got, "新内容") {
		t.Fatalf("mixed decoded body = %q", got)
	}
}

func TestDecodeSVNTextUnknownExtension(t *testing.T) {
	input := gbkEncoded(t, "中文内容\n")
	got := decodeSVNText(input, ".dat")
	if !strings.Contains(got, "中文内容") {
		t.Fatalf("decoded content = %q, want Chinese text", got)
	}
}

func TestDecodeSVNPath(t *testing.T) {
	input := string(gbkEncoded(t, "中文.txt"))
	if got := decodeSVNPath(input); got != "中文.txt" {
		t.Fatalf("decoded path = %q, want 中文.txt", got)
	}
}

func TestNormalizeSVNDiffPropertyOnly(t *testing.T) {
	section := diffSection{
		path: "foo.txt",
		lines: strings.Split(`===================================================================
--- foo.txt	(revision 1)
+++ foo.txt	(working copy)
Property changes on: foo.txt
___________________________________________________________________
Added: svn:keywords
## -0,0 +1 ##
+Id`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if !got.propertyChanges || !got.propertyOnly {
		t.Fatalf("flags = changes:%v only:%v", got.propertyChanges, got.propertyOnly)
	}
	if got.content != "" || got.additions != 0 || got.deletions != 0 {
		t.Fatalf("unexpected content/stats: %q %d/%d", got.content, got.additions, got.deletions)
	}
}

func TestNormalizeSVNDiffBinary(t *testing.T) {
	section := diffSection{
		path: "img.png",
		lines: strings.Split(`===================================================================
Cannot display: file marked as a binary type.
svn:mime-type = application/octet-stream`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if !got.binary || got.content != "" || got.additions != 0 || got.deletions != 0 {
		t.Fatalf("unexpected binary result: %+v", got)
	}
}

func TestNormalizeSVNDiffEmptyAddedFile(t *testing.T) {
	section := diffSection{
		path: "empty.txt",
		lines: strings.Split(`===================================================================
--- empty.txt	(revision 0)
+++ empty.txt	(working copy)`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if got.binary || got.propertyOnly || got.additions != 0 || got.deletions != 0 {
		t.Fatalf("unexpected result: %+v", got)
	}
	if got.content != "" {
		t.Fatalf("empty file diff content = %q, want empty", got.content)
	}
}

func TestNormalizeSVNDiffDeletedFile(t *testing.T) {
	section := diffSection{
		path: "gone.txt",
		lines: strings.Split(`===================================================================
--- gone.txt	(revision 3)
+++ gone.txt	(working copy)
@@ -1,2 +0,0 @@
-a
-b`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if got.additions != 0 || got.deletions != 2 {
		t.Fatalf("stats = +%d/-%d, want +0/-2", got.additions, got.deletions)
	}
	if status := diffStatusFromContent(got.content); status != "D" {
		t.Fatalf("status = %q, want D", status)
	}
}

func TestCollectDiffStatsWithMultipleSections(t *testing.T) {
	root := t.TempDir()
	text := `Index: src/a.ts
===================================================================
--- src/a.ts	(revision 1)
+++ src/a.ts	(working copy)
@@ -1 +1,2 @@
 a
+b
Index: src/b.ts
===================================================================
--- src/b.ts	(revision 1)
+++ src/b.ts	(working copy)
@@ -1,2 +1 @@
-a
 b
`
	stats := collectDiffStats(root, text)
	a, ok := stats["src/a.ts"]
	if !ok || a.additions != 1 || a.deletions != 0 {
		t.Fatalf("a stats = %+v, ok=%v", a, ok)
	}
	b, ok := stats["src/b.ts"]
	if !ok || b.additions != 0 || b.deletions != 1 {
		t.Fatalf("b stats = %+v, ok=%v", b, ok)
	}
}

func TestSynthAddedDiff(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "new.txt"), []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	diff, err := synthAddedDiff(root, "new.txt")
	if err != nil {
		t.Fatalf("synthAddedDiff: %v", err)
	}
	if diff.Additions != 2 || diff.Status != "??" {
		t.Fatalf("unexpected diff: %+v", diff)
	}
	if !strings.Contains(diff.Content, "@@ -0,0 +1,2 @@") || !strings.Contains(diff.Content, "+a\n+b\n") {
		t.Fatalf("unexpected content:\n%s", diff.Content)
	}
}

func TestSynthAddedDiffKeepsUTF8(t *testing.T) {
	root := t.TempDir()
	content := "local 玩家数据 = {}\n-- 工作流\n"
	if err := os.WriteFile(filepath.Join(root, "config.lua"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	diff, err := synthAddedDiff(root, "config.lua")
	if err != nil {
		t.Fatalf("synthAddedDiff: %v", err)
	}
	if diff.Additions != 2 {
		t.Fatalf("additions = %d, want 2", diff.Additions)
	}
	if !strings.Contains(diff.Content, "玩家数据") || !strings.Contains(diff.Content, "工作流") {
		t.Fatalf("UTF-8 content was corrupted:\n%s", diff.Content)
	}
	if strings.Contains(diff.Content, "�") {
		t.Fatalf("UTF-8 content contains replacement characters:\n%s", diff.Content)
	}
}

func TestSynthAddedBinaryDiff(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "new.bin"), []byte{0, 1, 2}, 0o644); err != nil {
		t.Fatal(err)
	}
	diff, err := synthAddedDiff(root, "new.bin")
	if err != nil {
		t.Fatalf("synthAddedDiff: %v", err)
	}
	if !diff.Binary || diff.Content != "" || diff.Additions != 0 {
		t.Fatalf("unexpected binary diff: %+v", diff)
	}
}

func TestParseLogXML(t *testing.T) {
	data := []byte(`<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="9"><msg>late</msg></logentry>
<logentry revision="8"><msg>early</msg></logentry>
</log>
`)
	revisions, err := parseLogXML(data)
	if err != nil {
		t.Fatalf("parseLogXML: %v", err)
	}
	if len(revisions) != 2 || revisions[0] != "9" || revisions[1] != "8" {
		t.Fatalf("unexpected revisions: %v", revisions)
	}
}

func TestValidStatusPath(t *testing.T) {
	for _, path := range []string{"a.txt", "src/a.ts", "dir with space/file.txt"} {
		if !validStatusPath(path) {
			t.Fatalf("expected %q to be valid", path)
		}
	}
	for _, path := range []string{"", ".", "..", "../a", "a/../b", ".mindfs/x", "src/.svn/x", "src/.git/config"} {
		if validStatusPath(path) {
			t.Fatalf("expected %q to be invalid", path)
		}
	}
}

func TestNormalizeSVNDiffKeepsHeaderLikeHunkContent(t *testing.T) {
	section := diffSection{
		path: "note.lua",
		lines: strings.Split(`Index: note.lua
--- note.lua	(revision 1)
+++ note.lua	(working copy)
@@ -1,4 +1,4 @@
--- removed comment
+++ added comment
 __________
 unchanged`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if got.additions != 1 || got.deletions != 1 {
		t.Fatalf("stats = +%d/-%d, want +1/-1", got.additions, got.deletions)
	}
	if got.propertyOnly || got.binary {
		t.Fatalf("flags = propertyOnly:%v binary:%v", got.propertyOnly, got.binary)
	}
	for _, want := range []string{"--- removed comment", "+++ added comment", " __________", " unchanged"} {
		if !strings.Contains(got.content, want) {
			t.Fatalf("content missing %q:\n%s", want, got.content)
		}
	}
}

func TestNormalizeSVNDiffBinaryWithPropertiesIsBinary(t *testing.T) {
	section := diffSection{
		path: "image.png",
		lines: strings.Split(`Cannot display: file marked as a binary type.
svn:mime-type = application/octet-stream
Property changes on: image.png
___________________________________________________________________
Added: svn:executable
## -0,0 +1 ##
+*`, "\n"),
	}
	got := normalizeSVNDiffSection(section)
	if !got.binary || got.propertyOnly || !got.propertyChanges {
		t.Fatalf("flags = binary:%v propertyOnly:%v propertyChanges:%v", got.binary, got.propertyOnly, got.propertyChanges)
	}
	if got.content != "" || got.additions != 0 || got.deletions != 0 {
		t.Fatalf("unexpected stats/content: %+v", got)
	}
}

func TestNormalizeSVNDiffOutputDoesNotReturnChildSection(t *testing.T) {
	text := `Index: dir/a.txt
--- dir/a.txt	(revision 1)
+++ dir/a.txt	(working copy)
@@ -1 +1 @@
-a
+b
Index: dir/b.txt
--- dir/b.txt	(revision 1)
+++ dir/b.txt	(working copy)
@@ -1 +1 @@
-c
+d
`
	got := normalizeSVNDiffOutput(text, "dir")
	if got.content != "" || got.additions != 0 || got.deletions != 0 {
		t.Fatalf("directory diff should not fall back to the first child: %+v", got)
	}
}

func TestSVNPathArgEscapesPegRevisions(t *testing.T) {
	if got := svnPathArg("icon@2x.png"); got != "icon@2x.png@" {
		t.Fatalf("svnPathArg = %q", got)
	}
	if got := svnPathArg("plain.txt"); got != "plain.txt" {
		t.Fatalf("svnPathArg = %q", got)
	}
}

func TestCleanRelativePathRejectsDriveRelativePath(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("drive-relative paths are Windows-specific")
	}
	if _, err := cleanRelativePath("C:outside"); err == nil {
		t.Fatal("drive-relative path should be rejected")
	}
}

func TestStatusItemFromEntryRootProperties(t *testing.T) {
	entry := svnStatusEntry{Path: ".", Kind: "dir", Item: "normal", Props: "modified"}
	item, ok := statusItemFromEntry(`C:\work`, entry)
	if !ok {
		t.Fatal("root property entry was dropped")
	}
	if item.Path != "." || !item.IsDir || item.Status != "M" || item.Props != "modified" {
		t.Fatalf("unexpected root item: %+v", item)
	}
}

func TestStatusItemFromEntryMovedFrom(t *testing.T) {
	entry := svnStatusEntry{Path: "new.txt", Kind: "file", Item: "added", MovedFrom: "old.txt"}
	item, ok := statusItemFromEntry(`C:\work`, entry)
	if !ok {
		t.Fatal("moved entry was dropped")
	}
	if item.Status != "R" || item.OldPath != "old.txt" {
		t.Fatalf("unexpected moved item: %+v", item)
	}
}
