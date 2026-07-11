package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

type projectRunOptions struct {
	Format string
	JSON   bool
}

type projectCommandManager interface {
	Run(context.Context, string, string, projectrun.Streams) (projectrun.RunResult, error)
	Start(context.Context, string, string, []string) (projectrun.ServeResult, error)
	Status(context.Context, string, string) (projectrun.ServeResult, error)
	Stop(context.Context, string, string) (projectrun.ServeResult, error)
}

type projectManagerFactory func() (projectCommandManager, error)

func defaultProjectManager() (projectCommandManager, error) {
	return projectrun.NewDefaultManager()
}

func newRunCommand() *cobra.Command {
	return newRunCommandWithManager(defaultProjectManager)
}

func newRunCommandWithManager(managerFactory projectManagerFactory) *cobra.Command {
	options := projectRunOptions{}
	cmd := &cobra.Command{
		Use:   "run <script> [directory]",
		Short: "Run a configured project script in the foreground",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := projectrun.ValidateScriptName(args[0]); err != nil {
				return err
			}
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			directory := "."
			if len(args) == 2 {
				directory = args[1]
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			streams := projectrun.Streams{
				Stdin: cmd.InOrStdin(), Stdout: cmd.OutOrStdout(), Stderr: cmd.ErrOrStderr(),
			}
			if format == "json" {
				streams.Stdout = cmd.ErrOrStderr()
			}
			result, runErr := manager.Run(cmd.Context(), directory, args[0], streams)
			if format == "json" {
				if err := printProjectRunJSON(cmd, result); err != nil {
					return err
				}
			}
			return runErr
		},
	}
	addProjectRunOutputFlags(cmd, &options)
	return cmd
}

func addProjectRunOutputFlags(cmd *cobra.Command, options *projectRunOptions) {
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	cmd.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable JSON output")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
}

func resolvedProjectRunFormat(format string, jsonOutput bool) (string, error) {
	if format != "pretty" && format != "json" {
		return "", fmt.Errorf("unknown format %q; use pretty or json", format)
	}
	if jsonOutput {
		return "json", nil
	}
	return format, nil
}

func printProjectRunJSON(cmd *cobra.Command, value any) error {
	encoder := json.NewEncoder(cmd.OutOrStdout())
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}
