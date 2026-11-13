package svnview

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const operationSVNTimeout = 10 * time.Minute

type ActionResult struct {
	Output string       `json:"output"`
	Status StatusResult `json:"status"`
}

var workingCopyLocks sync.Map // map[string]*sync.Mutex

func lockWorkingCopy(rootPath string) func() {
	key := filepath.Clean(strings.TrimSpace(rootPath))
	if abs, err := filepath.Abs(key); err == nil {
		key = abs
	}
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	value, _ := workingCopyLocks.LoadOrStore(key, &sync.Mutex{})
	mu := value.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// Update updates the working copy, leaving conflicts in place for the user to
// resolve. Non-conflicting changes are applied normally.
func Update(ctx context.Context, rootPath string) (ActionResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return ActionResult{}, errors.New("root path must be absolute")
	}
	unlock := lockWorkingCopy(rootPath)
	defer unlock()
	operationCtx, cancel := operationContext(ctx)
	defer cancel()
	output, err := runSVN(operationCtx, rootPath, "update", "--accept", "postpone", "--", ".")
	if err != nil {
		return ActionResult{}, err
	}
	invalidateInfoCache()
	status, err := InspectStatus(ctx, rootPath)
	if err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		Output: strings.TrimSpace(decodeSVNText(output, ".txt")),
		Status: status,
	}, nil
}

// Commit commits all versioned changes under rootPath. Unversioned files are
// not included; use CommitPaths with explicit paths to add and commit new
// files.
func Commit(ctx context.Context, rootPath, message string) (ActionResult, error) {
	return CommitPaths(ctx, rootPath, message, nil)
}

type commitGroup struct {
	repoRoot   string
	depthEmpty bool
	paths      []string
}

