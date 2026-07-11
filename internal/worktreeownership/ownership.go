package worktreeownership

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const ownerStateDirectory = "project-space"
const ownerStateFile = "codex-owner.json"

var threadIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Ownership string

const (
	OwnershipClaimed   Ownership = "claimed"
	OwnershipConfirmed Ownership = "confirmed"
)

type Options struct {
	Directory string
	ThreadID  string
	Now       func() time.Time
}

type Result struct {
	ClaimedAt    string
	Ownership    Ownership
	ThreadID     string
	WorktreePath string
}

type claimRecord struct {
	ClaimedAt string `json:"claimedAt"`
	ThreadID  string `json:"threadId"`
}

type OwnerConflictError struct {
	CurrentThreadID string
	OwnerThreadID   string
	WorktreePath    string
}

func (e *OwnerConflictError) Error() string {
	return fmt.Sprintf(
		"worktree %s belongs to Codex thread %s, not the current thread %s; create a new branch and worktree from origin/main, enter it, and run `project worktree prepare` there",
		e.WorktreePath,
		e.OwnerThreadID,
		e.CurrentThreadID,
	)
}

func Prepare(ctx context.Context, options Options) (Result, error) {
	threadID := strings.ToLower(strings.TrimSpace(options.ThreadID))
	if threadID == "" {
		return Result{}, errors.New("no persistent Codex thread is available; create or continue a persistent Codex task before claiming this worktree")
	}
	if !threadIDPattern.MatchString(threadID) {
		return Result{}, errors.New("CODEX_THREAD_ID is not a valid persistent Codex thread ID")
	}

	directory := options.Directory
	if directory == "" {
		var err error
		directory, err = os.Getwd()
		if err != nil {
			return Result{}, fmt.Errorf("resolve current directory: %w", err)
		}
	}

	worktreePath, err := git(ctx, directory, "rev-parse", "--show-toplevel")
	if err != nil {
		return Result{}, errors.New("current directory is not inside a Git worktree")
	}
	worktreePath, err = filepath.Abs(worktreePath)
	if err != nil {
		return Result{}, fmt.Errorf("resolve worktree path: %w", err)
	}

	gitDir, err := git(ctx, worktreePath, "rev-parse", "--path-format=absolute", "--git-dir")
	if err != nil {
		return Result{}, fmt.Errorf("resolve worktree Git directory: %w", err)
	}
	commonDir, err := git(ctx, worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return Result{}, fmt.Errorf("resolve shared Git directory: %w", err)
	}
	if samePath(gitDir, commonDir) {
		return Result{}, errors.New("the shared main worktree cannot be claimed; create a branch and linked worktree from origin/main, enter it, and run `project worktree prepare` there")
	}

	record, exists, err := readClaim(gitDir)
	if err != nil {
		return Result{}, err
	}
	if exists {
		return resultForRecord(record, threadID, worktreePath, OwnershipConfirmed)
	}

	if options.Now == nil {
		options.Now = time.Now
	}
	record = claimRecord{
		ClaimedAt: options.Now().UTC().Format(time.RFC3339),
		ThreadID:  threadID,
	}
	claimed, err := writeClaimAtomically(gitDir, record)
	if err != nil {
		return Result{}, err
	}
	if !claimed {
		record, exists, err = readClaim(gitDir)
		if err != nil {
			return Result{}, err
		}
		if !exists {
			return Result{}, errors.New("worktree ownership changed while it was being claimed; create a fresh worktree and try again")
		}
		return resultForRecord(record, threadID, worktreePath, OwnershipConfirmed)
	}

	return resultForRecord(record, threadID, worktreePath, OwnershipClaimed)
}

func git(ctx context.Context, directory string, args ...string) (string, error) {
	commandArgs := append([]string{"-C", directory}, args...)
	command := exec.CommandContext(ctx, "git", commandArgs...)
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), strings.TrimSpace(string(output)))
	}
	return strings.TrimSpace(string(output)), nil
}

func resultForRecord(record claimRecord, threadID string, worktreePath string, ownership Ownership) (Result, error) {
	if !strings.EqualFold(record.ThreadID, threadID) {
		return Result{}, &OwnerConflictError{
			CurrentThreadID: threadID,
			OwnerThreadID:   record.ThreadID,
			WorktreePath:    worktreePath,
		}
	}
	return Result{
		ClaimedAt:    record.ClaimedAt,
		Ownership:    ownership,
		ThreadID:     threadID,
		WorktreePath: worktreePath,
	}, nil
}

func readClaim(gitDirectory string) (claimRecord, bool, error) {
	path := claimPath(gitDirectory)
	contents, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return claimRecord{}, false, nil
	}
	if err != nil {
		return claimRecord{}, false, fmt.Errorf("read worktree ownership: %w", err)
	}
	var record claimRecord
	if err := json.Unmarshal(contents, &record); err != nil || strings.TrimSpace(record.ThreadID) == "" {
		return claimRecord{}, false, errors.New("worktree ownership metadata is invalid; create a fresh worktree instead of replacing it")
	}
	return record, true, nil
}

func writeClaimAtomically(gitDirectory string, record claimRecord) (bool, error) {
	directory := filepath.Join(gitDirectory, ownerStateDirectory)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return false, fmt.Errorf("create worktree ownership directory: %w", err)
	}
	contents, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return false, fmt.Errorf("encode worktree ownership: %w", err)
	}
	contents = append(contents, '\n')
	temporary, err := os.CreateTemp(directory, ".codex-owner-*.tmp")
	if err != nil {
		return false, fmt.Errorf("create temporary worktree ownership: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return false, fmt.Errorf("write temporary worktree ownership: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return false, fmt.Errorf("sync temporary worktree ownership: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return false, fmt.Errorf("close temporary worktree ownership: %w", err)
	}
	if err := os.Link(temporaryPath, claimPath(gitDirectory)); err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, fmt.Errorf("claim worktree ownership: %w", err)
	}
	return true, nil
}

func claimPath(gitDirectory string) string {
	return filepath.Join(gitDirectory, ownerStateDirectory, ownerStateFile)
}

func samePath(left string, right string) bool {
	leftPath, leftErr := filepath.EvalSymlinks(left)
	rightPath, rightErr := filepath.EvalSymlinks(right)
	if leftErr == nil {
		left = leftPath
	}
	if rightErr == nil {
		right = rightPath
	}
	return filepath.Clean(left) == filepath.Clean(right)
}
