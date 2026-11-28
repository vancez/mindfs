package acp

import (
	"fmt"
	"strings"

	types "mindfs/server/internal/agent/types"

	acpsdk "github.com/coder/acp-go-sdk"
)

const (
	defaultUnifiedDiffContext = 3
	maxMyersEditDistance      = 1024
)

type diffOpKind uint8

const (
	opEqual diffOpKind = iota
	opDelete
	opInsert
)

type diffOp struct {
	kind   diffOpKind
	oldIdx int
	newIdx int
}

// convertDiffContent converts an ACP ToolCallContentDiff into a MindFS
// ToolCallContentItem. ACP v1 agents (such as agy) commonly send full before
// and after file contents in OldText/NewText; computing a unified diff here
// keeps persisted aux logs, WebSocket payloads, and expanded tool cards compact
// and focused on actual changes.
func convertDiffContent(diff *acpsdk.ToolCallContentDiff) types.ToolCallContentItem {
	if diff.OldText == nil || *diff.OldText == "" || diff.NewText == "" {
		return types.ToolCallContentItem{
			Type:    "diff",
			Path:    diff.Path,
			OldText: diff.OldText,
			NewText: diff.NewText,
		}
	}

	return types.ToolCallContentItem{
		Type:       "text",
		Text:       buildUnifiedDiff(diff.Path, *diff.OldText, diff.NewText, defaultUnifiedDiffContext),
		Path:       diff.Path,
		ChangeKind: "update",
	}
}

func buildUnifiedDiff(path, oldText, newText string, contextLines int) string {
	if contextLines < 0 {
		contextLines = 0
	}

	oldNorm := strings.ReplaceAll(oldText, "\r\n", "\n")
	newNorm := strings.ReplaceAll(newText, "\r\n", "\n")
	if oldNorm != newNorm || oldText == newText {
		oldText = oldNorm
		newText = newNorm
	}

	oldLines, oldTrailing := splitDiffLines(oldText)
	newLines, newTrailing := splitDiffLines(newText)

	var out []string
	if trimmedPath := strings.TrimSpace(path); trimmedPath != "" {
		out = append(out, "--- a/"+trimmedPath, "+++ b/"+trimmedPath)
	}

	prefix := 0
	minLen := len(oldLines)
	if len(newLines) < minLen {
		minLen = len(newLines)
	}
	for prefix < minLen && oldLines[prefix] == newLines[prefix] {
		prefix++
	}

	suffix := 0
	for suffix < minLen-prefix && oldLines[len(oldLines)-1-suffix] == newLines[len(newLines)-1-suffix] {
		suffix++
	}

	var midOps []diffOp
	if prefix == len(oldLines) && prefix == len(newLines) {
		if oldTrailing == newTrailing {
			return strings.Join(out, "\n")
		}
		// Only the trailing newline changed; show the last line as modified.
		if len(oldLines) > 0 {
			prefix = len(oldLines) - 1
			suffix = 0
			midOps = []diffOp{
				{kind: opDelete, oldIdx: 0, newIdx: 0},
				{kind: opInsert, oldIdx: 1, newIdx: 0},
			}
		}
	} else {
		oldMid := oldLines[prefix : len(oldLines)-suffix]
		newMid := newLines[prefix : len(newLines)-suffix]
		midOps = diffLines(oldMid, newMid)
	}

	leadStart := prefix - contextLines
	if leadStart < 0 {
		leadStart = 0
	}
	trailCount := suffix
	if trailCount > contextLines {
		trailCount = contextLines
	}

	ops := make([]diffOp, 0, (prefix-leadStart)+len(midOps)+trailCount)
	for i := leadStart; i < prefix; i++ {
		ops = append(ops, diffOp{kind: opEqual, oldIdx: i, newIdx: i})
	}
	for _, op := range midOps {
		ops = append(ops, diffOp{
			kind:   op.kind,
			oldIdx: op.oldIdx + prefix,
			newIdx: op.newIdx + prefix,
		})
	}
	oldSuffixStart := len(oldLines) - suffix
	newSuffixStart := len(newLines) - suffix
	for i := 0; i < trailCount; i++ {
		ops = append(ops, diffOp{
			kind:   opEqual,
			oldIdx: oldSuffixStart + i,
			newIdx: newSuffixStart + i,
		})
	}

	type hunkRange struct {
		firstChange int
		lastChange  int
	}
	var hunks []hunkRange
	for i, op := range ops {
		if op.kind == opEqual {
			continue
		}
		if len(hunks) == 0 {
			hunks = append(hunks, hunkRange{firstChange: i, lastChange: i})
			continue
		}
		prev := &hunks[len(hunks)-1]
		if i-prev.lastChange-1 <= 2*contextLines {
			prev.lastChange = i
		} else {
			hunks = append(hunks, hunkRange{firstChange: i, lastChange: i})
		}
	}

	for _, hunk := range hunks {
		start := hunk.firstChange - contextLines
		if start < 0 {
			start = 0
		}
		end := hunk.lastChange + 1 + contextLines
		if end > len(ops) {
			end = len(ops)
		}

		oldCount := 0
		newCount := 0
		firstOld := -1
		firstNew := -1
		for _, op := range ops[start:end] {
			switch op.kind {
			case opEqual:
				if firstOld == -1 {
					firstOld = op.oldIdx
				}
				if firstNew == -1 {
					firstNew = op.newIdx
				}
				oldCount++
				newCount++
			case opDelete:
				if firstOld == -1 {
					firstOld = op.oldIdx
				}
				oldCount++
			case opInsert:
				if firstNew == -1 {
					firstNew = op.newIdx
				}
				newCount++
			}
		}

		oldStart := ops[start].oldIdx
		if oldCount > 0 {
			oldStart = firstOld + 1
		}
		newStart := ops[start].newIdx
		if newCount > 0 {
			newStart = firstNew + 1
		}

		out = append(out, fmt.Sprintf("@@ -%d,%d +%d,%d @@", oldStart, oldCount, newStart, newCount))
		for _, op := range ops[start:end] {
			switch op.kind {
			case opEqual:
				out = append(out, " "+oldLines[op.oldIdx])
				if op.oldIdx == len(oldLines)-1 && !oldTrailing && op.newIdx == len(newLines)-1 && !newTrailing {
					out = append(out, `\ No newline at end of file`)
				}
			case opDelete:
				out = append(out, "-"+oldLines[op.oldIdx])
				if op.oldIdx == len(oldLines)-1 && !oldTrailing {
					out = append(out, `\ No newline at end of file`)
				}
			case opInsert:
				out = append(out, "+"+newLines[op.newIdx])
				if op.newIdx == len(newLines)-1 && !newTrailing {
					out = append(out, `\ No newline at end of file`)
				}
			}
		}
	}

	return strings.Join(out, "\n")
}

