//go:build windows

package main

import (
	"fmt"
	"io"
)

func controlOperations() []string {
	return []string{"status.v1"}
}

func executeWorkspaceRuntimeControl(
	io.Writer,
	controlGatewayIdentity,
	controlGatewayOperationRequest,
	func() (workspaceRuntimeManager, error),
) error {
	return fmt.Errorf("Workspace Runtime target operations are unavailable in the native Windows CLI")
}

func executeWorktreePrepareControl(
	io.Writer,
	controlGatewayIdentity,
	controlGatewayOperationRequest,
) error {
	return fmt.Errorf("worktree preparation is unavailable in the native Windows CLI")
}
