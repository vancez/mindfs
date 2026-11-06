// Package svnview provides read-only Subversion working-copy inspection by
// shelling out to the svn CLI. Keep commands compatible with SVN 1.7: use
// `svn info --xml` instead of --show-item (1.9), and avoid --git and
// --ignore-properties (1.8).
package svnview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"mindfs/server/internal/fs"
)

const (
	defaultSVNTimeout     = 30 * time.Second
	detectionSVNTimeout   = 5 * time.Second
	maxSVNErrorOutputSize = 4096
	// Large unversioned artifacts (VM images, logs) commonly live next to a
	// working copy. Reading them just to show a line count can exhaust memory.
	maxUnversionedStatBytes = 8 << 20
	// The status endpoint computes +/- stats from a single whole-working-copy
	// diff. Beyond this size the stats are skipped instead of spending seconds
	// parsing it on every watcher event.
	maxSVNDiffStatsBytes = 16 << 20
	infoCacheTTL         = 30 * time.Second
)

type infoCacheEntry struct {
	info Info
	ok   bool
	at   time.Time
}

var infoCache = struct {
	sync.Mutex
	entries map[string]infoCacheEntry
}{entries: make(map[string]infoCacheEntry)}

func invalidateInfoCache() {
	infoCache.Lock()
	infoCache.entries = make(map[string]infoCacheEntry)
	infoCache.Unlock()
}

func cachedInfo(key string) (Info, bool, bool) {
	infoCache.Lock()
	defer infoCache.Unlock()
	entry, ok := infoCache.entries[key]
	if !ok || time.Since(entry.at) > infoCacheTTL {
		return Info{}, false, false
	}
	return entry.info, entry.ok, true
}

func storeInfoCache(key string, info Info, ok bool) {
	infoCache.Lock()
	if len(infoCache.entries) >= 4096 {
		// Bound memory in long-running servers that touch many files. Detect
		// and revision entries are cheap to recompute.
		infoCache.entries = make(map[string]infoCacheEntry)
	}
	infoCache.entries[key] = infoCacheEntry{info: info, ok: ok, at: time.Now()}
	infoCache.Unlock()
}

type Info struct {
	WCRoot   string `json:"wc_root,omitempty"`
	Revision string `json:"revision,omitempty"`
	URL      string `json:"url,omitempty"`
	RepoRoot string `json:"repository_root,omitempty"`
}

type StatusItem struct {
	Path       string `json:"path"`
	OldPath    string `json:"old_path,omitempty"`
	Status     string `json:"status"`
	SVNStatus  string `json:"svn_status,omitempty"`
	Props      string `json:"props_status,omitempty"`
	Additions  int    `json:"additions"`
	Deletions  int    `json:"deletions"`
	IsDir      bool   `json:"is_dir,omitempty"`
	Conflicted bool   `json:"conflicted,omitempty"`
}

type StatusResult struct {
	Available  bool         `json:"available"`
	WCRoot     string       `json:"wc_root,omitempty"`
	Revision   string       `json:"revision,omitempty"`
	URL        string       `json:"url,omitempty"`
	DirtyCount int          `json:"dirty_count"`
	Items      []StatusItem `json:"items"`
}

type DiffResult struct {
	Path            string             `json:"path"`
	OldPath         string             `json:"old_path,omitempty"`
	Status          string             `json:"status"`
	SVNStatus       string             `json:"svn_status,omitempty"`
	Additions       int                `json:"additions"`
	Deletions       int                `json:"deletions"`
	Content         string             `json:"content"`
	Binary          bool               `json:"binary,omitempty"`
	PropertyChanges bool               `json:"property_changes,omitempty"`
	PropertyOnly    bool               `json:"property_only,omitempty"`
	FileMeta        []fs.FileMetaEntry `json:"file_meta,omitempty"`
}

type RelatedFileDiffResult struct {
	DiffResult
	BaseRevision   string `json:"base_revision,omitempty"`
	TargetRevision string `json:"target_revision,omitempty"`
	Source         string `json:"source,omitempty"`
}

