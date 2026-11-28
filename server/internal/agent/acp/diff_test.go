package acp

import (
	"fmt"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestConvertToolCallContentCompactsWholeFileACPDiff(t *testing.T) {
	oldLines := make([]string, 0, 100)
	newLines := make([]string, 0, 100)
	for i := 1; i <= 100; i++ {
		line := fmt.Sprintf("line %03d", i)
		oldLines = append(oldLines, line)
		if i == 50 {
			newLines = append(newLines, "line 050 updated")
		} else {
			newLines = append(newLines, line)
		}
	}
	oldText := strings.Join(oldLines, "\n") + "\n"
	newText := strings.Join(newLines, "\n") + "\n"

	got := convertToolCallContent([]acpsdk.ToolCallContent{
		acpsdk.ToolDiffContent("D:/repo/app.py", newText, oldText),
	})
	if len(got) != 1 {
		t.Fatalf("len(got) = %d, want 1", len(got))
	}
	item := got[0]
	if item.Type != "text" || item.ChangeKind != "update" || item.Path != "D:/repo/app.py" {
		t.Fatalf("item metadata = %#v", item)
	}
	if item.OldText != nil || item.NewText != "" {
		t.Fatalf("expected OldText/NewText to be omitted after compaction, got %#v", item)
	}

	want := strings.Join([]string{
		"--- a/D:/repo/app.py",
		"+++ b/D:/repo/app.py",
		"@@ -47,7 +47,7 @@",
		" line 047",
		" line 048",
		" line 049",
		"-line 050",
		"+line 050 updated",
		" line 051",
		" line 052",
		" line 053",
	}, "\n")
	if item.Text != want {
		t.Fatalf("unified diff mismatch:\ngot:\n%s\n\nwant:\n%s", item.Text, want)
	}
}

func TestConvertToolCallContentSplitsDistantHunks(t *testing.T) {
	oldLines := make([]string, 0, 30)
	newLines := make([]string, 0, 31)
	for i := 1; i <= 30; i++ {
		line := fmt.Sprintf("L%02d", i)
		oldLines = append(oldLines, line)
		switch i {
		case 3:
			newLines = append(newLines, "L03-mod")
		case 25:
			newLines = append(newLines, line, "L25-inserted")
		default:
			newLines = append(newLines, line)
		}
	}
	oldText := strings.Join(oldLines, "\n") + "\n"
	newText := strings.Join(newLines, "\n") + "\n"

	got := convertToolCallContent([]acpsdk.ToolCallContent{
		acpsdk.ToolDiffContent("src/main.go", newText, oldText),
	})
	if len(got) != 1 {
		t.Fatalf("len(got) = %d, want 1", len(got))
	}

	want := strings.Join([]string{
		"--- a/src/main.go",
		"+++ b/src/main.go",
		"@@ -1,6 +1,6 @@",
		" L01",
		" L02",
		"-L03",
		"+L03-mod",
		" L04",
		" L05",
		" L06",
		"@@ -23,6 +23,7 @@",
		" L23",
		" L24",
		" L25",
		"+L25-inserted",
		" L26",
		" L27",
		" L28",
	}, "\n")
	if got[0].Text != want {
		t.Fatalf("multi-hunk diff mismatch:\ngot:\n%s\n\nwant:\n%s", got[0].Text, want)
	}
}

func TestConvertToolCallContentPreservesCreateAndDeleteDiffs(t *testing.T) {
	created := convertToolCallContent([]acpsdk.ToolCallContent{
		acpsdk.ToolDiffContent("new.txt", "hello\nworld\n"),
	})
	if len(created) != 1 || created[0].Type != "diff" || created[0].OldText != nil || created[0].NewText != "hello\nworld\n" {
		t.Fatalf("created diff = %#v", created)
	}

	deleted := convertToolCallContent([]acpsdk.ToolCallContent{
		acpsdk.ToolDiffContent("old.txt", "", "bye\n"),
	})
	if len(deleted) != 1 || deleted[0].Type != "diff" || deleted[0].OldText == nil || *deleted[0].OldText != "bye\n" || deleted[0].NewText != "" {
		t.Fatalf("deleted diff = %#v", deleted)
	}
}

func TestBuildUnifiedDiffHandlesWindowsCRLFAndTrailingNewline(t *testing.T) {
	crlfDiff := buildUnifiedDiff("win.go", "a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n", 3)
	if strings.Contains(crlfDiff, "\r") {
		t.Fatalf("expected LF-normalized diff, got %q", crlfDiff)
	}
	wantCRLF := "--- a/win.go\n+++ b/win.go\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"
	if crlfDiff != wantCRLF {
		t.Fatalf("crlfDiff =\n%s\nwant:\n%s", crlfDiff, wantCRLF)
	}

	nlDiff := buildUnifiedDiff("eof.txt", "a\nb", "a\nb\n", 3)
	wantNL := "--- a/eof.txt\n+++ b/eof.txt\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b"
	if nlDiff != wantNL {
		t.Fatalf("nlDiff =\n%s\nwant:\n%s", nlDiff, wantNL)
	}

	sameDiff := buildUnifiedDiff("same.txt", "a\nb\n", "a\nb\n", 3)
	if sameDiff != "--- a/same.txt\n+++ b/same.txt" {
		t.Fatalf("sameDiff = %q", sameDiff)
	}

	noPathDiff := buildUnifiedDiff("", "a\nb\n", "a\nc\n", 3)
	wantNoPath := "@@ -1,2 +1,2 @@\n a\n-b\n+c"
	if noPathDiff != wantNoPath {
		t.Fatalf("noPathDiff =\n%s\nwant:\n%s", noPathDiff, wantNoPath)
	}
}

func TestBuildUnifiedDiffFallbackOnMassiveRewrite(t *testing.T) {
	n := maxMyersEditDistance + 100
	oldLines := make([]string, n+4)
	newLines := make([]string, n+4)
	oldLines[0], newLines[0] = "head-1", "head-1"
	oldLines[1], newLines[1] = "head-2", "head-2"
	for i := 0; i < n; i++ {
		oldLines[i+2] = fmt.Sprintf("old-%d", i)
		newLines[i+2] = fmt.Sprintf("new-%d", i)
	}
	oldLines[n+2], newLines[n+2] = "tail-1", "tail-1"
	oldLines[n+3], newLines[n+3] = "tail-2", "tail-2"

	got := buildUnifiedDiff("big.txt", strings.Join(oldLines, "\n")+"\n", strings.Join(newLines, "\n")+"\n", 2)
	if !strings.HasPrefix(got, "--- a/big.txt\n+++ b/big.txt\n@@ -1,") {
		t.Fatalf("unexpected header:\n%s", got[:minInt(len(got), 120)])
	}
	if !strings.Contains(got, "\n head-1\n head-2\n-old-0\n") {
		t.Fatalf("missing leading context")
	}
	if !strings.Contains(got, "\n tail-1\n tail-2") {
		t.Fatalf("missing trailing context")
	}
}
