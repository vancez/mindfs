package svnview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeSVNExternalWorkingCopy(t *testing.T) (string, string) {
	t.Helper()
	base := t.TempDir()
	mainRepo := filepath.Join(base, "mainrepo")
	externalRepo := filepath.Join(base, "extrepo")
	wc := filepath.Join(base, "wc")
	externalWC := filepath.Join(base, "ext-wc")

	runTestSVNAdmin(t, "create", mainRepo)
	runTestSVNAdmin(t, "create", externalRepo)
	runTestSVN(t, "", "checkout", "-q", fileURL(mainRepo), wc)
	runTestSVN(t, "", "checkout", "-q", fileURL(externalRepo), externalWC)

	writeFile(t, filepath.Join(externalWC, "ext.txt"), "external base\n")
	runTestSVN(t, externalWC, "add", "ext.txt")
	runTestSVN(t, externalWC, "commit", "-q", "-m", "ext r1")
	writeFile(t, filepath.Join(externalWC, "other.txt"), "other\n")
	runTestSVN(t, externalWC, "add", "other.txt")
	runTestSVN(t, externalWC, "commit", "-q", "-m", "ext r2")
	writeFile(t, filepath.Join(externalWC, "other.txt"), "other v2\n")
	runTestSVN(t, externalWC, "commit", "-q", "-m", "ext r3")

	writeFile(t, filepath.Join(wc, "main.txt"), "main base\n")
	runTestSVN(t, wc, "add", "main.txt")
	runTestSVN(t, wc, "commit", "-q", "-m", "main r1")
	// The working-copy root is still at r0 after committing a child file;
	// bring it to HEAD before committing a property on the root.
	runTestSVN(t, wc, "update", "-q")
	runTestSVN(t, wc, "propset", "-q", "svn:externals", fileURL(externalRepo)+" ext", ".")
	runTestSVN(t, wc, "commit", "-q", "-m", "main r2 external")
	runTestSVN(t, wc, "update", "-q")

	return wc, externalWC
}

