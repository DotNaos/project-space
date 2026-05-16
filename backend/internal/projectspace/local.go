package projectspace

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func readDirectory(path string) []map[string]any {
	entries, _ := os.ReadDir(path)
	values := []map[string]any{}
	for _, entry := range entries {
		kind := "file"
		if entry.IsDir() {
			kind = "directory"
		}
		values = append(values, map[string]any{
			"name": entry.Name(),
			"path": filepath.Join(path, entry.Name()),
			"kind": kind,
		})
	}
	return values
}

func launcherApps() []map[string]any {
	apps := []map[string]string{
		{"id": "finder", "label": "Finder", "appName": "Finder"},
		{"id": "terminal", "label": "Terminal", "appName": "Terminal"},
		{"id": "ghostty", "label": "Ghostty", "appName": "Ghostty"},
		{"id": "cursor", "label": "Cursor", "appName": "Cursor"},
		{"id": "vscode-insiders", "label": "VS Code Insiders", "appName": "Visual Studio Code - Insiders"},
		{"id": "xcode", "label": "Xcode", "appName": "Xcode"},
		{"id": "codex", "label": "Codex", "appName": "Codex"},
	}
	values := []map[string]any{}
	for _, app := range apps {
		values = append(values, map[string]any{
			"id":      app["id"],
			"label":   app["label"],
			"appName": app["appName"],
		})
	}
	return values
}

func openPath(appID string, path string) map[string]any {
	appName := appID
	for _, app := range launcherApps() {
		if app["id"] == appID {
			appName = app["appName"].(string)
		}
	}
	if runtime.GOOS != "darwin" {
		return actionError("Opening apps is implemented for macOS first.")
	}
	result := run("open", "-a", appName, path)
	if result.ExitCode != 0 {
		return actionError(strings.TrimSpace(result.Stderr))
	}
	return actionOK("Opened target.")
}

func codexStatus() map[string]any {
	home, _ := os.UserHomeDir()
	cliPath, cliAvailable := commandExists("codex")
	appPath := "/Applications/Codex.app"
	_, appErr := os.Stat(appPath)
	origin := os.Getenv("PROJECT_SPACE_CODEX_APP_SERVER_URL")
	if origin == "" {
		origin = os.Getenv("CODEX_APP_SERVER_URL")
	}
	return map[string]any{
		"appInstalled":       appErr == nil,
		"appPath":            appPath,
		"appServerOrigin":    origin,
		"appServerReachable": false,
		"cliAvailable":       cliAvailable,
		"cliPath":            cliPath,
		"codexHome":          getenv("CODEX_HOME", filepath.Join(home, ".codex")),
		"configPath":         filepath.Join(getenv("CODEX_HOME", filepath.Join(home, ".codex")), "config.toml"),
		"currentThreadId":    os.Getenv("CODEX_THREAD_ID"),
		"skillsPath":         filepath.Join(home, ".codex", "skills"),
	}
}

func openCodexTarget(cwd string) map[string]any {
	if runtime.GOOS != "darwin" {
		return actionError("Codex app opening is implemented for macOS first.")
	}
	result := run("open", "-a", "Codex", cwd)
	if result.ExitCode != 0 {
		return actionError(strings.TrimSpace(result.Stderr))
	}
	return actionOK("Opened Codex target.")
}

func openCodexSkills() map[string]any {
	home, _ := os.UserHomeDir()
	return openPath("finder", filepath.Join(home, ".codex", "skills"))
}

func connectorOverview() map[string]any {
	home, _ := os.UserHomeDir()
	machinesPath := filepath.Join(home, "projects", "machines")
	_, machinesErr := os.Stat(machinesPath)
	tailscale := run("tailscale", "status", "--json")
	installed := tailscale.ExitCode == 0
	return map[string]any{
		"connectorOrigin": os.Getenv("PROJECT_SPACE_CONNECTOR_ORIGIN"),
		"machines":        []map[string]any{},
		"machinesRepo": map[string]any{
			"exists": machinesErr == nil,
			"path":   machinesPath,
		},
		"tailscale": map[string]any{
			"connected":    installed,
			"installed":    installed,
			"ips":          []string{},
			"peersOnline":  0,
			"serveOrigins": []string{},
		},
	}
}

func platformOverview() map[string]any {
	home, _ := os.UserHomeDir()
	path := filepath.Join(home, "projects", "private-vps-platform")
	_, err := os.Stat(path)
	return map[string]any{
		"apiReachable": false,
		"deployments":  []map[string]any{},
		"backups":      []map[string]any{},
		"platformRepo": map[string]any{
			"exists": err == nil,
			"path":   path,
		},
		"error": "Private VPS platform API not configured in the Go runtime yet.",
	}
}

func launcherIcon(appID string) string {
	if appID == "" {
		return ""
	}
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#121826"/><path d="M18 42h28M20 23h24M20 32h18" stroke="#78dcca" stroke-width="5" stroke-linecap="round"/></svg>`
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
}

func runTerminal(cwd string, command string) map[string]any {
	start := time.Now()
	result := shell(cwd, command)
	return map[string]any{
		"command":    command,
		"cwd":        cwd,
		"exitCode":   result.ExitCode,
		"durationMs": time.Since(start).Milliseconds(),
		"stdout":     result.Stdout,
		"stderr":     result.Stderr,
	}
}

func actionOK(message string) map[string]any {
	return map[string]any{"status": "success", "message": message}
}

func actionError(message string) map[string]any {
	if message == "" {
		message = "Action failed."
	}
	return map[string]any{"status": "error", "message": message}
}