// DetectWorkingCopy reports whether rootPath belongs to an SVN working copy.
// It performs a cheap .svn ancestor scan before invoking the svn CLI.
func DetectWorkingCopy(ctx context.Context, rootPath string) (Info, bool) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !hasSvnAncestor(rootPath) {
		return Info{}, false
	}
	if cached, ok, hit := cachedInfo("detect:" + rootPath); hit {
		return cached, ok
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, detectionSVNTimeout)
		defer cancel()
	}
	out, err := runSVN(ctx, "", "info", "--xml", "--", svnPathArg(rootPath))
	if err != nil {
		storeInfoCache("detect:"+rootPath, Info{}, false)
		return Info{}, false
	}
	info, err := parseInfoXML(out, rootPath)
	if err != nil {
		storeInfoCache("detect:"+rootPath, Info{}, false)
		return Info{}, false
	}
	storeInfoCache("detect:"+rootPath, info, true)
	return info, true
}

// InspectStatus returns the local changes of an SVN working copy scoped to
// rootPath. Paths in the result are relative to rootPath.
func InspectStatus(ctx context.Context, rootPath string) (StatusResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" {
		return StatusResult{}, errors.New("root path required")
	}
	if !filepath.IsAbs(rootPath) {
		return StatusResult{}, errors.New("root path must be absolute")
	}
	infoOut, err := runSVN(ctx, rootPath, "info", "--xml", "--", ".")
	if err != nil {
		return StatusResult{}, err
	}
	info, err := parseInfoXML(infoOut, rootPath)
	if err != nil {
		return StatusResult{}, err
	}

	statusOut, err := runSVN(ctx, rootPath, "status", "--xml", "--depth", "infinity", "--", ".")
	if err != nil {
		return StatusResult{}, err
	}
	entries, err := parseStatusXML(statusOut)
	if err != nil {
		return StatusResult{}, err
	}

	items := make([]StatusItem, 0, len(entries))
	hasTrackedChanges := false
	externalRoots := make([]string, 0)
	seenExternalRoots := make(map[string]struct{})
	for _, entry := range entries {
		if strings.EqualFold(strings.TrimSpace(entry.Item), "external") {
			if relPath, ok := normalizeStatusPath(rootPath, entry.Path); ok {
				if _, seen := seenExternalRoots[relPath]; !seen {
					seenExternalRoots[relPath] = struct{}{}
					externalRoots = append(externalRoots, relPath)
				}
			}
			continue
		}
		item, ok := statusItemFromEntry(rootPath, entry)
		if !ok {
			continue
		}
		items = append(items, item)
		if item.Status != "??" && !item.IsDir {
			hasTrackedChanges = true
		}
	}

	stats := map[string]normalizedDiff{}
	if hasTrackedChanges {
		diffOut, diffErr := runSVN(ctx, rootPath, "diff", "--internal-diff", "--", ".")
		if diffErr != nil {
			log.Printf("[svn] status.stats.failed root=%q err=%v", rootPath, diffErr)
		} else if len(diffOut) > maxSVNDiffStatsBytes {
			log.Printf("[svn] status.stats.skipped root=%q bytes=%d", rootPath, len(diffOut))
		} else {
			stats = collectDiffStats(rootPath, string(diffOut))
		}
		sort.Strings(externalRoots)
		for _, externalRoot := range externalRoots {
			externalDiffArgs := appendDiffTarget(
				[]string{"diff", "--internal-diff"},
				externalRoot,
				"",
			)
			externalDiffOut, externalErr := runSVN(ctx, rootPath, externalDiffArgs...)
			if externalErr != nil {
				log.Printf("[svn] status.external.stats.failed root=%q external=%q err=%v", rootPath, externalRoot, externalErr)
				continue
			}
			if len(externalDiffOut) > maxSVNDiffStatsBytes {
				log.Printf("[svn] status.external.stats.skipped root=%q external=%q bytes=%d", rootPath, externalRoot, len(externalDiffOut))
				continue
			}
			for path, stat := range collectDiffStats(rootPath, string(externalDiffOut)) {
				stats[path] = stat
			}
		}
	}

	for i := range items {
		if items[i].Status == "??" {
			if items[i].IsDir {
				continue
			}
			additions, binary := countUnversionedLines(filepath.Join(rootPath, filepath.FromSlash(items[i].Path)))
			if !binary {
				items[i].Additions = additions
			}
			continue
		}
		if stat, ok := stats[items[i].Path]; ok {
			items[i].Additions = stat.additions
			items[i].Deletions = stat.deletions
		}
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].Path < items[j].Path
	})

	return StatusResult{
		Available:  true,
		WCRoot:     info.WCRoot,
		Revision:   info.Revision,
		URL:        info.URL,
		DirtyCount: len(items),
		Items:      items,
	}, nil
}

