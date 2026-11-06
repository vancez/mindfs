package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"mindfs/server/internal/api/usecase"
)

const svnActionRequestLimit = 1 << 20

func respondSvnAction(w http.ResponseWriter, out usecase.SvnActionOutput, err error, code string) {
	if err != nil {
		respondJSON(w, http.StatusConflict, map[string]any{
			"error":   code,
			"message": err.Error(),
		})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"output": out.Output,
		"status": out.Status,
	})
}

func (h *HTTPHandler) handleSvnStatus(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	out, err := h.service().GetSvnStatus(r.Context(), usecase.SvnStatusInput{RootID: rootID})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Status)
}

func (h *HTTPHandler) handleSvnDiff(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	out, err := h.service().GetSvnDiff(r.Context(), usecase.SvnDiffInput{
		RootID: rootID,
		Path:   path,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Diff)
}

func (h *HTTPHandler) handleSvnUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID string `json:"root"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, svnActionRequestLimit)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	rootID := strings.TrimSpace(req.RootID)
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	out, err := h.service().SvnUpdate(r.Context(), usecase.SvnActionInput{RootID: rootID})
	respondSvnAction(w, out, err, "svn_update_failed")
}

func (h *HTTPHandler) handleSvnCommit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID  string   `json:"root"`
		Message string   `json:"message"`
		Paths   []string `json:"paths"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, svnActionRequestLimit)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	rootID := strings.TrimSpace(req.RootID)
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if len(req.Paths) > 10000 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("too many paths"))
		return
	}
	for _, path := range req.Paths {
		if len(path) > 4096 {
			respondError(w, http.StatusBadRequest, errInvalidRequest("path too long"))
			return
		}
	}
	if len(req.Message) > 1<<20 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("commit message too long"))
		return
	}
	out, err := h.service().SvnCommit(r.Context(), usecase.SvnActionInput{
		RootID:  rootID,
		Message: req.Message,
		Paths:   req.Paths,
	})
	respondSvnAction(w, out, err, "svn_commit_failed")
}

func (h *HTTPHandler) handleSvnRevert(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID string `json:"root"`
		Path   string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, svnActionRequestLimit)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	rootID := strings.TrimSpace(req.RootID)
	path := strings.TrimSpace(req.Path)
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if path == "" || len(path) > 4096 {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	out, err := h.service().SvnRevert(r.Context(), usecase.SvnRevertInput{
		RootID: rootID,
		Path:   path,
	})
	respondSvnAction(w, out, err, "svn_revert_failed")
}

func (h *HTTPHandler) handleSvnResolve(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootID string `json:"root"`
		Path   string `json:"path"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, svnActionRequestLimit)).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, errInvalidRequest("invalid json body"))
		return
	}
	rootID := strings.TrimSpace(req.RootID)
	path := strings.TrimSpace(req.Path)
	if rootID == "" || path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root and path required"))
		return
	}
	out, err := h.service().SvnResolve(r.Context(), usecase.SvnRevertInput{
		RootID: rootID,
		Path:   path,
	})
	respondSvnAction(w, out, err, "svn_resolve_failed")
}

func (h *HTTPHandler) handleSvnRelatedFileDiff(w http.ResponseWriter, r *http.Request) {
	rootID := strings.TrimSpace(r.URL.Query().Get("root"))
	repoPath := strings.TrimSpace(r.URL.Query().Get("repo_path"))
	revision := strings.TrimSpace(r.URL.Query().Get("revision"))
	if revision == "" {
		revision = strings.TrimSpace(r.URL.Query().Get("head"))
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if rootID == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("root required"))
		return
	}
	if path == "" {
		respondError(w, http.StatusBadRequest, errInvalidRequest("path required"))
		return
	}
	out, err := h.service().GetSvnRelatedFileDiff(r.Context(), usecase.SvnRelatedFileDiffInput{
		RootID:   rootID,
		RepoPath: repoPath,
		Revision: revision,
		Path:     path,
	})
	if err != nil {
		respondError(w, http.StatusBadRequest, err)
		return
	}
	respondJSON(w, http.StatusOK, out.Diff)
}
