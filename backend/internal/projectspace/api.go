package projectspace

import (
	"fmt"
	"net/http"
	"runtime"
)

func registerAPI(mux *http.ServeMux, version string) {
	mux.HandleFunc("/api/", func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodOptions {
			writeJSON(response, http.StatusNoContent, map[string]any{})
			return
		}
		if err := handleAPI(response, request, version); err != nil {
			apiError(response, http.StatusInternalServerError, err)
		}
	})
}

func handleAPI(response http.ResponseWriter, request *http.Request, version string) error {
	path := request.URL.Path
	switch {
	case request.Method == http.MethodGet && path == "/api/health":
		writeJSON(response, http.StatusOK, map[string]any{"ok": true})
	case request.Method == http.MethodGet && path == "/api/app/meta":
		writeJSON(response, http.StatusOK, map[string]any{"name": "Project Space", "version": version, "platform": runtime.GOOS})
	case request.Method == http.MethodGet && path == "/api/projects/discovery":
		writeJSON(response, http.StatusOK, loadDiscovery())
	case request.Method == http.MethodGet && path == "/api/projects/state":
		writeJSON(response, http.StatusOK, loadState())
	case request.Method == http.MethodPut && path == "/api/projects/state":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		if err := saveState(payload); err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, map[string]any{})
	case request.Method == http.MethodGet && path == "/api/projects/worktrees":
		writeJSON(response, http.StatusOK, worktrees(request.URL.Query().Get("projectPath")))
	case request.Method == http.MethodPost && path == "/api/projects/select-directory":
		writeJSON(response, http.StatusOK, map[string]any{"canceled": true})
	case request.Method == http.MethodGet && path == "/api/filesystem/directory":
		writeJSON(response, http.StatusOK, readDirectory(request.URL.Query().Get("path")))
	case request.Method == http.MethodGet && path == "/api/launcher/apps":
		writeJSON(response, http.StatusOK, launcherApps())
	case request.Method == http.MethodPost && path == "/api/launcher/open-path":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, openPath(stringValue(payload, "appId"), stringValue(payload, "path")))
	case request.Method == http.MethodGet && launcherIconPath(path):
		writeJSON(response, http.StatusOK, map[string]any{"iconDataUrl": launcherIcon(path)})
	case request.Method == http.MethodGet && path == "/api/codex/status":
		writeJSON(response, http.StatusOK, codexStatus())
	case request.Method == http.MethodPost && path == "/api/codex/open-skills":
		writeJSON(response, http.StatusOK, openCodexSkills())
	case request.Method == http.MethodPost && path == "/api/codex/open-target":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, openCodexTarget(stringValue(payload, "cwd")))
	case request.Method == http.MethodGet && path == "/api/connectors/overview":
		writeJSON(response, http.StatusOK, connectorOverview())
	case request.Method == http.MethodGet && path == "/api/platform/overview":
		writeJSON(response, http.StatusOK, platformOverview())
	case request.Method == http.MethodPost && (path == "/api/platform/deploy-project" || path == "/api/platform/backup-project"):
		writeJSON(response, http.StatusOK, actionError("Private VPS platform actions are not wired in the Go runtime yet."))
	case request.Method == http.MethodPost && path == "/api/terminal/run":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, runTerminal(stringValue(payload, "cwd"), stringValue(payload, "command")))
	case request.Method == http.MethodGet && path == "/api/git/status":
		writeJSON(response, http.StatusOK, gitStatus(request.URL.Query().Get("cwd")))
	case request.Method == http.MethodPost && path == "/api/git/diff":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, gitDiff(payload))
	case request.Method == http.MethodPost && path == "/api/git/stage":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, gitStage(payload, true))
	case request.Method == http.MethodPost && path == "/api/git/unstage":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, gitStage(payload, false))
	case request.Method == http.MethodPost && path == "/api/git/commit":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, gitCommit(payload))
	case request.Method == http.MethodPost && path == "/api/workspace-tool/open":
		payload, err := readJSON[map[string]any](request)
		if err != nil {
			return err
		}
		writeJSON(response, http.StatusOK, openWorkspaceTool(payload))
	default:
		writeJSON(response, http.StatusNotFound, map[string]any{"error": "Route not found."})
	}
	return nil
}

func launcherIconPath(path string) bool {
	return len(path) > len("/api/launcher/apps//icon") &&
		path[:len("/api/launcher/apps/")] == "/api/launcher/apps/" &&
		path[len(path)-len("/icon"):] == "/icon"
}

func unexpectedRoute(method string, path string) error {
	return fmt.Errorf("unexpected route %s %s", method, path)
}