// ReadDiff returns the local unified diff for relPath scoped to rootPath.
func ReadDiff(ctx context.Context, rootPath, relPath string) (DiffResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return DiffResult{}, errors.New("root path must be absolute")
	}
	relPath, err := normalizeSVNTargetPath(relPath)
	if err != nil {
		return DiffResult{}, err
	}
	statusEntries, err := statusEntriesForPath(ctx, rootPath, relPath)
	if err != nil {
		return DiffResult{}, err
	}
	item, convErr := findStatusItem(rootPath, relPath, statusEntries)
	if convErr != nil {
		item = nil
	}
	isDir := item != nil && item.IsDir
	if !isDir {
		statPath := rootPath
		if relPath != "." {
			statPath = filepath.Join(rootPath, filepath.FromSlash(relPath))
		}
		if stat, statErr := os.Stat(statPath); statErr == nil && stat.IsDir() {
			isDir = true
		}
	}
	if isDir {
		if item == nil {
			return DiffResult{}, fmt.Errorf("path is a directory: %s", relPath)
		}
		// Only the directory's own (property) change is shown. Descending
		// would silently return a child file's diff under the directory path.
		return readLocalDiff(ctx, rootPath, relPath, item, "empty")
	}
	if item != nil && item.Status == "??" {
		return synthAddedDiff(rootPath, relPath)
	}
	return readLocalDiff(ctx, rootPath, relPath, item, "")
}

// ReadRelatedFileDiff returns a diff for a session related file. It prefers
// local changes and falls back to the first repository revision after
// baseRevision that touched the path.
func ReadRelatedFileDiff(ctx context.Context, repoRoot, baseRevision, relPath string) (RelatedFileDiffResult, error) {
	repoRoot = filepath.Clean(strings.TrimSpace(repoRoot))
	if repoRoot == "" || !filepath.IsAbs(repoRoot) {
		return RelatedFileDiffResult{}, errors.New("repository path must be absolute")
	}
	relPath, err := cleanRelativePath(relPath)
	if err != nil {
		return RelatedFileDiffResult{}, err
	}
	baseRevision = strings.TrimSpace(baseRevision)

	statusEntries, err := statusEntriesForPath(ctx, repoRoot, relPath)
	if err != nil {
		return RelatedFileDiffResult{}, err
	}
	item, _ := findStatusItem(repoRoot, relPath, statusEntries)
	if item != nil {
		if item.IsDir {
			return RelatedFileDiffResult{}, fmt.Errorf("path is a directory: %s", relPath)
		}
		if item.Status == "??" {
			diff, synthErr := synthAddedDiff(repoRoot, relPath)
			if synthErr != nil {
				return RelatedFileDiffResult{}, synthErr
			}
			return RelatedFileDiffResult{
				DiffResult:   diff,
				BaseRevision: baseRevision,
				Source:       "worktree",
			}, nil
		}
		diff, localErr := readLocalDiff(ctx, repoRoot, relPath, item, "")
		if localErr != nil {
			return RelatedFileDiffResult{}, localErr
		}
		return RelatedFileDiffResult{DiffResult: diff, BaseRevision: baseRevision, Source: "worktree"}, nil
	}

	baseNumber, parseErr := strconv.Atoi(baseRevision)
	if parseErr != nil || baseNumber < 0 {
		return RelatedFileDiffResult{
			DiffResult:   emptyRelatedDiff(relPath),
			BaseRevision: baseRevision,
			Source:       "worktree",
		}, nil
	}

	targetRevision, nextErr := firstRevisionAfter(ctx, repoRoot, baseNumber, relPath)
	if nextErr != nil {
		return RelatedFileDiffResult{}, nextErr
	}
	if targetRevision == "" {
		return RelatedFileDiffResult{
			DiffResult:   emptyRelatedDiff(relPath),
			BaseRevision: baseRevision,
			Source:       "worktree",
		}, nil
	}

	diffArgs := appendDiffTarget([]string{"diff", "--internal-diff", "-c", targetRevision}, relPath, "")
	diffOut, diffErr := runSVN(ctx, repoRoot, diffArgs...)
	if diffErr != nil {
		return RelatedFileDiffResult{}, diffErr
	}
	normalized := normalizeSVNDiffOutput(string(diffOut), relPath)
	diff := diffFromNormalized(relPath, normalized)
	if diff.Status == "" && (normalized.propertyChanges || normalized.binary) {
		diff.Status = "M"
	}
	if diff.Status == "" {
		diff.Status = diffStatusFromContent(diff.Content)
	}
	return RelatedFileDiffResult{
		DiffResult:     diff,
		BaseRevision:   baseRevision,
		TargetRevision: targetRevision,
		Source:         "commit_range",
	}, nil
}

