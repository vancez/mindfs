package usecase

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"mindfs/server/internal/fs"
	"mindfs/server/internal/svnview"
)

type SvnStatusInput struct {
	RootID string
}

type SvnStatusOutput struct {
	Status svnview.StatusResult
}

type SvnDiffInput struct {
	RootID string
	Path   string
}

type SvnDiffOutput struct {
	Diff svnview.DiffResult
}

type SvnRelatedFileDiffInput struct {
	RootID   string
	RepoPath string
	Revision string
	Path     string
}

type SvnRelatedFileDiffOutput struct {
	Diff svnview.RelatedFileDiffResult
}

type SvnActionInput struct {
	RootID  string
	Message string
	Paths   []string
}

type SvnActionOutput struct {
	Output string
	Status svnview.StatusResult
}

type SvnRevertInput struct {
	RootID string
	Path   string
}

func (s *Service) SvnUpdate(ctx context.Context, in SvnActionInput) (SvnActionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnActionOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnActionOutput{}, err
	}
	result, err := svnview.Update(ctx, root.RootPath)
	if err != nil {
		return SvnActionOutput{}, err
	}
	return SvnActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) SvnCommit(ctx context.Context, in SvnActionInput) (SvnActionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnActionOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnActionOutput{}, err
	}
	result, err := svnview.CommitPaths(ctx, root.RootPath, in.Message, in.Paths)
	if err != nil {
		return SvnActionOutput{}, err
	}
	return SvnActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) SvnRevert(ctx context.Context, in SvnRevertInput) (SvnActionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnActionOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnActionOutput{}, err
	}
	path, err := svnTargetPath(root, in.Path)
	if err != nil {
		return SvnActionOutput{}, err
	}
	result, err := svnview.Revert(ctx, root.RootPath, path)
	if err != nil {
		return SvnActionOutput{}, err
	}
	return SvnActionOutput{Output: result.Output, Status: result.Status}, nil
}

func (s *Service) SvnResolve(ctx context.Context, in SvnRevertInput) (SvnActionOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnActionOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnActionOutput{}, err
	}
	path, err := svnTargetPath(root, in.Path)
	if err != nil {
		return SvnActionOutput{}, err
	}
	result, err := svnview.Resolve(ctx, root.RootPath, path)
	if err != nil {
		return SvnActionOutput{}, err
	}
	return SvnActionOutput{Output: result.Output, Status: result.Status}, nil
}

// svnTargetPath keeps "." as the working-copy root so root property changes
// (svn:externals/svn:ignore) can be diffed, reverted, and committed.
func svnTargetPath(root fs.RootInfo, raw string) (string, error) {
	if strings.TrimSpace(raw) == "." {
		return ".", nil
	}
	return root.NormalizePath(raw)
}

func (s *Service) GetSvnStatus(ctx context.Context, in SvnStatusInput) (SvnStatusOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnStatusOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnStatusOutput{}, err
	}
	status, err := svnview.InspectStatus(ctx, root.RootPath)
	if err != nil {
		return SvnStatusOutput{}, err
	}
	return SvnStatusOutput{Status: status}, nil
}

func (s *Service) GetSvnDiff(ctx context.Context, in SvnDiffInput) (SvnDiffOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnDiffOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnDiffOutput{}, err
	}
	if strings.TrimSpace(in.Path) == "" {
		return SvnDiffOutput{}, errors.New("path required")
	}
	path, err := svnTargetPath(root, in.Path)
	if err != nil {
		return SvnDiffOutput{}, err
	}
	diff, err := svnview.ReadDiff(ctx, root.RootPath, path)
	if err != nil {
		return SvnDiffOutput{}, err
	}
	var meta []fs.FileMetaEntry
	if value, metaErr := root.GetFileMeta(path); metaErr == nil {
		meta = value
	}
	diff.FileMeta = fillFileMetaSessionInfo(ctx, s, in.RootID, meta)
	return SvnDiffOutput{Diff: diff}, nil
}

func (s *Service) GetSvnRelatedFileDiff(ctx context.Context, in SvnRelatedFileDiffInput) (SvnRelatedFileDiffOutput, error) {
	if err := s.ensureRegistry(); err != nil {
		return SvnRelatedFileDiffOutput{}, err
	}
	root, err := s.Registry.GetRoot(in.RootID)
	if err != nil {
		return SvnRelatedFileDiffOutput{}, err
	}
	if strings.TrimSpace(in.Path) == "" {
		return SvnRelatedFileDiffOutput{}, errors.New("path required")
	}

	repoPath := strings.TrimSpace(in.RepoPath)
	rootLocal := false
	var relPath string
	if repoPath == "" {
		repoPath = root.RootPath
		rootLocal = true
	} else {
		if !filepath.IsAbs(repoPath) {
			return SvnRelatedFileDiffOutput{}, errors.New("repo path must be absolute")
		}
		repoPath = filepath.Clean(repoPath)
		// The caller controls repo_path. Restrict it to the managed root (or a
		// directory below it, such as an external working copy) so the
		// endpoint cannot read arbitrary working copies on the server.
		if !sameManagedDirPath(repoPath, root.RootPath) {
			rel, relErr := filepath.Rel(root.RootPath, repoPath)
			if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
				return SvnRelatedFileDiffOutput{}, errors.New("repo path must be inside the managed root")
			}
			if stat, statErr := os.Stat(repoPath); statErr != nil || !stat.IsDir() {
				return SvnRelatedFileDiffOutput{}, errors.New("repo path is not a directory")
			}
		} else {
			rootLocal = true
		}
	}

	if rootLocal {
		relPath, err = root.NormalizePath(in.Path)
		if err != nil {
			return SvnRelatedFileDiffOutput{}, err
		}
	} else {
		relPath, err = normalizeSvnRelatedPath(repoPath, in.Path)
		if err != nil {
			return SvnRelatedFileDiffOutput{}, err
		}
	}

	diff, err := svnview.ReadRelatedFileDiff(ctx, repoPath, in.Revision, relPath)
	if err != nil {
		return SvnRelatedFileDiffOutput{}, err
	}
	if rootLocal {
		var meta []fs.FileMetaEntry
		if value, metaErr := root.GetFileMeta(relPath); metaErr == nil {
			meta = value
		}
		diff.FileMeta = fillFileMetaSessionInfo(ctx, s, in.RootID, meta)
	}
	return SvnRelatedFileDiffOutput{Diff: diff}, nil
}

func normalizeSvnRelatedPath(repoPath, path string) (string, error) {
	path = strings.TrimSpace(strings.SplitN(path, "#", 2)[0])
	if path == "" {
		return "", errors.New("path required")
	}
	clean := filepath.Clean(path)
	if filepath.IsAbs(clean) {
		rel, err := filepath.Rel(repoPath, clean)
		if err != nil {
			return "", errors.New("invalid path")
		}
		clean = rel
	}
	if filepath.IsAbs(clean) || filepath.VolumeName(clean) != "" || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("invalid path")
	}
	return filepath.ToSlash(clean), nil
}
