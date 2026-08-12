package workspacesession

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"unicode/utf8"
)

func summarizeGitStatus(output []byte) (gitStatusSummary, error) {
	result := gitStatusSummary{Clean: true}
	for _, record := range bytes.Split(output, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		if len(record) < 3 || record[2] != ' ' {
			return gitStatusSummary{}, fmt.Errorf("invalid git status output")
		}
		result.Clean = false
		if result.Staged+result.Unstaged+result.Untracked+result.Conflicted >= controlSummaryLimit {
			result.Truncated = true
			continue
		}
		x, y := record[0], record[1]
		if x == '?' && y == '?' {
			result.Untracked++
			continue
		}
		if map[string]bool{"DD": true, "AU": true, "UD": true, "UA": true, "DU": true, "AA": true, "UU": true}[string([]byte{x, y})] {
			result.Conflicted++
			continue
		}
		if x != ' ' {
			result.Staged++
		}
		if y != ' ' {
			result.Unstaged++
		}
	}
	return result, nil
}

func summarizeGitDiff(output []byte, staged bool) (gitDiffSummary, error) {
	result := gitDiffSummary{Staged: staged}
	for _, record := range bytes.Split(output, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		fields := bytes.SplitN(record, []byte{'\t'}, 3)
		if len(fields) != 3 {
			return gitDiffSummary{}, fmt.Errorf("invalid git diff output")
		}
		if result.ChangedFiles >= controlSummaryLimit {
			result.Truncated = true
			continue
		}
		result.ChangedFiles++
		if string(fields[0]) == "-" || string(fields[1]) == "-" {
			result.BinaryFiles++
			continue
		}
		var added, deleted int
		if _, err := fmt.Sscanf(string(fields[0]), "%d", &added); err != nil {
			return gitDiffSummary{}, fmt.Errorf("invalid git diff output")
		}
		if _, err := fmt.Sscanf(string(fields[1]), "%d", &deleted); err != nil {
			return gitDiffSummary{}, fmt.Errorf("invalid git diff output")
		}
		result.AddedLines += added
		result.DeletedLines += deleted
	}
	return result, nil
}

func summarizeWorktrees(output []byte, currentPath string) (worktreeSummary, error) {
	result := worktreeSummary{}
	for _, block := range bytes.Split(output, []byte{0, 0}) {
		if len(block) == 0 {
			continue
		}
		if result.Total >= controlSummaryLimit {
			result.Truncated = true
			continue
		}
		fields := bytes.Split(block, []byte{0})
		if len(fields) == 0 || !bytes.HasPrefix(fields[0], []byte("worktree ")) {
			return worktreeSummary{}, fmt.Errorf("invalid git worktree output")
		}
		path := string(bytes.TrimPrefix(fields[0], []byte("worktree ")))
		if !utf8.ValidString(path) || !filepath.IsAbs(path) {
			return worktreeSummary{}, fmt.Errorf("invalid git worktree output")
		}
		canonical, err := canonicalControlWorkspace(path)
		if err == nil && canonical == currentPath {
			result.Current++
		}
		result.Total++
		for _, field := range fields[1:] {
			switch {
			case bytes.Equal(field, []byte("detached")):
				result.Detached++
			case bytes.Equal(field, []byte("locked")), bytes.HasPrefix(field, []byte("locked ")):
				result.Locked++
			case bytes.Equal(field, []byte("prunable")), bytes.HasPrefix(field, []byte("prunable ")):
				result.Prunable++
			}
		}
	}
	return result, nil
}

func (receiver *controlReceiver) summarizeDevServers() (devServerSummary, error) {
	encoded, err := readProtected(receiver.bootstrap.StatePath, 64*1024)
	if err != nil {
		return devServerSummary{}, err
	}
	var document map[string]json.RawMessage
	if json.Unmarshal(encoded, &document) != nil || !exactJSONKeys(document, []string{"devServers", "lifecycleState"}) {
		return devServerSummary{}, fmt.Errorf("invalid Workspace Runtime dev server state")
	}
	var servers []map[string]json.RawMessage
	if json.Unmarshal(document["devServers"], &servers) != nil || len(servers) > 32 {
		return devServerSummary{}, fmt.Errorf("invalid Workspace Runtime dev server state")
	}
	result := devServerSummary{Total: len(servers)}
	for _, raw := range servers {
		if !exactJSONKeysOptional(raw, []string{"name", "port", "state"}, []string{"url"}) {
			return devServerSummary{}, fmt.Errorf("invalid Workspace Runtime dev server state")
		}
		var server struct {
			Name  string `json:"name"`
			Port  int    `json:"port"`
			State string `json:"state"`
			URL   string `json:"url,omitempty"`
		}
		encodedServer, _ := json.Marshal(raw)
		if json.Unmarshal(encodedServer, &server) != nil || !controlDevServerNamePattern.MatchString(server.Name) ||
			server.Port < 1 || server.Port > 65535 || !oneOf(server.State, "starting", "ready", "stopped", "failed") ||
			(server.URL != "" && !safeControlURL(server.URL)) {
			return devServerSummary{}, fmt.Errorf("invalid Workspace Runtime dev server state")
		}
		switch server.State {
		case "starting":
			result.Starting++
		case "ready":
			result.Ready++
		case "stopped":
			result.Stopped++
		case "failed":
			result.Failed++
		}
	}
	return result, nil
}

func runBoundedControlCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Env = []string{
		"GIT_CONFIG_GLOBAL=" + os.DevNull, "GIT_CONFIG_NOSYSTEM=1", "GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "PATH=" + os.Getenv("PATH"),
	}
	output := &boundedControlBuffer{remaining: controlOutputLimit}
	command.Stdout = output
	command.Stderr = &boundedControlBuffer{remaining: 4096}
	if err := command.Run(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

type boundedControlBuffer struct {
	bytes.Buffer
	remaining int
}

func (buffer *boundedControlBuffer) Write(value []byte) (int, error) {
	if len(value) > buffer.remaining {
		return 0, fmt.Errorf("Workspace Runtime control output limit exceeded")
	}
	buffer.remaining -= len(value)
	return buffer.Buffer.Write(value)
}

func canonicalControlWorkspace(path string) (string, error) {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return "", fmt.Errorf("Workspace path is invalid")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("Workspace path is unavailable")
	}
	return filepath.Clean(resolved), nil
}