// CommitPaths commits only the selected paths. Selected unversioned files and
// directories are added automatically, missing (deleted outside SVN) paths are
// scheduled for deletion, and versioned directory property changes are
// committed with --depth empty so unrelated child changes are not included.
func CommitPaths(ctx context.Context, rootPath, message string, paths []string) (ActionResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return ActionResult{}, errors.New("root path must be absolute")
	}
	message = strings.TrimSpace(message)
	if message == "" {
		return ActionResult{}, errors.New("commit message required")
	}
	if strings.ContainsRune(message, 0) {
		return ActionResult{}, errors.New("invalid commit message")
	}
	if len(paths) > 10000 {
		return ActionResult{}, errors.New("too many paths")
	}

	selectedPaths := make([]string, 0, len(paths))
	seen := make(map[string]struct{}, len(paths))
	for _, rawPath := range paths {
		cleanPath, err := normalizeSVNTargetPath(rawPath)
		if err != nil {
			return ActionResult{}, err
		}
		key := strings.ToLower(cleanPath)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		selectedPaths = append(selectedPaths, cleanPath)
	}

	unlock := lockWorkingCopy(rootPath)
	defer unlock()
	operationCtx, cancel := operationContext(ctx)
	defer cancel()

	outputParts := make([]string, 0, 4)
	if len(selectedPaths) == 0 {
		// Preserve the standard "commit every versioned change under root"
		// behavior. This is not exposed by the UI, which always sends an
		// explicit selection.
		args := []string{"commit", "-m", message, "--", "."}
		output, err := runSVN(operationCtx, rootPath, args...)
		if err != nil {
			return ActionResult{}, err
		}
		outputParts = append(outputParts, strings.TrimSpace(decodeSVNText(output, ".txt")))
		invalidateInfoCache()
		status, err := InspectStatus(ctx, rootPath)
		if err != nil {
			return ActionResult{}, err
		}
		return ActionResult{Output: strings.Join(outputParts, "\n"), Status: status}, nil
	}

	statuses, err := statusMapForRoot(operationCtx, rootPath)
	if err != nil {
		return ActionResult{}, err
	}
	prepared := false
	for _, cleanPath := range selectedPaths {
		item, ok := statusForPath(statuses, cleanPath)
		if !ok {
			// The path may already be clean (for example it was committed by
			// another client). Leave the decision to svn commit.
			continue
		}
		switch item.Status {
		case "C":
			return ActionResult{}, fmt.Errorf("path has unresolved conflicts: %s", cleanPath)
		case "~":
			return ActionResult{}, fmt.Errorf("path is obstructed; run svn update or clean it up first: %s", cleanPath)
		case "??":
			addArgs := []string{"add", "--parents", "--", svnPathArg(filepath.FromSlash(cleanPath))}
			addOut, addErr := runSVN(operationCtx, rootPath, addArgs...)
			if addErr != nil {
				return ActionResult{}, addErr
			}
			if addOutput := strings.TrimSpace(decodeSVNText(addOut, ".txt")); addOutput != "" {
				outputParts = append(outputParts, addOutput)
			}
			prepared = true
		case "!":
			deleteArgs := []string{"delete", "--force", "--", svnPathArg(filepath.FromSlash(cleanPath))}
			deleteOut, deleteErr := runSVN(operationCtx, rootPath, deleteArgs...)
			if deleteErr != nil {
				return ActionResult{}, deleteErr
			}
			if deleteOutput := strings.TrimSpace(decodeSVNText(deleteOut, ".txt")); deleteOutput != "" {
				outputParts = append(outputParts, deleteOutput)
			}
			prepared = true
		}
	}
	if prepared {
		statuses, err = statusMapForRoot(operationCtx, rootPath)
		if err != nil {
			return ActionResult{}, err
		}
	}

	groups := make([]commitGroup, 0, 2)
	groupIndex := make(map[string]int)
	for _, cleanPath := range selectedPaths {
		item, ok := statusForPath(statuses, cleanPath)
		if !ok {
			// The path is clean (status only lists changed paths). In
			// particular, committing a clean "." with the default recursive
			// depth would commit unrelated changes, so skip absent paths.
			continue
		}
		depthEmpty := item.IsDir && item.Status == "M" && strings.TrimSpace(item.Props) == "modified"
		repoRoot, repoErr := repositoryRootForPath(operationCtx, rootPath, cleanPath)
		if repoErr != nil {
			return ActionResult{}, repoErr
		}
		key := repoRoot + "\x00" + fmt.Sprintf("%t", depthEmpty)
		index, ok := groupIndex[key]
		if !ok {
			index = len(groups)
			groupIndex[key] = index
			groups = append(groups, commitGroup{repoRoot: repoRoot, depthEmpty: depthEmpty})
		}
		groups[index].paths = append(groups[index].paths, cleanPath)
	}
	if len(groups) == 0 {
		return ActionResult{}, errors.New("no local changes to commit")
	}

	for _, group := range groups {
		if group.depthEmpty {
			// SVN requires a directory to be at its repository revision
			// before its properties can be committed. Update only these
			// directories' own metadata; their children are untouched.
			updateArgs := []string{"update", "--depth", "empty", "--accept", "postpone", "--"}
			for _, cleanPath := range group.paths {
				updateArgs = append(updateArgs, svnPathArg(filepath.FromSlash(cleanPath)))
			}
			updateOut, updateErr := runSVN(operationCtx, rootPath, updateArgs...)
			if updateErr != nil {
				return ActionResult{}, updateErr
			}
			if updateOutput := strings.TrimSpace(decodeSVNText(updateOut, ".txt")); updateOutput != "" {
				outputParts = append(outputParts, updateOutput)
			}
		}
		args := []string{"commit", "-m", message}
		if group.depthEmpty {
			args = append(args, "--depth", "empty")
		}
		args = append(args, "--")
		for _, cleanPath := range group.paths {
			args = append(args, svnPathArg(filepath.FromSlash(cleanPath)))
		}
		output, commitErr := runSVN(operationCtx, rootPath, args...)
		if commitErr != nil {
			if len(outputParts) > 0 {
				return ActionResult{}, fmt.Errorf("%w\n%s", commitErr, strings.Join(outputParts, "\n"))
			}
			return ActionResult{}, commitErr
		}
		if commitOutput := strings.TrimSpace(decodeSVNText(output, ".txt")); commitOutput != "" {
			outputParts = append(outputParts, commitOutput)
		}
	}

	invalidateInfoCache()
	status, err := InspectStatus(ctx, rootPath)
	if err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		Output: strings.Join(outputParts, "\n"),
		Status: status,
	}, nil
}

func statusMapForRoot(ctx context.Context, rootPath string) (map[string]StatusItem, error) {
	out, err := runSVN(ctx, rootPath, "status", "--xml", "--depth", "infinity", "--", ".")
	if err != nil {
		return nil, err
	}
	entries, err := parseStatusXML(out)
	if err != nil {
		return nil, err
	}
	result := make(map[string]StatusItem, len(entries))
	for _, entry := range entries {
		item, ok := statusItemFromEntry(rootPath, entry)
		if !ok {
			continue
		}
		result[item.Path] = item
	}
	return result, nil
}

