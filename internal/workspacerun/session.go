package workspacerun

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
)

var runtimeSessionServerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func (manager *Manager) writeRuntimeSessionState(record runtimeRecord) error {
	path := filepath.Join(manager.store.generationHome(record.WorkspaceID, record.Generation), "runtime-session-dev-servers.json")
	type safeServer struct {
		Name  string  `json:"name"`
		Port  *int    `json:"port,omitempty"`
		State string  `json:"state"`
		URL   *string `json:"url,omitempty"`
	}
	servers := make([]safeServer, 0, len(record.DevServers))
	for _, server := range record.DevServers {
		if !runtimeSessionServerNamePattern.MatchString(server.Name) || server.LocalPort == nil ||
			*server.LocalPort < 1 || *server.LocalPort > 65535 {
			return fmt.Errorf("Runtime Session dev server evidence is invalid")
		}
		state := server.State
		if state == "running" || state == "local-only" {
			state = "ready"
		}
		if state != "starting" && state != "ready" && state != "stopped" && state != "failed" {
			return fmt.Errorf("Runtime Session dev server state is invalid")
		}
		if server.LocalURL != nil && !safeRuntimeSessionURL(*server.LocalURL) {
			return fmt.Errorf("Runtime Session dev server URL is invalid")
		}
		servers = append(servers, safeServer{Name: server.Name, Port: server.LocalPort, State: state, URL: server.LocalURL})
	}
	encoded, err := json.Marshal(servers)
	if err != nil {
		return fmt.Errorf("encode Runtime Session dev servers: %w", err)
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".runtime-session-dev-servers-*")
	if err != nil {
		return fmt.Errorf("write Runtime Session dev servers: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect Runtime Session dev servers: %w", err)
	}
	if _, err := temporary.Write(encoded); err != nil {
		temporary.Close()
		return fmt.Errorf("write Runtime Session dev servers: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("write Runtime Session dev servers: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish Runtime Session dev servers: %w", err)
	}
	return nil
}

func safeRuntimeSessionURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != "" &&
		parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == ""
}
