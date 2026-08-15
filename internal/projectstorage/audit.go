package projectstorage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Entry struct {
	Branch    string `json:"branch,omitempty"`
	Bytes     int64  `json:"bytes,omitempty"`
	Error     string `json:"error,omitempty"`
	HeadSHA   string `json:"headSha,omitempty"`
	ID        string `json:"id"`
	IsMain    bool   `json:"isMain"`
	Kind      string `json:"kind"`
	Path      string `json:"path"`
	SizeState string `json:"sizeState"`
}

type Report struct {
	CheckedAt     string  `json:"checkedAt"`
	Complete      bool    `json:"complete"`
	MainBytes     int64   `json:"mainBytes"`
	Path          string  `json:"path"`
	ProjectID     string  `json:"projectId"`
	Repository    string  `json:"repository"`
	SchemaVersion int     `json:"schemaVersion"`
	TotalBytes    int64   `json:"totalBytes"`
	WorktreeBytes int64   `json:"worktreeBytes"`
	Worktrees     []Entry `json:"worktrees"`
}

type Meter func(context.Context, string) (int64, error)

type Options struct {
	Meter Meter
	Now   func() time.Time
}

func zeroMeter(context.Context, string) (int64, error) { return 0, nil }

func measureOne(ctx context.Context, path string, meter Meter) (int64, error) {
	if meter == nil {
		meter = allocatedBytes
	}
	return meter(ctx, path)
}

type porcelainEntry struct {
	branch  string
	headSHA string
	path    string
}

func Audit(ctx context.Context, projectID, repository, projectPath string, options Options) (Report, error) {
	if strings.TrimSpace(projectID) == "" || strings.TrimSpace(repository) == "" {
		return Report{}, errors.New("project identity is required")
	}
	canonical, err := filepath.EvalSymlinks(projectPath)
	if err != nil {
		return Report{}, fmt.Errorf("resolve project checkout: %w", err)
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return Report{}, fmt.Errorf("resolve project checkout: %w", err)
	}
	commonDir, err := git(ctx, canonical, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Report{}, fmt.Errorf("find shared Git metadata: %w", err)
	}
	commonDir = filepath.Clean(strings.TrimSpace(commonDir))
	mainPath := filepath.Dir(commonDir)
	if filepath.Base(commonDir) != ".git" {
		return Report{}, errors.New("repository uses an unsupported external Git directory")
	}
	output, err := git(ctx, canonical, "worktree", "list", "--porcelain", "-z")
	if err != nil {
		return Report{}, fmt.Errorf("list registered worktrees: %w", err)
	}
	parsed, err := parsePorcelain(output)
	if err != nil {
		return Report{}, err
	}
	keys := registrationKeys(commonDir)
	meter := options.Meter
	if meter == nil {
		meter = allocatedBytes
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	entries := make([]Entry, len(parsed))
	semaphore := make(chan struct{}, 4)
	var group sync.WaitGroup
	for index, candidate := range parsed {
		index, candidate := index, candidate
		group.Add(1)
		go func() {
			defer group.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			resolved := filepath.Clean(candidate.path)
			isMain := samePath(resolved, mainPath)
			key := keys[resolved]
			if isMain {
				key = "main"
			}
			entry := Entry{
				Branch: candidate.branch, HeadSHA: candidate.headSHA,
				ID: worktreeID(commonDir, key, resolved), IsMain: isMain,
				Kind: classify(mainPath, resolved, isMain), Path: resolved,
				SizeState: "measuring",
			}
			bytes, measureErr := meter(ctx, resolved)
			if measureErr != nil {
				entry.SizeState = "unavailable"
				entry.Error = measureErr.Error()
			} else {
				entry.Bytes = bytes
				entry.SizeState = "measured"
			}
			entries[index] = entry
		}()
	}
	group.Wait()
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsMain != entries[j].IsMain {
			return entries[i].IsMain
		}
		if entries[i].Bytes != entries[j].Bytes {
			return entries[i].Bytes > entries[j].Bytes
		}
		return entries[i].Path < entries[j].Path
	})
	report := Report{
		CheckedAt: now().UTC().Format(time.RFC3339Nano), Complete: true,
		Path: mainPath, ProjectID: projectID, Repository: repository,
		SchemaVersion: 1, Worktrees: entries,
	}
	for _, entry := range entries {
		if entry.SizeState != "measured" {
			report.Complete = false
			continue
		}
		report.TotalBytes += entry.Bytes
		if entry.IsMain {
			report.MainBytes += entry.Bytes
		} else {
			report.WorktreeBytes += entry.Bytes
		}
	}
	return report, nil
}

