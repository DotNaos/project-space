package projectspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func projectsRoot() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "projects")
}

func stateFile() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".project-space", "projects.json")
}

func loadDiscovery() map[string]any {
	root := projectsRoot()
	entries, _ := os.ReadDir(root)
	groups := []map[string]any{}
	projects := []map[string]any{}
	rootItems := []map[string]any{}

	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		path := filepath.Join(root, entry.Name())
		children := discoverChildren(root, path)
		if len(children) > 0 && !isProject(path) {
			groupID := nodeID(root, path)
			childIDs := []string{}
			for _, child := range children {
				child["groupId"] = groupID
				childIDs = append(childIDs, child["id"].(string))
				projects = append(projects, child)
			}
			groups = append(groups, map[string]any{
				"id":              groupID,
				"name":            entry.Name(),
				"rootPath":        path,
				"childProjectIds": childIDs,
			})
			rootItems = append(rootItems, map[string]any{
				"id":      groupID,
				"kind":    "group",
				"label":   entry.Name(),
				"groupId": groupID,
			})
			continue
		}
		if isProject(path) {
			project := projectRecord(root, path, "")
			projects = append(projects, project)
			rootItems = append(rootItems, map[string]any{
				"id":        project["id"],
				"kind":      "project",
				"label":     project["name"],
				"projectId": project["id"],
			})
		}
	}

	return map[string]any{
		"rootPath":  root,
		"groups":    groups,
		"projects":  projects,
		"rootItems": rootItems,
	}
}

func discoverChildren(root string, groupPath string) []map[string]any {
	entries, _ := os.ReadDir(groupPath)
	projects := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") {
			path := filepath.Join(groupPath, entry.Name())
			if isProject(path) {
				projects = append(projects, projectRecord(root, path, ""))
			}
		}
	}
	sort.Slice(projects, func(left, right int) bool {
		return projects[left]["name"].(string) < projects[right]["name"].(string)
	})
	return projects
}

func isProject(path string) bool {
	markers := []string{".git", "package.json", "bun.lock", "pnpm-lock.yaml", "Cargo.toml", "go.mod", "pyproject.toml"}
	for _, marker := range markers {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

func projectRecord(root string, path string, groupID string) map[string]any {
	kind := "standalone"
	if hasWorkspaceMarker(path) {
		kind = "workspace"
	}
	record := map[string]any{
		"id":       nodeID(root, path),
		"name":     filepath.Base(path),
		"rootPath": path,
		"kind":     kind,
	}
	if groupID != "" {
		record["groupId"] = groupID
	}
	return record
}

func hasWorkspaceMarker(path string) bool {
	if _, err := os.Stat(filepath.Join(path, "base")); err == nil {
		return true
	}
	entries, _ := os.ReadDir(path)
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".code-workspace") {
			return true
		}
	}
	return false
}

func nodeID(root string, path string) string {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == "." {
		return filepath.Base(path)
	}
	return strings.NewReplacer("/", "__", "\\", "__").Replace(relative)
}

func loadState() map[string]any {
	data, err := os.ReadFile(stateFile())
	if err == nil {
		var value map[string]any
		if json.Unmarshal(data, &value) == nil {
			return value
		}
	}
	return map[string]any{
		"activeGroupId":          "",
		"selectedProjectId":      "",
		"selectedLauncherAppId":  "",
		"selectedExplorerTarget": map[string]any{"kind": "workspace"},
	}
}

func saveState(value map[string]any) error {
	path := stateFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func worktrees(projectPath string) []map[string]any {
	result := run("git", "-C", projectPath, "worktree", "list", "--porcelain")
	if result.ExitCode != 0 {
		return []map[string]any{{
			"id":         "workspace",
			"name":       filepath.Base(projectPath),
			"path":       projectPath,
			"isBase":     true,
			"status":     "ready",
			"branchName": "",
		}}
	}
	records := []map[string]any{}
	current := map[string]any{}
	for _, line := range lines(result.Stdout) {
		key, value, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		switch key {
		case "worktree":
			if len(current) > 0 {
				records = append(records, finalizeWorktree(projectPath, current, len(records) == 0))
			}
			current = map[string]any{"path": value}
		case "branch":
			current["branchName"] = strings.TrimPrefix(value, "refs/heads/")
		}
	}
	if len(current) > 0 {
		records = append(records, finalizeWorktree(projectPath, current, len(records) == 0))
	}
	return records
}

func finalizeWorktree(projectPath string, value map[string]any, isBase bool) map[string]any {
	path := value["path"].(string)
	name := filepath.Base(path)
	if isBase {
		name = filepath.Base(projectPath)
	}
	value["id"] = nodeID(filepath.Dir(projectPath), path)
	value["name"] = name
	value["isBase"] = isBase
	value["status"] = "ready"
	return value
}