// FileRevision returns the base revision for filePath. Unversioned files fall
// back to the revision of rootPath. The bool reports whether the path is
// inside an SVN working copy.
func FileRevision(ctx context.Context, rootPath, filePath string) (string, bool) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	absFile := strings.TrimSpace(filePath)
	if absFile == "" {
		return "", false
	}
	if !filepath.IsAbs(absFile) {
		absFile = filepath.Join(rootPath, absFile)
	}
	absFile = filepath.Clean(absFile)
	if !hasSvnAncestor(absFile) {
		return "", false
	}

	if cached, ok, hit := cachedInfo("rev:" + absFile); hit && ok {
		return cached.Revision, true
	}
	if out, err := runSVNQuiet(ctx, "", "info", "--xml", "--", svnPathArg(absFile)); err == nil {
		if info, parseErr := parseInfoXML(out, rootPath); parseErr == nil {
			storeInfoCache("rev:"+absFile, info, true)
			return info.Revision, true
		}
	}
	// Unversioned files have no revision of their own. Prefer the nearest
	// working-copy root (which may be an external) over the managed root so the
	// recorded base revision belongs to the repository that owns the path.
	fallbackRoot := nearestSvnWorkingCopyRoot(absFile)
	if fallbackRoot == "" {
		fallbackRoot = rootPath
	}
	if fallbackRoot == "" {
		return "", false
	}
	if cached, ok, hit := cachedInfo("root:" + fallbackRoot); hit && ok {
		return cached.Revision, true
	}
	if out, err := runSVN(ctx, "", "info", "--xml", "--", svnPathArg(fallbackRoot)); err == nil {
		if info, parseErr := parseInfoXML(out, fallbackRoot); parseErr == nil {
			storeInfoCache("root:"+fallbackRoot, info, true)
			return info.Revision, true
		}
	}
	return "", false
}

func statusEntriesForPath(ctx context.Context, rootPath, relPath string) ([]svnStatusEntry, error) {
	out, err := runSVN(ctx, rootPath, "status", "--xml", "--", svnPathArg(filepath.FromSlash(relPath)))
	if err != nil {
		return nil, err
	}
	return parseStatusXML(out)
}

func findStatusItem(rootPath, relPath string, entries []svnStatusEntry) (*StatusItem, error) {
	for _, entry := range entries {
		item, ok := statusItemFromEntry(rootPath, entry)
		if !ok {
			continue
		}
		if sameStatusPath(item.Path, relPath) {
			matched := item
			return &matched, nil
		}
	}
	return nil, os.ErrNotExist
}