func TestIntegrationExternals(t *testing.T) {
	requireSVNTools(t)
	wc, externalWC := makeSVNExternalWorkingCopy(t)
	ctx := context.Background()

	// Update must traverse externals.
	runTestSVN(t, externalWC, "update", "-q")
	writeFile(t, filepath.Join(externalWC, "other.txt"), "other remote\n")
	runTestSVN(t, externalWC, "commit", "-q", "-m", "ext r4")
	updated, err := Update(ctx, wc)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if len(updated.Status.Items) != 0 {
		t.Fatalf("status after external update is not clean: %+v", updated.Status.Items)
	}
	content, err := os.ReadFile(filepath.Join(wc, "ext", "other.txt"))
	if err != nil {
		t.Fatalf("read updated external file: %v", err)
	}
	if string(content) != "other remote\n" {
		t.Fatalf("external update content = %q", content)
	}

	// An unversioned file inside an external should record the external
	// working-copy revision, not the managed root revision.
	loosePath := filepath.Join(wc, "ext", "loose.txt")
	writeFile(t, loosePath, "loose\n")
	looseRevision, ok := FileRevision(ctx, wc, loosePath)
	if !ok || looseRevision != "4" {
		t.Fatalf("external loose revision = %q, %v; want 4", looseRevision, ok)
	}
	if err := os.Remove(loosePath); err != nil {
		t.Fatal(err)
	}

	writeFile(t, filepath.Join(wc, "ext", "ext.txt"), "external base\nexternal local\n")
	writeFile(t, filepath.Join(wc, "ext", "new.txt"), "new external\n")

	status, err := InspectStatus(ctx, wc)
	if err != nil {
		t.Fatalf("InspectStatus: %v", err)
	}
	byPath := map[string]StatusItem{}
	for _, item := range status.Items {
		byPath[item.Path] = item
	}
	if len(byPath) != 2 {
		t.Fatalf("unexpected external status: %+v", status.Items)
	}
	if item := byPath["ext/ext.txt"]; item.Status != "M" || item.Additions != 1 || item.Deletions != 0 {
		t.Fatalf("external modified item = %+v", item)
	}
	if item := byPath["ext/new.txt"]; item.Status != "??" || item.Additions != 1 {
		t.Fatalf("external unversioned item = %+v", item)
	}
	if _, ok := byPath["ext"]; ok {
		t.Fatalf("external mount should not be a change item: %+v", status.Items)
	}

	diff, err := ReadDiff(ctx, wc, "ext/ext.txt")
	if err != nil {
		t.Fatalf("ReadDiff external file: %v", err)
	}
	if diff.Status != "M" || diff.Additions != 1 || !strings.Contains(diff.Content, "+external local") {
		t.Fatalf("unexpected external diff: %+v\n%s", diff, diff.Content)
	}
	untrackedDiff, err := ReadDiff(ctx, wc, "ext/new.txt")
	if err != nil {
		t.Fatalf("ReadDiff external unversioned file: %v", err)
	}
	if untrackedDiff.Status != "??" || !strings.Contains(untrackedDiff.Content, "+new external") {
		t.Fatalf("unexpected external unversioned diff: %+v\n%s", untrackedDiff, untrackedDiff.Content)
	}

	baseRevision, ok := FileRevision(ctx, wc, filepath.Join(wc, "ext", "ext.txt"))
	if !ok || baseRevision != "4" {
		t.Fatalf("external file revision = %q, %v; want 4", baseRevision, ok)
	}

	committed, err := CommitPaths(ctx, wc, "external commit", []string{"ext/ext.txt", "ext/new.txt"})
	if err != nil {
		t.Fatalf("CommitPaths external files: %v", err)
	}
	if len(committed.Status.Items) != 0 {
		t.Fatalf("status after external commit is not clean: %+v", committed.Status.Items)
	}
	externalLog := runTestSVN(t, externalWC, "log", "-v", "-l", "1", "-r", "HEAD")
	for _, want := range []string{"external commit", "ext.txt", "new.txt"} {
		if !strings.Contains(externalLog, want) {
			t.Fatalf("external log missing %q:\n%s", want, externalLog)
		}
	}

	related, err := ReadRelatedFileDiff(ctx, wc, baseRevision, "ext/ext.txt")
	if err != nil {
		t.Fatalf("ReadRelatedFileDiff external file: %v", err)
	}
	if related.Source != "commit_range" || related.BaseRevision != "4" || related.TargetRevision != "5" {
		t.Fatalf("unexpected external related diff: source=%q base=%q target=%q", related.Source, related.BaseRevision, related.TargetRevision)
	}
	if related.Additions != 1 || !strings.Contains(related.Content, "+external local") {
		t.Fatalf("unexpected external related content: +%d\n%s", related.Additions, related.Content)
	}

	writeFile(t, filepath.Join(wc, "ext", "ext.txt"), "external base\nrevert me\n")
	reverted, err := Revert(ctx, wc, "ext/ext.txt")
	if err != nil {
		t.Fatalf("Revert external file: %v", err)
	}
	if len(reverted.Status.Items) != 0 {
		t.Fatalf("status after external revert is not clean: %+v", reverted.Status.Items)
	}
	content, err = os.ReadFile(filepath.Join(wc, "ext", "ext.txt"))
	if err != nil {
		t.Fatalf("read reverted external file: %v", err)
	}
	if strings.Contains(string(content), "revert me") || !strings.Contains(string(content), "external local") {
		t.Fatalf("unexpected reverted external content:\n%s", content)
	}
}

func TestIntegrationCommitSpansMainAndExternalRepository(t *testing.T) {
	requireSVNTools(t)
	wc, externalWC := makeSVNExternalWorkingCopy(t)
	ctx := context.Background()

	writeFile(t, filepath.Join(wc, "main.txt"), "main v2\n")
	writeFile(t, filepath.Join(wc, "ext", "ext.txt"), "external v2\n")
	result, err := CommitPaths(ctx, wc, "mixed repositories", []string{"main.txt", "ext/ext.txt"})
	if err != nil {
		t.Fatalf("CommitPaths across repositories: %v", err)
	}
	if len(result.Status.Items) != 0 {
		t.Fatalf("status after cross-repository commit is not clean: %+v", result.Status.Items)
	}
	for _, repoCheck := range []struct {
		name string
		dir  string
	}{{"main", wc}, {"external", externalWC}} {
		logOutput := runTestSVN(t, repoCheck.dir, "log", "-l", "1", "-r", "HEAD")
		if !strings.Contains(logOutput, "mixed repositories") {
			t.Fatalf("%s repository did not receive the commit:\n%s", repoCheck.name, logOutput)
		}
	}
}
