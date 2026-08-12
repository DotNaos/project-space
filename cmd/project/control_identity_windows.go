//go:build windows

package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func loadControlGatewayIdentity(string) (controlGatewayIdentity, error) {
	return controlGatewayIdentity{}, fmt.Errorf("the SSH control gateway target is unavailable in the native Windows CLI")
}

func newControlGatewayInstallIdentityCommand() *cobra.Command {
	command := &cobra.Command{
		Use: "install-identity", Short: "Install the root-owned Environment identity binding", Args: cobra.NoArgs,
		RunE: func(*cobra.Command, []string) error {
			return fmt.Errorf("the SSH control gateway target is unavailable in the native Windows CLI")
		},
	}
	command.Flags().String("environment-id", "", "exact Environment Instance UUID")
	command.Flags().String("target-identity-revision", "", "exact inventory identity revision")
	command.Flags().Bool("replace", false, "replace a different installed identity")
	command.Flags().StringArray("workspace", nil, "trusted Workspace binding as ws_id=/absolute/path")
	return command
}