func splitDiffLines(s string) ([]string, bool) {
	if s == "" {
		return nil, false
	}
	trailingNewline := strings.HasSuffix(s, "\n")
	if trailingNewline {
		s = s[:len(s)-1]
	}
	if s == "" {
		return []string{""}, trailingNewline
	}
	return strings.Split(s, "\n"), trailingNewline
}

func diffLines(oldLines, newLines []string) []diffOp {
	n := len(oldLines)
	m := len(newLines)
	if n == 0 {
		ops := make([]diffOp, m)
		for j := 0; j < m; j++ {
			ops[j] = diffOp{kind: opInsert, oldIdx: 0, newIdx: j}
		}
		return ops
	}
	if m == 0 {
		ops := make([]diffOp, n)
		for i := 0; i < n; i++ {
			ops[i] = diffOp{kind: opDelete, oldIdx: i, newIdx: 0}
		}
		return ops
	}

	maxD := n + m
	if maxD > maxMyersEditDistance {
		maxD = maxMyersEditDistance
	}

	offset := maxD
	v := make([]int, 2*maxD+1)
	trace := make([][]int, 0, minInt(maxD+1, 64))

	for d := 0; d <= maxD; d++ {
		snap := make([]int, 2*d+1)
		copy(snap, v[offset-d:offset+d+1])
		trace = append(trace, snap)

		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[k-1+offset] < v[k+1+offset]) {
				x = v[k+1+offset]
			} else {
				x = v[k-1+offset] + 1
			}
			y := x - k
			for x < n && y < m && oldLines[x] == newLines[y] {
				x++
				y++
			}
			v[k+offset] = x
			if x == n && y == m {
				return backtrackMyers(n, m, trace, d)
			}
		}
	}

	// Fallback for massive single-edit rewrites exceeding maxMyersEditDistance.
	ops := make([]diffOp, 0, n+m)
	for i := 0; i < n; i++ {
		ops = append(ops, diffOp{kind: opDelete, oldIdx: i, newIdx: 0})
	}
	for j := 0; j < m; j++ {
		ops = append(ops, diffOp{kind: opInsert, oldIdx: n, newIdx: j})
	}
	return ops
}

func backtrackMyers(n, m int, trace [][]int, finalD int) []diffOp {
	ops := make([]diffOp, 0, n+m)
	x := n
	y := m

	for d := finalD; d > 0; d-- {
		prevV := trace[d]
		k := x - y

		var prevK int
		if k == -d || (k != d && prevV[k-1+d] < prevV[k+1+d]) {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := prevV[prevK+d]
		prevY := prevX - prevK

		for x > prevX && y > prevY {
			ops = append(ops, diffOp{kind: opEqual, oldIdx: x - 1, newIdx: y - 1})
			x--
			y--
		}

		if x == prevX {
			ops = append(ops, diffOp{kind: opInsert, oldIdx: prevX, newIdx: prevY})
			y--
		} else {
			ops = append(ops, diffOp{kind: opDelete, oldIdx: prevX, newIdx: prevY})
			x--
		}
	}

	for x > 0 && y > 0 {
		ops = append(ops, diffOp{kind: opEqual, oldIdx: x - 1, newIdx: y - 1})
		x--
		y--
	}

	for i, j := 0, len(ops)-1; i < j; i, j = i+1, j-1 {
		ops[i], ops[j] = ops[j], ops[i]
	}
	return ops
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