func readLocalDiff(ctx context.Context, rootPath, relPath string, item *StatusItem, depth string) (DiffResult, error) {
	args := appendDiffTarget(
		[]string{"diff", "--internal-diff"},
		relPath,
		depth,
	)
	diffOut, err := runSVN(ctx, rootPath, args...)
	if err != nil {
		// A missing/obstructed path has no readable diff, but its status is
		// still meaningful. Every other failure must reach the UI instead of
		// being presented as an empty diff.
		if item != nil && (item.Status == "!" || item.Status == "~") {
			return DiffResult{Path: relPath, Status: item.Status, SVNStatus: item.SVNStatus}, nil
		}
		return DiffResult{}, err
	}
	normalized := normalizeSVNDiffOutput(string(diffOut), relPath)
	diff := diffFromNormalized(relPath, normalized)
	diff.Path = relPath
	if item != nil {
		diff.Status = item.Status
		diff.SVNStatus = item.SVNStatus
	} else if diff.Status == "" {
		diff.Status = diffStatusFromContent(diff.Content)
	}
	return diff, nil
}

func diffFromNormalized(path string, normalized normalizedDiff) DiffResult {
	status := ""
	if normalized.additions > 0 || normalized.deletions > 0 {
		status = diffStatusFromContent(normalized.content)
	}
	return DiffResult{
		Path:            path,
		Status:          status,
		Additions:       normalized.additions,
		Deletions:       normalized.deletions,
		Content:         normalized.content,
		Binary:          normalized.binary,
		PropertyChanges: normalized.propertyChanges,
		PropertyOnly:    normalized.propertyOnly,
	}
}

func emptyRelatedDiff(path string) DiffResult {
	return DiffResult{Path: path}
}

func firstRevisionAfter(ctx context.Context, repoRoot string, baseRevision int, relPath string) (string, error) {
	if baseRevision < 0 {
		return "", nil
	}
	// Revision 0 is used for files that were unversioned when recorded. Their
	// first appearance in the repository is found by searching from r1.
	start := baseRevision + 1
	out, err := runSVN(ctx, repoRoot, "log", "--xml", "--limit", "1", "-r",
		fmt.Sprintf("%d:HEAD", start), "--", svnPathArg(filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	revisions, err := parseLogXML(out)
	if err != nil || len(revisions) == 0 {
		return "", err
	}
	candidate := revisions[0]
	number, err := strconv.Atoi(candidate)
	if err != nil || number <= baseRevision {
		return "", err
	}
	return candidate, nil
}

func statusItemFromEntry(rootPath string, entry svnStatusEntry) (StatusItem, bool) {
	// svn reports property changes on the working-copy root as ".". Dropping
	// that entry makes root-level svn:externals/svn:ignore changes invisible.
	rawPath := strings.TrimSpace(entry.Path)
	var relPath string
	if rawPath == "." || rawPath == "" {
		relPath = "."
	} else {
		var ok bool
		relPath, ok = normalizeStatusPath(rootPath, rawPath)
		if !ok {
			return StatusItem{}, false
		}
	}
	status, conflicted, ok := mapSVNStatus(entry)
	if !ok {
		return StatusItem{}, false
	}
	oldPath := ""
	if strings.TrimSpace(entry.MovedFrom) != "" {
		if normalized, oldOK := normalizeStatusPath(rootPath, entry.MovedFrom); oldOK {
			oldPath = normalized
			if status == "A" {
				status = "R"
			}
		}
	}
	isDir := strings.EqualFold(entry.Kind, "dir")
	if entry.Kind == "" && status != "D" && status != "!" {
		if stat, err := os.Stat(filepath.Join(rootPath, filepath.FromSlash(relPath))); err == nil && stat.IsDir() {
			isDir = true
		}
	}
	return StatusItem{
		Path:       relPath,
		OldPath:    oldPath,
		Status:     status,
		SVNStatus:  entry.Item,
		Props:      entry.Props,
		IsDir:      isDir,
		Conflicted: conflicted,
	}, true
}

func mapSVNStatus(entry svnStatusEntry) (string, bool, bool) {
	item := strings.ToLower(strings.TrimSpace(entry.Item))
	props := strings.ToLower(strings.TrimSpace(entry.Props))
	treeConflicted := entry.TreeConflicted
	if treeConflicted || item == "conflicted" || props == "conflicted" {
		return "C", true, true
	}
	switch item {
	case "modified":
		return "M", false, true
	case "added":
		return "A", false, true
	case "deleted":
		return "D", false, true
	case "missing":
		return "!", false, true
	case "replaced":
		return "R", false, true
	case "unversioned":
		return "??", false, true
	case "obstructed":
		return "~", false, true
	case "incomplete":
		return "!", false, true
	case "normal", "none", "":
		if props == "modified" {
			return "M", false, true
		}
		return "", false, false
	case "ignored", "external":
		return "", false, false
	default:
		if props == "modified" {
			return "M", false, true
		}
		return "", false, false
	}
}

func normalizeStatusPath(rootPath, rawPath string) (string, bool) {
	rawPath = strings.TrimSpace(rawPath)
	if rawPath == "" || rawPath == "." {
		return "", false
	}
	clean := filepath.Clean(rawPath)
	if filepath.IsAbs(clean) {
		rel, err := filepath.Rel(rootPath, clean)
		if err != nil {
			return "", false
		}
		clean = rel
	}
	if filepath.IsAbs(clean) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", false
	}
	slashPath := filepath.ToSlash(clean)
	if !validStatusPath(slashPath) {
		return "", false
	}
	return slashPath, true
}

func validStatusPath(path string) bool {
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
		if part == ".mindfs" || part == ".svn" || part == ".git" {
			return false
		}
	}
	return true
}

