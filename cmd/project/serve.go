//go:build !windows

package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

type projectServeOptions struct {
	AllowedHosts []string
	Format       string
	JSON         bool
	LocalOnly    bool
	NoTailnet    bool
	Tailnet      bool
	APIs         string
	Data         string
	Script       string
	Configured   bool
	Follow       bool
	With         []string
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
		Short: "Run a project script with an explicit backend binding",
		Args:  cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if (options.LocalOnly || options.NoTailnet) && options.Tailnet {
				return fmt.Errorf("--no-tailnet cannot be combined with --tailnet")
			}
			script, directory, err := resolveServeStartArguments(args)
			if err != nil {
				return err
			}
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			apis, data, err := resolveServeBindings(options.APIs, options.Data)
			if err != nil {
				return err
			}
			if apis == projectrun.APIsModeExternal {
				return fmt.Errorf(
					"external APIs are reserved but secure 1Password service-account delivery is not configured yet",
				)
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			result, startErr := manager.StartWithOptions(cmd.Context(), directory, script, projectrun.StartOptions{
				AllowedHosts: options.AllowedHosts,
				LocalOnly:    options.LocalOnly || options.NoTailnet,
				APIs:         apis,
				Data:         data,
				With:         options.With,
			})
			if err := printServeResult(cmd, result, format); err != nil {
				return err
			}
			return startErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	cmd.Flags().StringArrayVar(&options.AllowedHosts, "allowed-host", nil, "explicit Vite host allowed to reach this session (repeatable)")
	cmd.Flags().BoolVar(&options.LocalOnly, "local-only", false, "deprecated alias for --no-tailnet")
	cmd.Flags().BoolVar(&options.NoTailnet, "no-tailnet", false, "keep the server on this machine instead of publishing it through Tailscale")
	cmd.Flags().BoolVar(&options.Tailnet, "tailnet", false, "publish through Tailscale (the default; retained for compatibility)")
	cmd.Flags().StringVar(&options.APIs, "apis", "simulated", "backend API binding: simulated or external")
	cmd.Flags().StringVar(&options.Data, "data", "local", "backend data binding: local or remote")
	cmd.Flags().StringArrayVar(&options.With, "with", nil, "use a local Node library worktree for this server (repeatable)")
	must(cmd.RegisterFlagCompletionFunc("apis", fixedValuesCompletion("simulated", "external")))
	must(cmd.RegisterFlagCompletionFunc("data", fixedValuesCompletion("local", "remote")))
	cmd.AddCommand(newServeReconcileCommand(managerFactory))
	cmd.AddCommand(newServeListCommand(managerFactory))
	cmd.AddCommand(newServeLogsCommand(managerFactory))
	cmd.AddCommand(newServeAttachCommand(managerFactory))
	cmd.AddCommand(newServePublishPullRequestCommand(managerFactory))
	cmd.AddCommand(newServeStatusCommand(managerFactory))
	cmd.AddCommand(newServeStopCommand(managerFactory))
	return cmd
}

func resolveServeBindings(apisValue, dataValue string) (projectrun.APIsMode, projectrun.DataMode, error) {
	apis := projectrun.APIsMode(apisValue)
	data := projectrun.DataMode(dataValue)
	if apis != projectrun.APIsModeSimulated && apis != projectrun.APIsModeExternal {
		return "", "", fmt.Errorf("unknown APIs binding %q; use simulated or external", apisValue)
	}
	if data != projectrun.DataModeLocal && data != projectrun.DataModeRemote {
		return "", "", fmt.Errorf("unknown data binding %q; use local or remote", dataValue)
	}
	if apis == projectrun.APIsModeSimulated && data == projectrun.DataModeRemote {
		return "", "", fmt.Errorf("--apis=simulated cannot be combined with --data=remote")
	}
	return apis, data, nil
}

func newServeListCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{}
	cmd := &cobra.Command{
		Use:               "list [directory]",
		Short:             "List managed project server sessions",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			if !options.Configured && len(args) > 0 {
				return fmt.Errorf("a directory is accepted only with --configured")
			}
			if options.Configured {
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
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			result, listErr := manager.ListSessions(cmd.Context())
			if format == "json" {
				if err := printProjectRunJSON(cmd, result); err != nil {
					return err
				}
			} else {
				fmt.Fprintf(cmd.OutOrStdout(), "Managed project servers: %d\n", len(result.Sessions))
				for _, session := range result.Sessions {
					fmt.Fprintf(cmd.OutOrStdout(), "- %s (%s): %s %s\n", session.Directory, session.Script, session.State, session.Mode)
				}
			}
			return listErr
		},
	}
	bindServeOutputFlags(cmd, &options)
	cmd.Flags().BoolVar(&options.Configured, "configured", false, "list declarations from one repository instead of runtime sessions")
	return cmd
}

func newServeLogsCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{Script: "dev"}
	cmd := &cobra.Command{
		Use:   "logs [directory]",
		Short: "Read the bounded log for one managed project server",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			access, err := manager.AccessSession(cmd.Context(), argumentOrCurrentDirectory(args), options.Script)
			if err != nil {
				return err
			}
			file, err := os.Open(access.LogPath)
			if err != nil {
				return fmt.Errorf("open managed server log: %w", err)
			}
			defer file.Close()
			if _, err := io.Copy(cmd.OutOrStdout(), file); err != nil {
				return err
			}
			if !options.Follow {
				return nil
			}
			follow := exec.CommandContext(cmd.Context(), "tail", "-f", access.LogPath)
			follow.Stdout, follow.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
			return follow.Run()
		},
	}
	cmd.Flags().StringVar(&options.Script, "script", "dev", "configured server name")
	cmd.Flags().BoolVar(&options.Follow, "follow", false, "continue streaming new log output")
	return cmd
}

func newServeAttachCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectServeOptions{Script: "dev"}
	cmd := &cobra.Command{
		Use:   "attach [directory]",
		Short: "Attach to the exact owned tmux session for one managed server",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !roadmapTerminalInteractive(cmd.InOrStdin(), cmd.OutOrStdout()) {
				return fmt.Errorf("project serve attach requires an interactive terminal")
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			access, err := manager.AccessSession(cmd.Context(), argumentOrCurrentDirectory(args), options.Script)
			if err != nil {
				return err
			}
			attach := exec.CommandContext(cmd.Context(), "tmux", "attach-session", "-t", access.Result.TmuxSession)
			attach.Stdin, attach.Stdout, attach.Stderr = cmd.InOrStdin(), cmd.OutOrStdout(), cmd.ErrOrStderr()
			return attach.Run()
		},
	}
	cmd.Flags().StringVar(&options.Script, "script", "dev", "configured server name")
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
	if result.Disposition != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Disposition: %s\n", result.Disposition)
	}
	if result.Mode != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Mode: %s\n", result.Mode)
	}
	if result.APIs != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "APIs: %s\n", result.APIs)
	}
	if result.Data != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Data: %s\n", result.Data)
	}
	if result.Secrets != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Secrets: %s\n", result.Secrets)
	}
	if result.ServerID != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "Server ID: %s\n", result.ServerID)
	}
	if result.TmuxSession != "" {
		fmt.Fprintf(cmd.OutOrStdout(), "tmux: %s\n", result.TmuxSession)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Script: %s\n", result.Script)
	fmt.Fprintf(cmd.OutOrStdout(), "Directory: %s\n", result.Directory)
	if result.LocalURL != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "Local: %s\n", *result.LocalURL)
	}
	if result.PublicURL != nil {
		fmt.Fprintf(cmd.OutOrStdout(), "Tailscale: %s\n", *result.PublicURL)
	}
	for _, library := range result.Libraries {
		packageNames := make([]string, 0, len(library.Packages))
		for _, pkg := range library.Packages {
			packageNames = append(packageNames, pkg.Name)
		}
		fmt.Fprintf(cmd.OutOrStdout(), "With: %s (%s)\n", library.Directory, strings.Join(packageNames, ", "))
	}
	for _, watcher := range result.Watchers {
		fmt.Fprintf(cmd.OutOrStdout(), "Watcher: %s (%s)\n", watcher.Package, strings.Join(watcher.Command, " "))
	}
	for _, companion := range result.Companions {
		if companion.LocalURL != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "Companion: %s (%s)\n", *companion.LocalURL, companion.Script)
		}
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