func statusForPath(statuses map[string]StatusItem, path string) (StatusItem, bool) {
	if item, ok := statuses[path]; ok {
		return item, true
	}
	if runtime.GOOS == "windows" {
		for candidate, item := range statuses {
			if strings.EqualFold(candidate, path) {
				return item, true
			}
		}
	}
	return StatusItem{}, false
}

func repositoryRootForPath(ctx context.Context, rootPath, relPath string) (string, error) {
	// A path scheduled for deletion (or missing before the delete is
	// scheduled) may not be accepted by `svn info`; its parent belongs to the
	// same repository, so walk up until info succeeds.
	targetPath := relPath
	for {
		target := "."
		if targetPath != "" && targetPath != "." {
			target = svnPathArg(filepath.FromSlash(targetPath))
		}
		out, err := runSVNQuiet(ctx, rootPath, "info", "--xml", "--", target)
		if err == nil {
			info, parseErr := parseInfoXML(out, rootPath)
			if parseErr != nil {
				return "", parseErr
			}
			return strings.TrimSpace(info.RepoRoot), nil
		}
		if targetPath == "" || targetPath == "." {
			return "", err
		}
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(targetPath)))
		if parent == targetPath {
			return "", err
		}
		targetPath = parent
	}
}

// Revert discards local changes for a versioned path. Unversioned files are
// not deleted by svn revert and are rejected here so the UI never implies that
// it removed them. Property-only directory changes are reverted with
// --depth empty so unrelated child changes are preserved.
func Revert(ctx context.Context, rootPath, relPath string) (ActionResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return ActionResult{}, errors.New("root path must be absolute")
	}
	relPath, err := normalizeSVNTargetPath(relPath)
	if err != nil {
		return ActionResult{}, err
	}
	unlock := lockWorkingCopy(rootPath)
	defer unlock()
	operationCtx, cancel := operationContext(ctx)
	defer cancel()

	entries, err := statusEntriesForPath(operationCtx, rootPath, relPath)
	if err != nil {
		return ActionResult{}, err
	}
	item, _ := findStatusItem(rootPath, relPath, entries)
	if item == nil {
		return ActionResult{}, errors.New("no local changes to revert")
	}
	if item.Status == "??" {
		return ActionResult{}, errors.New("cannot revert an unversioned file")
	}
	args := []string{"revert"}
	if item.IsDir && item.Status == "M" {
		args = append(args, "--depth", "empty")
	}
	args = append(args, "--", svnPathArg(filepath.FromSlash(relPath)))
	output, err := runSVN(operationCtx, rootPath, args...)
	if err != nil {
		return ActionResult{}, err
	}
	invalidateInfoCache()
	status, err := InspectStatus(ctx, rootPath)
	if err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		Output: strings.TrimSpace(decodeSVNText(output, ".txt")),
		Status: status,
	}, nil
}

// Resolve marks a conflicted path as resolved while keeping its current
// working-copy contents.
func Resolve(ctx context.Context, rootPath, relPath string) (ActionResult, error) {
	rootPath = filepath.Clean(strings.TrimSpace(rootPath))
	if rootPath == "" || !filepath.IsAbs(rootPath) {
		return ActionResult{}, errors.New("root path must be absolute")
	}
	relPath, err := normalizeSVNTargetPath(relPath)
	if err != nil {
		return ActionResult{}, err
	}
	unlock := lockWorkingCopy(rootPath)
	defer unlock()
	operationCtx, cancel := operationContext(ctx)
	defer cancel()

	entries, err := statusEntriesForPath(operationCtx, rootPath, relPath)
	if err != nil {
		return ActionResult{}, err
	}
	item, _ := findStatusItem(rootPath, relPath, entries)
	if item == nil || (!item.Conflicted && item.Status != "C") {
		return ActionResult{}, errors.New("path has no conflicts to resolve")
	}
	output, err := runSVN(operationCtx, rootPath, "resolve", "--accept", "working", "--", svnPathArg(filepath.FromSlash(relPath)))
	if err != nil {
		return ActionResult{}, err
	}
	status, err := InspectStatus(ctx, rootPath)
	if err != nil {
		return ActionResult{}, err
	}
	return ActionResult{
		Output: strings.TrimSpace(decodeSVNText(output, ".txt")),
		Status: status,
	}, nil
}

func operationContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if _, ok := ctx.Deadline(); ok {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, operationSVNTimeout)
}