func cleanRelativePath(path string) (string, error) {
	path = strings.TrimSpace(strings.SplitN(path, "#", 2)[0])
	if path == "" {
		return "", errors.New("path required")
	}
	clean := filepath.Clean(path)
	if filepath.IsAbs(clean) {
		return "", errors.New("path must be relative")
	}
	// On Windows "C:foo" is not absolute, but the svn child process resolves
	// it against the per-drive current directory, which can be outside the
	// managed root. Reject drive-relative paths (a no-op on other platforms).
	if filepath.VolumeName(clean) != "" {
		return "", errors.New("invalid path")
	}
	slashPath := filepath.ToSlash(clean)
	if slashPath == "." || slashPath == ".." || strings.HasPrefix(slashPath, "../") {
		return "", errors.New("invalid path")
	}
	if !validStatusPath(slashPath) {
		return "", errors.New("invalid path")
	}
	return slashPath, nil
}

// normalizeSVNTargetPath is cleanRelativePath with the working-copy root "."
// allowed. The UI can select the root when its properties (svn:externals,
// svn:ignore) are modified.
func normalizeSVNTargetPath(path string) (string, error) {
	trimmed := strings.TrimSpace(strings.SplitN(path, "#", 2)[0])
	if trimmed == "." {
		return ".", nil
	}
	return cleanRelativePath(trimmed)
}

// svnPathArg prevents Subversion from interpreting a file name as a peg
// revision. `--` does not disable path@REV parsing.
func svnPathArg(path string) string {
	if strings.Contains(path, "@") {
		return path + "@"
	}
	return path
}

// appendDiffTarget appends a diff target. `svn diff` handles working-copy
// targets containing "@" differently from status/info/commit: the peg escape
// does not work there. Diff the nearest ancestor without "@" and let the
// section matcher pick the requested path. This also keeps the target usable
// when the file lives below an SVN external.
func appendDiffTarget(args []string, relPath, depth string) []string {
	if !strings.Contains(relPath, "@") {
		if depth != "" {
			args = append(args, "--depth", depth)
		}
		return append(args, "--", filepath.FromSlash(relPath))
	}
	ancestor := relPath
	for {
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(ancestor)))
		if parent == "" || parent == "." || parent == ancestor {
			ancestor = "."
			break
		}
		ancestor = parent
		if !strings.Contains(ancestor, "@") {
			break
		}
	}
	return append(args, "--", filepath.FromSlash(ancestor))
}

