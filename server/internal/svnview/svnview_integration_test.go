package svnview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func requireSVNTools(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("svn"); err != nil {
		t.Skip("svn not found in PATH")
	}
	if _, err := exec.LookPath("svnadmin"); err != nil {
		t.Skip("svnadmin not found in PATH")
	}
}

func fileURL(path string) string {
	slashed := filepath.ToSlash(path)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return "file://" + slashed
}

func runTestSVN(t *testing.T, dir string, args ...string) string {
	t.Helper()
	fullArgs := append([]string{"--non-interactive"}, args...)
	cmd := exec.Command("svn", fullArgs...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("svn %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func runTestSVNAdmin(t *testing.T, args ...string) string {
	t.Helper()
	cmd := exec.Command("svnadmin", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("svnadmin %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func makeSVNWorkingCopy(t *testing.T) (string, string) {
	t.Helper()
	base := t.TempDir()
	repo := filepath.Join(base, "repo")
	wc := filepath.Join(base, "wc")
	runTestSVNAdmin(t, "create", repo)
	runTestSVN(t, "", "checkout", fileURL(repo), wc)

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\ntwo\nthree\n")
	writeFile(t, filepath.Join(wc, "src", "a.txt"), "a\nb\n")
	runTestSVN(t, wc, "add", "tracked.txt", "src")
	runTestSVN(t, wc, "commit", "-m", "r1")
	return repo, wc
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationDetectAndStatus(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	info, ok := DetectWorkingCopy(ctx, wc)
	if !ok {
		t.Fatalf("DetectWorkingCopy(%q) = false", wc)
	}
	if filepath.Clean(info.WCRoot) != filepath.Clean(wc) {
		t.Fatalf("WCRoot = %q, want %q", info.WCRoot, wc)
	}

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nTWO\nthree\n")
	writeFile(t, filepath.Join(wc, "untracked.txt"), "new\n")
	writeFile(t, filepath.Join(wc, "src", "a.txt"), "a\nb\nc\n")
	writeFile(t, filepath.Join(wc, ".mindfs", "hidden.txt"), "ignore me\n")

	status, err := InspectStatus(ctx, wc)
	if err != nil {
		t.Fatalf("InspectStatus: %v", err)
	}
	if !status.Available || status.DirtyCount != 3 {
		t.Fatalf("unexpected status: %+v", status)
	}
	byPath := map[string]StatusItem{}
	for _, item := range status.Items {
		byPath[item.Path] = item
	}
	if item := byPath["tracked.txt"]; item.Status != "M" || item.Additions != 1 || item.Deletions != 1 {
		t.Fatalf("tracked item = %+v", item)
	}
	if item := byPath["untracked.txt"]; item.Status != "??" || item.Additions != 1 {
		t.Fatalf("untracked item = %+v", item)
	}
	if item := byPath["src/a.txt"]; item.Status != "M" || item.Additions != 1 {
		t.Fatalf("src item = %+v", item)
	}
	if _, ok := byPath[".mindfs/hidden.txt"]; ok {
		t.Fatalf(".mindfs file should be filtered: %+v", status.Items)
	}
}

func TestIntegrationReadDiff(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nTWO\nthree\n")
	diff, err := ReadDiff(ctx, wc, "tracked.txt")
	if err != nil {
		t.Fatalf("ReadDiff: %v", err)
	}
	if diff.Status != "M" || diff.Additions != 1 || diff.Deletions != 1 {
		t.Fatalf("unexpected diff: %+v", diff)
	}
	if strings.Contains(diff.Content, "Index:") || !strings.Contains(diff.Content, "-two\n+TWO") {
		t.Fatalf("unexpected content:\n%s", diff.Content)
	}

	writeFile(t, filepath.Join(wc, "untracked.txt"), "a\nb\n")
	untracked, err := ReadDiff(ctx, wc, "untracked.txt")
	if err != nil {
		t.Fatalf("ReadDiff untracked: %v", err)
	}
	if untracked.Status != "??" || untracked.Additions != 2 || !strings.Contains(untracked.Content, "@@ -0,0 +1,2 @@") {
		t.Fatalf("unexpected untracked diff: %+v", untracked)
	}
}

func TestIntegrationRelatedFileDiffUsesFirstRevisionAfterBase(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nTWO\nthree\n")
	runTestSVN(t, wc, "commit", "-m", "r2")
	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nTWO THREE\nthree\n")
	runTestSVN(t, wc, "commit", "-m", "r3")

	diff, err := ReadRelatedFileDiff(ctx, wc, "1", "tracked.txt")
	if err != nil {
		t.Fatalf("ReadRelatedFileDiff: %v", err)
	}
	if diff.Source != "commit_range" || diff.TargetRevision != "2" || diff.BaseRevision != "1" {
		t.Fatalf("unexpected related diff: source=%q base=%q target=%q", diff.Source, diff.BaseRevision, diff.TargetRevision)
	}
	if diff.Additions != 1 || diff.Deletions != 1 {
		t.Fatalf("related stats = +%d/-%d", diff.Additions, diff.Deletions)
	}
	if !strings.Contains(diff.Content, "+TWO") {
		t.Fatalf("unexpected related content:\n%s", diff.Content)
	}
}

func gbkEncoded(t *testing.T, text string) []byte {
	t.Helper()
	encoded, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(text))
	if err != nil {
		t.Fatalf("encode GBK: %v", err)
	}
	return encoded
}

func TestIntegrationChineseEncodingAndPaths(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	files := map[string][]byte{
		"utf8.txt":  []byte("旧内容\n"),
		"gbk.txt":   gbkEncoded(t, "旧内容\n"),
		"gbk.dat":   gbkEncoded(t, "旧内容\n"),
		"mixed.txt": gbkEncoded(t, "旧内容\n"),
		"中文.txt":    []byte("旧内容\n"),
		"中文GBK.txt": gbkEncoded(t, "旧内容\n"),
	}
	for name, content := range files {
		writeFileBytes(t, filepath.Join(wc, name), content)
	}
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	runTestSVN(t, wc, append([]string{"add"}, names...)...)
	runTestSVN(t, wc, append([]string{"propset", "-q", "svn:mime-type", "text/plain"}, names...)...)
	runTestSVN(t, wc, "commit", "-q", "-m", "chinese base")

	updated := map[string][]byte{
		"utf8.txt":  []byte("新内容\n"),
		"gbk.txt":   gbkEncoded(t, "新内容\n"),
		"gbk.dat":   gbkEncoded(t, "新内容\n"),
		"mixed.txt": []byte("新内容\n"),
		"中文.txt":    []byte("新内容\n"),
		"中文GBK.txt": gbkEncoded(t, "新内容\n"),
	}
	for name, content := range updated {
		writeFileBytes(t, filepath.Join(wc, name), content)
	}

	status, err := InspectStatus(ctx, wc)
	if err != nil {
		t.Fatalf("InspectStatus: %v", err)
	}
	byPath := map[string]StatusItem{}
	for _, item := range status.Items {
		byPath[item.Path] = item
	}
	for name := range files {
		item, ok := byPath[name]
		if !ok {
			t.Fatalf("missing status item for %q: %+v", name, status.Items)
		}
		if item.Status != "M" || item.Additions != 1 || item.Deletions != 1 {
			t.Fatalf("%q status = %+v, want M +1/-1", name, item)
		}
	}

	for name := range files {
		diff, err := ReadDiff(ctx, wc, name)
		if err != nil {
			t.Fatalf("ReadDiff(%q): %v", name, err)
		}
		if !strings.Contains(diff.Content, "新内容") {
			t.Fatalf("ReadDiff(%q) content is not valid UTF-8 Chinese:\n%s", name, diff.Content)
		}
		if !strings.Contains(diff.Content, "旧内容") {
			t.Fatalf("ReadDiff(%q) lost the old Chinese content:\n%s", name, diff.Content)
		}
	}

	writeFileBytes(t, filepath.Join(wc, "unversioned.lua"), []byte("local 玩家数据 = {}\n-- 工作流\n"))
	untracked, err := ReadDiff(ctx, wc, "unversioned.lua")
	if err != nil {
		t.Fatalf("ReadDiff unversioned.lua: %v", err)
	}
	if untracked.Status != "??" || !strings.Contains(untracked.Content, "玩家数据") || !strings.Contains(untracked.Content, "工作流") {
		t.Fatalf("unversioned UTF-8 diff is corrupted: %+v\n%s", untracked, untracked.Content)
	}
}

func writeFileBytes(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationRelatedFileDiffLocalAndUnversioned(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nTWO\nthree\n")
	revision, ok := FileRevision(ctx, wc, filepath.Join(wc, "tracked.txt"))
	if !ok || revision != "1" {
		t.Fatalf("FileRevision = %q, %v; want 1 true", revision, ok)
	}
	local, err := ReadRelatedFileDiff(ctx, wc, revision, "tracked.txt")
	if err != nil {
		t.Fatalf("ReadRelatedFileDiff local: %v", err)
	}
	if local.Source != "worktree" || local.Additions != 1 || local.Deletions != 1 {
		t.Fatalf("unexpected local related diff: %+v", local)
	}

	writeFile(t, filepath.Join(wc, "untracked.txt"), "x\ny\n")
	untrackedRevision, ok := FileRevision(ctx, wc, filepath.Join(wc, "untracked.txt"))
	if !ok {
		t.Fatal("FileRevision for unversioned file should use root revision")
	}
	untracked, err := ReadRelatedFileDiff(ctx, wc, untrackedRevision, "untracked.txt")
	if err != nil {
		t.Fatalf("ReadRelatedFileDiff untracked: %v", err)
	}
	if untracked.Source != "worktree" || untracked.Status != "??" || untracked.Additions != 2 {
		t.Fatalf("unexpected untracked related diff: %+v", untracked)
	}

	runTestSVN(t, wc, "add", "untracked.txt")
	runTestSVN(t, wc, "commit", "-q", "-m", "add untracked")
	committed, err := ReadRelatedFileDiff(ctx, wc, "0", "untracked.txt")
	if err != nil {
		t.Fatalf("ReadRelatedFileDiff after add/commit: %v", err)
	}
	if committed.Source != "commit_range" || committed.TargetRevision != "2" {
		t.Fatalf("unexpected committed related diff: source=%q target=%q", committed.Source, committed.TargetRevision)
	}
	if committed.Status != "A" || committed.Additions != 2 {
		t.Fatalf("unexpected committed stats: %+v", committed.DiffResult)
	}
}
