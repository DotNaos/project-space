package main

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/DotNaos/project-space/internal/worktreeownership"
)

var codexManagerThreadIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// requireProjectManagerStartContext is the local caller boundary for the
// mutating codex start operation. Remote task metadata is not caller proof:
// the checkout and current CODEX_THREAD_ID must establish the Manager role
// before any repository, credential, or HTTP work begins.
func requireProjectManagerStartContext(
	startPath string,
	threadID string,
	inspect func(string, string) (worktreeownership.CheckoutContext, error),
) error {
	threadID = strings.TrimSpace(threadID)
	if threadID == "" {
		return errors.New("project codex start requires the current CODEX_THREAD_ID")
	}
	if !codexManagerThreadIDPattern.MatchString(threadID) {
		return errors.New("project codex start requires a valid current CODEX_THREAD_ID")
	}
	if inspect == nil {
		return errors.New("project codex start cannot prove the local Project worktree context")
	}
	checkout, err := inspect(startPath, threadID)
	if err != nil {
		return fmt.Errorf("prove Project Manager checkout context: %w", err)
	}
	if checkout.State != "main" || checkout.Role != "project-manager" || checkout.MutatingAllowed ||
		strings.TrimSpace(checkout.CurrentThreadID) != threadID {
		return fmt.Errorf(
			"project codex start requires local state=main role=project-manager mutatingAllowed=false and the current CODEX_THREAD_ID to match; got state=%q role=%q mutatingAllowed=%t currentThreadID=%q",
			checkout.State, checkout.Role, checkout.MutatingAllowed, checkout.CurrentThreadID,
		)
	}
	return nil
}