func parsePorcelain(output string) ([]porcelainEntry, error) {
	fields := strings.Split(output, "\x00")
	entries := make([]porcelainEntry, 0)
	current := porcelainEntry{}
	flush := func() error {
		if current.path == "" {
			return nil
		}
		if !filepath.IsAbs(current.path) {
			return fmt.Errorf("Git reported a non-absolute worktree path")
		}
		entries = append(entries, current)
		current = porcelainEntry{}
		return nil
	}
	for _, field := range fields {
		if field == "" {
			if err := flush(); err != nil {
				return nil, err
			}
			continue
		}
		for _, line := range strings.Split(field, "\n") {
			switch {
			case strings.HasPrefix(line, "worktree "):
				if current.path != "" {
					if err := flush(); err != nil {
						return nil, err
					}
				}
				current.path = strings.TrimPrefix(line, "worktree ")
			case strings.HasPrefix(line, "HEAD "):
				current.headSHA = strings.TrimPrefix(line, "HEAD ")
			case strings.HasPrefix(line, "branch refs/heads/"):
				current.branch = strings.TrimPrefix(line, "branch refs/heads/")
			}
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, errors.New("Git returned no registered worktrees")
	}
	return entries, nil
}

func registrationKeys(commonDir string) map[string]string {
	result := map[string]string{}
	children, err := os.ReadDir(filepath.Join(commonDir, "worktrees"))
	if err != nil {
		return result
	}
	for _, child := range children {
		if !child.IsDir() {
			continue
		}
		contents, readErr := os.ReadFile(filepath.Join(commonDir, "worktrees", child.Name(), "gitdir"))
		if readErr != nil {
			continue
		}
		pointer := strings.TrimSpace(string(contents))
		if !filepath.IsAbs(pointer) {
			pointer = filepath.Join(commonDir, "worktrees", child.Name(), pointer)
		}
		result[filepath.Clean(filepath.Dir(pointer))] = child.Name()
	}
	return result
}

func worktreeID(commonDir, key, path string) string {
	if key == "" {
		key = "unavailable:" + filepath.Clean(path)
	}
	digest := sha256.Sum256([]byte(filepath.Clean(commonDir) + "\x00" + key))
	return "wt_" + hex.EncodeToString(digest[:])[:24]
}

func classify(mainPath, candidate string, isMain bool) string {
	if isMain || inside(filepath.Join(filepath.Dir(mainPath), ".worktrees", filepath.Base(mainPath)), candidate) {
		return "project-managed"
	}
	if strings.Contains(candidate, string(filepath.Separator)+".codex-worktrees"+string(filepath.Separator)) ||
		strings.Contains(candidate, string(filepath.Separator)+".codex"+string(filepath.Separator)+"worktrees"+string(filepath.Separator)) {
		return "codex"
	}
	return "external"
}

func inside(parent, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	return err == nil && relative != "." && relative != ".." &&
		!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func samePath(left, right string) bool {
	return filepath.Clean(left) == filepath.Clean(right)
}

func allocatedBytes(ctx context.Context, path string) (int64, error) {
	command := exec.CommandContext(ctx, "du", "-sk", "-x", path)
	output, err := command.Output()
	if err != nil {
		return 0, fmt.Errorf("measure allocated storage: %w", err)
	}
	fields := strings.Fields(string(output))
	if len(fields) < 1 {
		return 0, errors.New("measure allocated storage: empty response")
	}
	kibibytes, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil || kibibytes < 0 {
		return 0, errors.New("measure allocated storage: invalid response")
	}
	return kibibytes * 1024, nil
}

func git(ctx context.Context, path string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", append([]string{"-C", path}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return string(output), nil
}
