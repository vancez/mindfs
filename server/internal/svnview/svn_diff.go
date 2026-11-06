package svnview

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unicode/utf8"

	"mindfs/server/internal/fs"
)

type normalizedDiff struct {
	path            string
	content         string
	additions       int
	deletions       int
	binary          bool
	propertyChanges bool
	propertyOnly    bool
}

type diffSection struct {
	path  string
	lines []string
}

func splitSVNDiffSections(text string) []diffSection {
	lines := strings.Split(text, "\n")
	sections := make([]diffSection, 0)
	var current *diffSection
	for _, rawLine := range lines {
		line := strings.TrimSuffix(rawLine, "\r")
		if strings.HasPrefix(line, "Index: ") {
			if current != nil {
				sections = append(sections, *current)
			}
			current = &diffSection{path: strings.TrimSpace(strings.TrimPrefix(line, "Index: "))}
			continue
		}
		if current == nil {
			if strings.TrimSpace(line) == "" {
				continue
			}
			current = &diffSection{}
		}
		current.lines = append(current.lines, line)
	}
	if current != nil {
		sections = append(sections, *current)
	}
	return sections
}

func normalizeSVNDiffSection(section diffSection) normalizedDiff {
	var body strings.Builder
	additions := 0
	deletions := 0
	inHunk := false
	binaryCandidate := false
	propertyChanges := false

sectionLoop:
	for _, line := range section.lines {
		// Property headings have no diff prefix. Inspect them before the hunk
		// branch, but never treat a context/added/removed line as a heading: a
		// context line of underscores or a removed line beginning with "-- "
		// would otherwise truncate the diff.
		if !hasDiffPrefix(line) &&
			(strings.HasPrefix(line, "Property changes on:") || isPropertySeparator(line)) {
			propertyChanges = true
			break sectionLoop
		}

		if inHunk {
			switch {
			case strings.HasPrefix(line, "@@"):
				body.WriteString(line)
				body.WriteByte('\n')
			case strings.HasPrefix(line, "+"):
				additions++
				body.WriteString(line)
				body.WriteByte('\n')
			case strings.HasPrefix(line, "-"):
				deletions++
				body.WriteString(line)
				body.WriteByte('\n')
			case strings.HasPrefix(line, " "), strings.HasPrefix(line, "\\"):
				body.WriteString(line)
				body.WriteByte('\n')
			}
			continue
		}

		switch {
		case strings.HasPrefix(line, "Index: "):
			continue
		case strings.HasPrefix(line, "====="):
			continue
		case strings.HasPrefix(line, "--- "):
			// Path headers may use a different encoding than the file body.
			// Drop them; the viewer gets the path from the API response.
			continue
		case strings.HasPrefix(line, "+++ "):
			continue
		case strings.HasPrefix(line, "@@"):
			inHunk = true
			body.WriteString(line)
			body.WriteByte('\n')
			continue
		}
		if strings.TrimSpace(line) != "" {
			binaryCandidate = true
		}
	}

	result := normalizedDiff{
		path:            section.path,
		content:         body.String(),
		additions:       additions,
		deletions:       deletions,
		propertyChanges: propertyChanges,
	}
	switch {
	case inHunk:
	case binaryCandidate:
		// A binary file can also have property changes. Binary wins so the
		// viewer does not claim the change is property-only.
		result.content = ""
		result.binary = true
		result.additions = 0
		result.deletions = 0
	case propertyChanges:
		result.content = ""
		result.propertyOnly = true
	}
	return result
}

func hasDiffPrefix(line string) bool {
	if line == "" {
		return false
	}
	switch line[0] {
	case ' ', '+', '-', '\\':
		return true
	default:
		return false
	}
}

func normalizeSVNDiffOutput(text, requestedPath string) normalizedDiff {
	sections := splitSVNDiffSections(text)
	if len(sections) == 0 {
		return normalizedDiff{path: requestedPath}
	}
	requested := strings.TrimSpace(filepath.ToSlash(filepath.Clean(requestedPath)))
	selected := diffSection{}
	matched := false
	for _, section := range sections {
		sectionPath := decodeSVNPath(section.path)
		normalizedPath := strings.TrimSpace(filepath.ToSlash(filepath.Clean(sectionPath)))
		if diffPathMatches(normalizedPath, requested) {
			selected = section
			matched = true
			break
		}
	}
	if !matched {
		// A directory diff may contain only child sections. Returning the first
		// one would silently label a child file's diff with the directory path.
		if len(sections) == 1 && strings.TrimSpace(sections[0].path) == "" {
			selected = sections[0]
		} else {
			return normalizedDiff{path: requestedPath}
		}
	}
	result := normalizeSVNDiffSection(selected)
	result.path = requestedPath
	if !result.binary && !result.propertyOnly {
		result.content = decodeSVNBody(result.content, filepath.Ext(requestedPath))
	}
	return result
}

