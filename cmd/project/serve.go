//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

type projectServeOptions struct {
	AllowedHosts []string
	Format       string
	JSON         bool
	Script       string
}

type projectServeReconciler interface {
	Reconcile(context.Context) (projectrun.ServeCollectionResult, error)
}

func newServeCommand() *cobra.Command {
	return newServeCommandWithManager(defaultProjectManager)
}

func newServeCommandWithManager(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{}
	cmd := &cobra.Command{
		Use:   "serve [script] [directory]",
		Short: "Run a project script and expose it on this Tailnet",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			script, directory, err := resolveServeStartArguments(args)
			if err != nil {
				return err
			}
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			result, startErr := manager.Start(cmd.Context(), directory, script, options.AllowedHosts)
			if err := printServeResult(cmd, result, format); err != nil {
				return err
			}
			return startErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	cmd.Flags().StringArrayVar(&options.AllowedHosts, "allowed-host", nil, "explicit Vite host allowed to reach this session (repeatable)")
	cmd.AddCommand(newServeReconcileCommand(managerFactory))
	cmd.AddCommand(newServeListCommand())
	cmd.AddCommand(newServeStatusCommand(managerFactory))
	cmd.AddCommand(newServeStopCommand(managerFactory))
	return cmd
}

func newServeListCommand() *cobra.Command {
	options := projectServeOptions{}
	cmd := &cobra.Command{
		Use:               "list [directory]",
		Short:             "List trusted development servers configured by a repository",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			result, listErr := projectrun.ListServers(argumentOrCurrentDirectory(args), nil)
			if format == "json" {
				if err := printProjectRunJSON(cmd, result); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Configured project servers: %s\n", result.Directory)
				for _, server := range result.Servers {
					fmt.Fprintf(cmd.OutOrStdout(), "- %s: %s\n", server.ServerID, server.Label)
				}
			}
			return listErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	return cmd
}

func newServeReconcileCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{}
	cmd := &cobra.Command{
		Use:   "reconcile",
		Short: "Check managed project servers and clean stale sessions",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			reconciler, ok := manager.(projectServeReconciler)
			if !ok {
				return fmt.Errorf("project runtime does not support reconciliation")
			}
			result, reconcileErr := reconciler.Reconcile(cmd.Context())
			if err := printServeCollectionResult(cmd, result, format); err != nil {
				return err
			}
			return reconcileErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	return cmd
}

func newServeStatusCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{Script: "dev"}
	cmd := &cobra.Command{
		Use:               "status [directory]",
		Short:             "Inspect a managed project server",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			directory := "."
			if len(args) == 1 {
				directory = args[0]
			}
			if err := projectrun.ValidateScriptName(options.Script); err != nil {
				return err
			}
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			result, statusErr := manager.Status(cmd.Context(), directory, options.Script)
			if err := printServeResult(cmd, result, format); err != nil {
				return err
			}
			return statusErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	cmd.Flags().StringVar(&options.Script, "script", "dev", "configured script name")
	return cmd
}

func newServeStopCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{Script: "dev"}
	cmd := &cobra.Command{
		Use:               "stop [directory]",
		Short:             "Stop one managed project server",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			directory := "."
			if len(args) == 1 {
				directory = args[0]
			}
			if err := projectrun.ValidateScriptName(options.Script); err != nil {
				return err
			}
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			result, stopErr := manager.Stop(cmd.Context(), directory, options.Script)
			if err := printServeResult(cmd, result, format); err != nil {
				return err
			}
			return stopErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	cmd.Flags().StringVar(&options.Script, "script", "dev", "configured script name")
	return cmd
}

func bindServeOutputFlags(cmd *cobra.Command, options *projectServeOptions) {
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	cmd.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable JSON output")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
}

func resolveServeStartArguments(args []string) (string, string, error) {
	if len(args) == 0 {
		return "dev", ".", nil
	}
	if len(args) == 2 {
		if err := projectrun.ValidateScriptName(args[0]); err != nil {
			return "", "", err
		}
		return args[0], args[1], nil
	}
	if info, err := os.Stat(args[0]); err == nil && info.IsDir() {
		return "dev", args[0], nil
	}
	if err := projectrun.ValidateScriptName(args[0]); err != nil {
		return "", "", err
	}
	return args[0], ".", nil
}

func printServeResult(cmd *cobra.Command, result projectrun.ServeResult, format string) error {
	if format == "json" {
		return printProjectRunJSON(cmd, result)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Project server: %s\n", result.State)
	fmt.Fprintf(cmd.OutOrStdout(), "Script: %s\n", result.Script)
	fmt.Fprintf(cmd.OutOrStdout(), "Directory: %s\n", result.Directory)
	if result.LocalURL != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "Local: %s\n", *result.LocalURL)
	}
	if result.PublicURL != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "Tailscale: %s\n", *result.PublicURL)
	}
	if result.LastError != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "Error: %s\n", *result.LastError)
	}
	return nil
}

func printServeCollectionResult(
	cmd *cobra.Command,
	result projectrun.ServeCollectionResult,
	format string,
) error {
	if format == "json" {
		return printProjectRunJSON(cmd, result)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Reconciled project servers: %d\n", len(result.Sessions))
	fmt.Fprintf(cmd.OutOrStdout(), "Errors: %d\n", result.ErrorCount)
	for _, session := range result.Sessions {
		fmt.Fprintf(cmd.OutOrStdout(), "- %s (%s): %s\n", session.Directory, session.Script, session.State)
	}
	return nil
}
