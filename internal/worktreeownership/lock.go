package worktreeownership

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

const ownershipLockTimeout = 2 * time.Minute

func withOwnershipLock(path string, action func() error) (returnErr error) {
	commonDirectory, err := git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return fmt.Errorf("find shared Git metadata: %w", err)
	}
	lockPath := filepath.Join(strings.TrimSpace(commonDirectory), "project-space", "worktree-ownership.lock")
	if err := os.MkdirAll(filepath.Dir(lockPath), 0o700); err != nil {
		return fmt.Errorf("create worktree ownership lock directory: %w", err)
	}

	fileLock := flock.New(lockPath, flock.SetPermissions(0o600))
	ctx, cancel := context.WithTimeout(context.Background(), ownershipLockTimeout)
	defer cancel()
	locked, err := fileLock.TryLockContext(ctx, 25*time.Millisecond)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return ownershipLockTimeoutError()
		}
		return fmt.Errorf("lock worktree ownership: %w", err)
	}
	if !locked {
		return ownershipLockTimeoutError()
	}
	defer func() {
		if err := fileLock.Unlock(); returnErr == nil && err != nil {
			returnErr = fmt.Errorf("unlock worktree ownership: %w", err)
		}
	}()
	return action()
}

func ownershipLockTimeoutError() error {
	return fmt.Errorf("another worktree ownership operation did not finish within %s; retry the command", ownershipLockTimeout)
}
