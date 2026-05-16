package projectspace

import (
	"path/filepath"
	"strings"
)

func gitStatus(cwd string) map[string]any {
	root := run("git", "-C", cwd, "rev-parse", "--show-toplevel")
	if root.ExitCode != 0 {
		return map[string]any{
			"isRepository":   false,
			"repositoryRoot": cwd,
			"branchName":     "",
			"entries":        []map[string]any{},
			"summary":        map[string]any{"changed": 0, "staged": 0, "untracked": 0},
		}
	}
	branch := strings.TrimSpace(run("git", "-C", cwd, "branch", "--show-current").Stdout)
	porcelain := run("git", "-C", cwd, "status", "--short")
	entries := []map[string]any{}
	staged := 0
	untracked := 0
	for _, line := range lines(porcelain.Stdout) {
		if len(line) < 4 {
			continue
		}
		indexStatus := strings.TrimSpace(line[:1])
		worktreeStatus := strings.TrimSpace(line[1:2])
		path := strings.TrimSpace(line[3:])
		if strings.Contains(path, " -> ") {
			parts := strings.Split(path, " -> ")
			path = parts[len(parts)-1]
		}
		if indexStatus != "" && indexStatus != "?" {
			staged++
		}
		if indexStatus == "?" || worktreeStatus != "" {
			untracked++
		}
		entries = append(entries, map[string]any{
			"path":           path,
			"indexStatus":    indexStatus,
			"worktreeStatus": worktreeStatus,
			"displayStatus":  strings.TrimSpace(line[:2]),
		})
	}
	return map[string]any{
		"isRepository":   true,
		"repositoryRoot": strings.TrimSpace(root.Stdout),
		"branchName":     branch,
		"entries":        entries,
		"summary": map[string]any{
			"changed":   len(entries),
			"staged":    staged,
			"untracked": untracked,
		},
	}
}

func gitDiff(request map[string]any) map[string]any {
	cwd := stringValue(request, "cwd")
	path := stringValue(request, "path")
	staged := boolValue(request, "staged")
	args := []string{"-C", cwd, "diff"}
	if staged {
		args = append(args, "--staged")
	}
	if path != "" {
		args = append(args, "--", path)
	}
	result := run("git", args...)
	return map[string]any{"diff": result.Stdout, "path": path, "staged": staged}
}

func gitStage(request map[string]any, staged bool) map[string]any {
	cwd := stringValue(request, "cwd")
	paths := stringSlice(request["paths"])
	if len(paths) == 0 {
		return actionError("No paths selected.")
	}
	args := []string{"-C", cwd}
	if staged {
		args = append(args, "add", "--")
	} else {
		args = append(args, "restore", "--staged", "--")
	}
	args = append(args, paths...)
	result := run("git", args...)
	if result.ExitCode != 0 {
		return actionError(result.Stderr)
	}
	return actionOK("Updated git index.")
}

func gitCommit(request map[string]any) map[string]any {
	cwd := stringValue(request, "cwd")
	message := stringValue(request, "message")
	if strings.TrimSpace(message) == "" {
		return actionError("Commit message is required.")
	}
	result := run("git", "-C", cwd, "commit", "-m", message)
	if result.ExitCode != 0 {
		return actionError(result.Stderr)
	}
	return map[string]any{
		"status":  "success",
		"message": "Committed changes.",
		"stdout":  result.Stdout,
		"stderr":  result.Stderr,
	}
}

func openWorkspaceTool(request map[string]any) map[string]any {
	tool := stringValue(request, "tool")
	projectID := stringValue(request, "projectId")
	if tool == "" {
		return map[string]any{"status": "placeholder", "message": "No tool selected."}
	}
	return map[string]any{
		"status":  "placeholder",
		"message": "Tool launch is routed through launcher app actions in the Go runtime. Requested " + tool + " for " + filepath.Base(projectID) + ".",
	}
}

func stringValue(value map[string]any, key string) string {
	if item, ok := value[key].(string); ok {
		return item
	}
	return ""
}

func boolValue(value map[string]any, key string) bool {
	if item, ok := value[key].(bool); ok {
		return item
	}
	return false
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	values := []string{}
	for _, item := range items {
		if text, ok := item.(string); ok {
			values = append(values, text)
		}
	}
	return values
}
