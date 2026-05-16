package main

import (
	"fmt"
	"os"

	"github.com/DotNaos/project-space/backend/internal/mcp"
	"github.com/DotNaos/project-space/backend/internal/projectspace"
	"github.com/DotNaos/project-space/backend/internal/secrets"
	"github.com/spf13/cobra"
)

const version = "0.3.0"

func main() {
	root := &cobra.Command{
		Use:     "project-space",
		Version: version,
		Short:   "Project Space local runtime",
	}
	root.RunE = func(cmd *cobra.Command, args []string) error {
		return projectspace.Serve(version)
	}

	root.AddCommand(&cobra.Command{
		Use:   "serve",
		Short: "Start the local HTTP runtime",
		RunE: func(cmd *cobra.Command, args []string) error {
			return projectspace.Serve(version)
		},
	})
	root.AddCommand(&cobra.Command{
		Use:   "health",
		Short: "Check the local runtime",
		RunE: func(cmd *cobra.Command, args []string) error {
			return projectspace.Health()
		},
	})
	root.AddCommand(&cobra.Command{
		Use:   "mcp",
		Short: "Run the Project Space MCP server over stdio",
		RunE: func(cmd *cobra.Command, args []string) error {
			return mcp.Serve(version)
		},
	})
	root.AddCommand(secrets.Command("Project Space Secrets"))

	if err := root.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
