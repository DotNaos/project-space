package main

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"
)

const defaultConnectorProdHubURL = "https://projects.os-home.net"

func newConnectorCommand() *cobra.Command {
	var asJSON bool
	command := &cobra.Command{
		Use:          "connector",
		Short:        "Retired compatibility command",
		Args:         cobra.ArbitraryArgs,
		SilenceUsage: true,
		RunE: func(command *cobra.Command, _ []string) error {
			if asJSON {
				_ = json.NewEncoder(command.OutOrStdout()).Encode(map[string]string{
					"code":        "canonical_runtime_required",
					"error":       "The permanent Project Space Connector has been retired.",
					"replacement": "project environment bootstrap",
				})
			}
			return fmt.Errorf("canonical_runtime_required: the permanent Project Space Connector has been retired; use project environment bootstrap")
		},
	}
	command.Flags().BoolVar(&asJSON, "json", false, "print the retirement response as JSON")
	return command
}
