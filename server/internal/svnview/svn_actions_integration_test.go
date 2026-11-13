package svnview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIntegrationCommitMultilineAndUpdate(t *testing.T) {
	requireSVNTools(t)
	repo, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nCOMMITTED\nthree\n")
	result, err := Commit(ctx, wc, "subject line\n\nbody line")
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if strings.TrimSpace(result.Output) == "" {
		t.Fatal("commit output is empty")
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after commit is not clean: %+v", result.Status.Items)
	}
	logOutput := runTestSVN(t, wc, "log", "-l", "1", "-r", "HEAD")
	if !strings.Contains(logOutput, "subject line") || !strings.Contains(logOutput, "body line") {
		t.Fatalf("multiline commit message was not preserved:\n%s", logOutput)
	}

	wc2 := filepath.Join(filepath.Dir(wc), "wc2")
	runTestSVN(t, "", "checkout", fileURL(repo), wc2)
	writeFile(t, filepath.Join(wc2, "tracked.txt"), "one\nFROM REMOTE\nthree\n")
	runTestSVN(t, wc2, "commit", "-m", "remote update")

	updated, err := Update(ctx, wc)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(updated.Status.Items) != 0 {
		t.Fatalf("status after update is not clean: %+v", updated.Status.Items)
	}
	content, err := os.ReadFile(filepath.Join(wc, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "FROM REMOTE") {
		t.Fatalf("update did not apply remote content:\n%s", content)
	}
}

func TestIntegrationCommitSelectedPaths(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nSELECTED\nthree\n")
	writeFile(t, filepath.Join(wc, "src", "a.txt"), "a\nUNSELECTED\n")
	result, err := CommitPaths(ctx, wc, "commit selected file", []string{"tracked.txt"})
	if err != nil {
		t.Fatalf("CommitPaths: %v", err)
	}
	if len(result.Status.Items) != 1 || result.Status.Items[0].Path != "src/a.txt" {
		t.Fatalf("unexpected remaining status: %+v", result.Status.Items)
	}
	logOutput := runTestSVN(t, wc, "log", "-v", "-l", "1", "-r", "HEAD")
	if !strings.Contains(logOutput, "tracked.txt") {
		t.Fatalf("selected file was not committed:\n%s", logOutput)
	}
	if strings.Contains(logOutput, "src/a.txt") {
		t.Fatalf("unselected file was committed:\n%s", logOutput)
	}
	content, err := os.ReadFile(filepath.Join(wc, "src", "a.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "UNSELECTED") {
		t.Fatalf("unselected file was unexpectedly reverted:\n%s", content)
	}
}

func TestIntegrationCommitSelectedPathsAddsUnversioned(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nLOCAL\nthree\n")
	writeFile(t, filepath.Join(wc, "notes.txt"), "new file\n")
	writeFile(t, filepath.Join(wc, "other.txt"), "leave unversioned\n")

	result, err := CommitPaths(ctx, wc, "commit new file", []string{"notes.txt"})
	if err != nil {
		t.Fatalf("CommitPaths: %v", err)
	}
	remaining := map[string]StatusItem{}
	for _, item := range result.Status.Items {
		remaining[item.Path] = item
	}
	if len(remaining) != 2 {
		t.Fatalf("unexpected remaining status: %+v", result.Status.Items)
	}
	if item := remaining["tracked.txt"]; item.Status != "M" {
		t.Fatalf("unselected modified file = %+v", item)
	}
	if item := remaining["other.txt"]; item.Status != "??" {
		t.Fatalf("unselected unversioned file = %+v", item)
	}
	if _, ok := remaining["notes.txt"]; ok {
		t.Fatalf("newly added file is still dirty: %+v", result.Status.Items)
	}

	logOutput := runTestSVN(t, wc, "log", "-v", "-l", "1", "-r", "HEAD")
	if !strings.Contains(logOutput, "notes.txt") {
		t.Fatalf("unversioned selected file was not added and committed:\n%s", logOutput)
	}
	if strings.Contains(logOutput, "tracked.txt") || strings.Contains(logOutput, "other.txt") {
		t.Fatalf("unselected file was committed:\n%s", logOutput)
	}
	if content, err := os.ReadFile(filepath.Join(wc, "other.txt")); err != nil || string(content) != "leave unversioned\n" {
		t.Fatalf("unselected unversioned file changed: content=%q err=%v", content, err)
	}
}

func TestIntegrationRevert(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nLOCAL\nthree\n")
	result, err := Revert(ctx, wc, "tracked.txt")
	if err != nil {
		t.Fatalf("Revert: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after revert is not clean: %+v", result.Status.Items)
	}
	content, err := os.ReadFile(filepath.Join(wc, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "LOCAL") || !strings.Contains(string(content), "two") {
		t.Fatalf("revert did not restore the base content:\n%s", content)
	}
}

func TestIntegrationRevertRejectsUnversioned(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "untracked.txt"), "keep me\n")
	if _, err := Revert(ctx, wc, "untracked.txt"); err == nil {
		t.Fatal("Revert succeeded for an unversioned file")
	}
	content, err := os.ReadFile(filepath.Join(wc, "untracked.txt"))
	if err != nil {
		t.Fatalf("unversioned file was removed: %v", err)
	}
	if string(content) != "keep me\n" {
		t.Fatalf("unversioned file changed: %q", content)
	}
}

func TestIntegrationRevertClearsConflict(t *testing.T) {
	requireSVNTools(t)
	repo, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	wc2 := filepath.Join(filepath.Dir(wc), "wc2")
	runTestSVN(t, "", "checkout", fileURL(repo), wc2)
	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nLOCAL\nthree\n")
	writeFile(t, filepath.Join(wc2, "tracked.txt"), "one\nREMOTE\nthree\n")
	runTestSVN(t, wc2, "commit", "-m", "remote conflict")
	if _, err := Update(ctx, wc); err != nil {
		t.Fatalf("Update: %v", err)
	}

	reverted, err := Revert(ctx, wc, "tracked.txt")
	if err != nil {
		t.Fatalf("Revert conflicted file: %v", err)
	}
	for _, item := range reverted.Status.Items {
		if item.Status == "C" || item.Conflicted {
			t.Fatalf("conflict was not cleared: %+v", reverted.Status.Items)
		}
	}
	content, err := os.ReadFile(filepath.Join(wc, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("conflict markers remain after revert:\n%s", content)
	}
}

func TestIntegrationUpdatePostponesConflicts(t *testing.T) {
	requireSVNTools(t)
	repo, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	wc2 := filepath.Join(filepath.Dir(wc), "wc2")
	runTestSVN(t, "", "checkout", fileURL(repo), wc2)
	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nLOCAL CHANGE\nthree\n")
	writeFile(t, filepath.Join(wc2, "tracked.txt"), "one\nREMOTE CHANGE\nthree\n")
	runTestSVN(t, wc2, "commit", "-m", "remote conflict")

	result, err := Update(ctx, wc)
	if err != nil {
		t.Fatalf("Update with conflicts: %v", err)
	}
	conflicted := false
	for _, item := range result.Status.Items {
		if item.Status == "C" || item.Conflicted {
			conflicted = true
			break
		}
	}
	if !conflicted {
		t.Fatalf("expected a conflicted status item, got: %+v\noutput:\n%s", result.Status.Items, result.Output)
	}
	content, err := os.ReadFile(filepath.Join(wc, "tracked.txt"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(content)
	if !strings.Contains(text, "<<<<<<<") || !strings.Contains(text, ">>>>>>>") {
		t.Fatalf("conflict markers were not left in the working file:\n%s", text)
	}
}

func TestIntegrationCommitMissingFile(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	if err := os.Remove(filepath.Join(wc, "tracked.txt")); err != nil {
		t.Fatal(err)
	}
	result, err := CommitPaths(ctx, wc, "delete missing file", []string{"tracked.txt"})
	if err != nil {
		t.Fatalf("CommitPaths missing file: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after committing a missing file is not clean: %+v", result.Status.Items)
	}
	logOutput := runTestSVN(t, wc, "log", "-v", "-l", "1", "-r", "HEAD")
	if !strings.Contains(logOutput, "tracked.txt") {
		t.Fatalf("missing file deletion was not committed:\n%s", logOutput)
	}
}

func TestIntegrationCommitUnversionedDirectory(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "newdir", "nested", "file.txt"), "nested\n")
	writeFile(t, filepath.Join(wc, "newdir", "top.txt"), "top\n")
	result, err := CommitPaths(ctx, wc, "add directory", []string{"newdir"})
	if err != nil {
		t.Fatalf("CommitPaths unversioned directory: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after committing an unversioned directory is not clean: %+v", result.Status.Items)
	}
	logOutput := runTestSVN(t, wc, "log", "-v", "-l", "1", "-r", "HEAD")
	for _, want := range []string{"newdir", "top.txt", "nested"} {
		if !strings.Contains(logOutput, want) {
			t.Fatalf("directory commit missing %q:\n%s", want, logOutput)
		}
	}
}

func TestIntegrationRootPropertyChange(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	runTestSVN(t, wc, "propset", "-q", "svn:ignore", "*.log", ".")
	status, err := InspectStatus(ctx, wc)
	if err != nil {
		t.Fatalf("InspectStatus root property: %v", err)
	}
	found := false
	for _, item := range status.Items {
		if item.Path == "." && item.Status == "M" && item.IsDir {
			found = true
		}
	}
	if !found {
		t.Fatalf("root property change missing from status: %+v", status.Items)
	}
	diff, err := ReadDiff(ctx, wc, ".")
	if err != nil {
		t.Fatalf("ReadDiff root property: %v", err)
	}
	if !diff.PropertyOnly {
		t.Fatalf("root property diff should be property-only: %+v", diff)
	}
	result, err := CommitPaths(ctx, wc, "root props", []string{"."})
	if err != nil {
		t.Fatalf("CommitPaths root property: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after root property commit is not clean: %+v", result.Status.Items)
	}
}

func TestIntegrationResolveConflict(t *testing.T) {
	requireSVNTools(t)
	repo, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	wc2 := filepath.Join(filepath.Dir(wc), "wc2")
	runTestSVN(t, "", "checkout", fileURL(repo), wc2)
	writeFile(t, filepath.Join(wc, "tracked.txt"), "one\nLOCAL\nthree\n")
	writeFile(t, filepath.Join(wc2, "tracked.txt"), "one\nREMOTE\nthree\n")
	runTestSVN(t, wc2, "commit", "-m", "remote conflict")
	if _, err := Update(ctx, wc); err != nil {
		t.Fatalf("Update: %v", err)
	}
	result, err := Resolve(ctx, wc, "tracked.txt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	for _, item := range result.Status.Items {
		if item.Status == "C" || item.Conflicted {
			t.Fatalf("conflict was not resolved: %+v", result.Status.Items)
		}
	}
	committed, err := CommitPaths(ctx, wc, "resolve conflict", []string{"tracked.txt"})
	if err != nil {
		t.Fatalf("CommitPaths after resolve: %v", err)
	}
	if len(committed.Status.Items) != 0 {
		t.Fatalf("status after resolved commit is not clean: %+v", committed.Status.Items)
	}
}

func TestIntegrationAtSignFilename(t *testing.T) {
	requireSVNTools(t)
	_, wc := makeSVNWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "icon@2x.png"), "base\n")
	runTestSVN(t, wc, "add", "icon@2x.png@")
	runTestSVN(t, wc, "commit", "-q", "-m", "add at sign")
	writeFile(t, filepath.Join(wc, "icon@2x.png"), "changed\n")

	status, err := InspectStatus(ctx, wc)
	if err != nil {
		t.Fatalf("InspectStatus: %v", err)
	}
	if len(status.Items) != 1 || status.Items[0].Path != "icon@2x.png" || status.Items[0].Status != "M" {
		t.Fatalf("unexpected status for @ path: %+v", status.Items)
	}
	diff, err := ReadDiff(ctx, wc, "icon@2x.png")
	if err != nil {
		t.Fatalf("ReadDiff @ path: %v", err)
	}
	if !strings.Contains(diff.Content, "+changed") {
		t.Fatalf("unexpected @ diff:\n%s", diff.Content)
	}
	result, err := CommitPaths(ctx, wc, "update at sign", []string{"icon@2x.png"})
	if err != nil {
		t.Fatalf("CommitPaths @ path: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after @ commit is not clean: %+v", result.Status.Items)
	}
}
