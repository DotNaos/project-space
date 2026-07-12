//go:build !windows

package main

import (
	"context"
	"fmt"

	"github.com/DotNaos/project-space/internal/projectrun"
	"github.com/spf13/cobra"
)

type projectPrepareOptions struct {
	Step                      string
	Format                    string
	JSON                      bool
	ExpectedCommit            string
	ExpectedDeclarationDigest string
}

type projectPrepareManager interface {
	Prepare(context.Context, string, string, projectrun.Streams) (projectrun.SetupCollectionResult, error)
	SetupStatus(context.Context, string, string) (projectrun.SetupCollectionResult, error)
}

type projectPrepareExpectedManager interface {
	PrepareExpected(context.Context, string, string, projectrun.SetupExpectations, projectrun.Streams) (projectrun.SetupCollectionResult, error)
}

func newPrepareCommand() *cobra.Command {
	return newPrepareCommandWithManager(defaultProjectManager)
}

func newPrepareCommandWithManager(managerFactory projectManagerFactory) *cobra.Command {
	options := projectPrepareOptions{}
	cmd := &cobra.Command{
		Use:               "prepare [directory]",
		Short:             "Run trusted repository setup steps",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			directory := argumentOrCurrentDirectory(args)
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			preparer, ok := manager.(projectPrepareManager)
			if !ok {
				return fmt.Errorf("project runtime does not support repository setup")
			}
			streams := projectrun.Streams{
				Stdin: cmd.InOrStdin(), Stdout: cmd.OutOrStdout(), Stderr: cmd.ErrOrStderr(),
			}
			if format == "json" {
				// Machine callers receive state only. Child output stays in the
				// private, bounded, redacted local setup log.
				streams.Stdout, streams.Stderr = nil, nil
			}
			if (options.ExpectedCommit == "") != (options.ExpectedDeclarationDigest == "") {
				return fmt.Errorf("--expect-commit and --expect-declaration-digest must be provided together")
			}
			var result projectrun.SetupCollectionResult
			var prepareErr error
			if options.ExpectedCommit != "" {
				expectedPreparer, ok := manager.(projectPrepareExpectedManager)
				if !ok {
					return fmt.Errorf("project runtime does not support approved setup identity checks")
				}
				result, prepareErr = expectedPreparer.PrepareExpected(
					cmd.Context(), directory, options.Step,
					projectrun.SetupExpectations{Commit: options.ExpectedCommit, DeclarationDigest: options.ExpectedDeclarationDigest},
					streams,
				)
			} else {
				result, prepareErr = preparer.Prepare(cmd.Context(), directory, options.Step, streams)
			}
			if err := printSetupCollection(cmd, result, format); err != nil {
				return err
			}
			return prepareErr
		},
	}
	bindPrepareFlags(cmd, &options)
	cmd.AddCommand(newPrepareStatusCommand(managerFactory))
	return cmd
}

func newPrepareStatusCommand(managerFactory projectManagerFactory) *cobra.Command {
	options := projectPrepareOptions{}
	cmd := &cobra.Command{
		Use:               "status [directory]",
		Short:             "Inspect trusted repository setup",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			format, err := resolvedProjectRunFormat(options.Format, options.JSON)
			if err != nil {
				return err
			}
			manager, err := managerFactory()
			if err != nil {
				return err
			}
			preparer, ok := manager.(projectPrepareManager)
			if !ok {
				return fmt.Errorf("project runtime does not support repository setup")
			}
			result, statusErr := preparer.SetupStatus(cmd.Context(), argumentOrCurrentDirectory(args), options.Step)
			if err := printSetupCollection(cmd, result, format); err != nil {
				return err
			}
			return statusErr
		},
	}
	bindPrepareFlags(cmd, &options)
	return cmd
}

func bindPrepareFlags(cmd *cobra.Command, options *projectPrepareOptions) {
	cmd.Flags().StringVar(&options.Step, "step", "", "stable setup step ID (default: all steps in declaration order)")
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	cmd.Flags().BoolVar(&options.JSON, "json", false, "print machine-readable JSON output")
	cmd.Flags().StringVar(&options.ExpectedCommit, "expect-commit", "", "require this exact repository commit before setup")
	cmd.Flags().StringVar(&options.ExpectedDeclarationDigest, "expect-declaration-digest", "", "require this exact setup declaration digest before setup")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
}

func argumentOrCurrentDirectory(args []string) string {
	if len(args) == 1 {
		return args[0]
	}
	return "."
}

func printSetupCollection(cmd *cobra.Command, result projectrun.SetupCollectionResult, format string) error {
	if format == "json" {
		return printProjectRunJSON(cmd, result)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Project setup: %s\n", result.Directory)
	for _, step := range result.Steps {
		fmt.Fprintf(cmd.OutOrStdout(), "- %s: %s\n", step.StepID, step.State)
		if step.LastError != nil {
			fmt.Fprintf(cmd.OutOrStdout(), "  Error: %s\n", *step.LastError)
		}
	}
	return nil
}