// decodeSVNBody decodes a diff body that may contain a mixture of UTF-8 and
// legacy-encoded lines. This happens when a file was converted from GBK to
// UTF-8 between the compared revisions, so "-" lines and "+" lines can use
// different encodings.
func diffPathMatches(candidate, requested string) bool {
	if runtime.GOOS == "windows" {
		candidate = strings.ToLower(candidate)
		requested = strings.ToLower(requested)
	}
	return candidate == requested || strings.HasSuffix(candidate, "/"+requested)
}

func decodeSVNBody(raw, ext string) string {
	if utf8.ValidString(raw) {
		return raw
	}
	if bytes.IndexByte([]byte(raw), 0) >= 0 || hasUTF16BOM(raw) {
		if decoded, _, ok := fs.TryDecodeText([]byte(raw), ".txt"); ok {
			return decoded
		}
	}
	ext = strings.ToLower(strings.TrimSpace(ext))
	lines := strings.Split(raw, "\n")
	for i, line := range lines {
		if utf8.ValidString(line) {
			continue
		}
		decoded, _, ok := fs.TryDecodeText([]byte(line), ext)
		if !ok {
			decoded, _, ok = fs.TryDecodeText([]byte(line), ".txt")
		}
		if ok {
			lines[i] = decoded
			continue
		}
		lines[i] = strings.ToValidUTF8(line, "�")
	}
	return strings.Join(lines, "\n")
}

func hasUTF16BOM(value string) bool {
	if len(value) < 2 {
		return false
	}
	first := uint8(value[0])
	second := uint8(value[1])
	return (first == 0xFF && second == 0xFE) || (first == 0xFE && second == 0xFF)
}

func collectDiffStats(rootPath, text string) map[string]normalizedDiff {
	result := make(map[string]normalizedDiff)
	for _, section := range splitSVNDiffSections(text) {
		normalized := normalizeSVNDiffSection(section)
		relPath, ok := normalizeStatusPath(rootPath, decodeSVNPath(normalized.path))
		if !ok {
			continue
		}
		result[relPath] = normalized
	}
	return result
}

func isPropertySeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) < 10 {
		return false
	}
	for _, r := range trimmed {
		if r != '_' {
			return false
		}
	}
	return true
}

func decodeSVNPath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || utf8.ValidString(raw) {
		return raw
	}
	if decoded, _, ok := fs.TryDecodeText([]byte(raw), ".txt"); ok {
		return decoded
	}
	return strings.ToValidUTF8(raw, "�")
}

func synthAddedDiff(rootPath, relPath string) (DiffResult, error) {
	absPath := filepath.Join(rootPath, filepath.FromSlash(relPath))
	if stat, statErr := os.Stat(absPath); statErr == nil && stat.Size() > maxUnversionedStatBytes {
		return DiffResult{
			Path:      relPath,
			Status:    "??",
			SVNStatus: "unversioned",
			Binary:    true,
		}, nil
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		return DiffResult{}, err
	}
	text := ""
	binary := false
	hasNUL := bytes.IndexByte(data, 0) >= 0
	hasBOM := hasUTF16BOM(string(data))
	switch {
	case hasNUL && !hasBOM:
		binary = true
	case hasBOM:
		if decoded, _, ok := fs.TryDecodeText(data, strings.ToLower(filepath.Ext(relPath))); ok {
			text = decoded
		} else if decoded, _, ok := fs.TryDecodeText(data, ".txt"); ok {
			text = decoded
		} else {
			binary = true
		}
	case utf8.Valid(data):
		// Unversioned files have no SVN diff to decode. Keep valid UTF-8 as-is;
		// running it through a legacy decoder would turn Chinese into mojibake.
		text = string(data)
	default:
		if decoded, _, ok := fs.TryDecodeText(data, strings.ToLower(filepath.Ext(relPath))); ok {
			text = decoded
		} else if decoded, _, ok := fs.TryDecodeText(data, ".txt"); ok {
			text = decoded
		} else {
			text = string(data)
		}
	}
	if binary {
		return DiffResult{
			Path:      relPath,
			Status:    "??",
			SVNStatus: "unversioned",
			Binary:    true,
		}, nil
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lineCount := 0
	lines := []string{}
	if text != "" {
		trimmed := strings.TrimSuffix(text, "\n")
		lines = strings.Split(trimmed, "\n")
		lineCount = len(lines)
	}
	var content strings.Builder
	fmt.Fprintf(&content, "--- /dev/null\n+++ %s\n", relPath)
	if lineCount > 0 {
		fmt.Fprintf(&content, "@@ -0,0 +1,%d @@\n", lineCount)
		for _, line := range lines {
			content.WriteByte('+')
			content.WriteString(line)
			content.WriteByte('\n')
		}
	}
	return DiffResult{
		Path:      relPath,
		Status:    "??",
		SVNStatus: "unversioned",
		Additions: lineCount,
		Content:   content.String(),
	}, nil
}

func diffStatusFromContent(content string) string {
	if strings.Contains(content, "\n@@ -0,0 +") || strings.HasPrefix(content, "@@ -0,0 +") {
		return "A"
	}
	if strings.Contains(content, " +0,0 @@") {
		return "D"
	}
	if strings.TrimSpace(content) == "" {
		return ""
	}
	return "M"
}
