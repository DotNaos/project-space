package main

import (
	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

func newReviewRouteHeartbeatCommand() *cobra.Command {
	return &cobra.Command{
		Use:    projectrun.ReviewRouteHeartbeatCommandName,
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return projectrun.RunReviewRouteHeartbeat(cmd.Context())
		},
	}
}
