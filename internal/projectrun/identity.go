package projectrun

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const serverIdentityVersion = "project-serve-v2"

var identitySegmentPattern = regexp.MustCompile(`[^a-z0-9]+`)

type ServerIdentity struct {
	RepositoryPath string
	WorktreePath   string
	ServerKey      string
	ServerID       string
	TmuxSession    string
}

type ServerIdentityResolver interface {
	Resolve(context.Context, string, string) (ServerIdentity, error)
}

type GitServerIdentityResolver struct {
	Run func(context.Context, string, ...string) (string, error)
}

func (resolver GitServerIdentityResolver) Resolve(
	ctx context.Context,
	worktreePath string,
	serverKey string,
) (ServerIdentity, error) {
	canonicalWorktree, err := canonicalDirectory(worktreePath)
	if err != nil {
		return ServerIdentity{}, err
	}
	run := resolver.Run
	if run == nil {
		run = runOutput
	}
	commonDirectory, err := run(
		ctx,
		"git",
		"-C",
		canonicalWorktree,
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	)
	if err != nil {
		return ServerIdentity{}, fmt.Errorf("resolve git common directory: %w", err)
	}
	repositoryPath, err := canonicalPath(strings.TrimSpace(commonDirectory))
	if err != nil {
		return ServerIdentity{}, fmt.Errorf("resolve git common directory: %w", err)
	}
	return newServerIdentity(repositoryPath, canonicalWorktree, serverKey), nil
}

func newServerIdentity(repositoryPath, worktreePath, serverKey string) ServerIdentity {
	payload := strings.Join([]string{
		serverIdentityVersion,
		repositoryPath,
		worktreePath,
		serverKey,
	}, "\x00")
	digest := sha256.Sum256([]byte(payload))
	suffix := hex.EncodeToString(digest[:6])
	repositoryName := filepath.Base(filepath.Dir(repositoryPath))
	if filepath.Base(repositoryPath) != ".git" {
		repositoryName = filepath.Base(repositoryPath)
	}
	prefix := identitySegment(repositoryName) + "-" + identitySegment(serverKey)
	serverID := "project-serve-" + prefix + "-" + suffix
	return ServerIdentity{
		RepositoryPath: repositoryPath,
		WorktreePath:   worktreePath,
		ServerKey:      serverKey,
		ServerID:       serverID,
		TmuxSession:    serverID,
	}
}

func canonicalPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%q is not a directory", resolved)
	}
	return filepath.Clean(resolved), nil
}

func identitySegment(value string) string {
	segment := strings.Trim(identitySegmentPattern.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if segment == "" {
		return "server"
	}
	if len(segment) > 24 {
		segment = segment[:24]
	}
	return strings.TrimRight(segment, "-")
}