func sameStatusPath(left, right string) bool {
	left = filepath.ToSlash(filepath.Clean(strings.TrimSpace(left)))
	right = filepath.ToSlash(filepath.Clean(strings.TrimSpace(right)))
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func hasSvnAncestor(path string) bool {
	return nearestSvnWorkingCopyRoot(path) != ""
}

func nearestSvnWorkingCopyRoot(path string) string {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "" {
		return ""
	}
	start := path
	if stat, err := os.Stat(path); err != nil || !stat.IsDir() {
		start = filepath.Dir(path)
	}
	for {
		if stat, err := os.Stat(filepath.Join(start, ".svn")); err == nil && stat.IsDir() {
			return start
		}
		parent := filepath.Dir(start)
		if parent == start {
			return ""
		}
		start = parent
	}
}

func decodeSVNText(out []byte, ext string) string {
	if utf8.Valid(out) {
		return string(out)
	}
	ext = strings.ToLower(strings.TrimSpace(ext))
	if ext != "" {
		if decoded, _, ok := fs.TryDecodeText(out, ext); ok {
			return decoded
		}
	}
	// SVN diff bodies are known to be text. Decode legacy encodings even for
	// unknown extensions, where the extension allowlist would reject them.
	if decoded, _, ok := fs.TryDecodeText(out, ".txt"); ok {
		return decoded
	}
	return strings.ToValidUTF8(string(out), "�")
}

func countUnversionedLines(path string) (int, bool) {
	stat, err := os.Stat(path)
	if err != nil {
		return 0, false
	}
	if stat.Size() > maxUnversionedStatBytes {
		return 0, true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	return countTextLines(data, path)
}

func countTextLines(data []byte, path string) (int, bool) {
	if len(data) == 0 {
		return 0, false
	}
	if decoded, _, ok := fs.TryDecodeText(data, strings.ToLower(filepath.Ext(path))); ok {
		data = []byte(decoded)
	} else if bytes.IndexByte(data, 0) >= 0 {
		return 0, true
	}
	if !utf8.Valid(data) && bytes.IndexByte(data, 0) >= 0 {
		return 0, true
	}
	count := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		count++
	}
	return count, false
}

func runSVN(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return runSVNCommand(ctx, dir, true, args...)
}

func runSVNQuiet(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return runSVNCommand(ctx, dir, false, args...)
}

func runSVNCommand(ctx context.Context, dir string, logErrors bool, args ...string) ([]byte, error) {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultSVNTimeout)
		defer cancel()
	}
	fullArgs := append([]string{"--non-interactive"}, args...)
	cmd := newSVNCommand(ctx, fullArgs...)
	cmd.Dir = dir
	// If svn spawns helpers (ssh, credential helpers) that inherit stdout or
	// stderr, killing the direct process alone may leave Wait blocked on the
	// inherited pipes forever. WaitDelay bounds that case.
	cmd.WaitDelay = 5 * time.Second
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, fmt.Errorf("svn command canceled: %w", ctxErr)
		}
		message := strings.TrimSpace(decodeSVNText(stderr.Bytes(), ".txt"))
		if len(message) > maxSVNErrorOutputSize {
			message = message[:maxSVNErrorOutputSize]
		}
		if logErrors {
			log.Printf("[svn] command.error dir=%q args=%q err=%v stderr=%q", dir, fullArgs, err, message)
		}
		if message != "" {
			return nil, fmt.Errorf("svn %s: %s", strings.Join(args, " "), message)
		}
		return nil, fmt.Errorf("svn %s: %w", strings.Join(args, " "), err)
	}
	return stdout.Bytes(), nil
}
