package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	previewWorkflowFile = "deploy-preview.yml"
	previewWorkflowRef  = "main"
)

type previewOptions struct {
	PullRequest int
	All         bool
	Format      string
}

type previewCommandRunner func(dir string, stdin []byte, name string, args ...string) (string, error)

type previewDependencies struct {
	run    previewCommandRunner
	random io.Reader
	now    func() time.Time
}

type previewPullRequestEvidence struct {
	Number  int    `json:"number"`
	URL     string `json:"url"`
	State   string `json:"state"`
	BaseRef string `json:"baseRef"`
	HeadRef string `json:"headRef"`
	HeadSHA string `json:"headSha"`
}

type previewDispatchResult struct {
	Operation          string                     `json:"operation"`
	OperationID        string                     `json:"operationId"`
	RepositoryFullName string                     `json:"repositoryFullName"`
	PullRequest        previewPullRequestEvidence `json:"pullRequest"`
	PreviewID          string                     `json:"previewId"`
	ExpectedLiveURL    string                     `json:"expectedLiveUrl"`
	Workflow           previewWorkflowDispatch    `json:"workflow"`
}

type previewWorkflowDispatch struct {
	File  string `json:"file"`
	Ref   string `json:"ref"`
	State string `json:"state"`
}

func defaultPreviewDependencies() previewDependencies {
	return previewDependencies{run: runCommand, random: rand.Reader, now: time.Now}
}

func newDeployPreviewCommand() *cobra.Command {
	return newDeployPreviewCommandWithDependencies(defaultPreviewDependencies())
}

func newDeployPreviewCommandWithDependencies(deps previewDependencies) *cobra.Command {
	options := previewOptions{}
	cmd := &cobra.Command{
		Use:               "preview [directory]",
		Short:             "Deploy a pull request through the trusted preview workflow",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validatePreviewFormat(options.Format); err != nil {
				return err
			}
			root, err := previewProjectRoot(args)
			if err != nil {
				return err
			}
			result, err := dispatchPreview(root, "deploy", options.PullRequest, deps)
			if err != nil {
				return err
			}
			return printPreviewDispatch(cmd, result, options.Format)
		},
	}
	addPreviewFlags(cmd, &options, true)
	cmd.AddCommand(newDeployPreviewStatusCommand(deps), newDeployPreviewDestroyCommand(deps))
	return cmd
}

func newDeployPreviewStatusCommand(deps previewDependencies) *cobra.Command {
	options := previewOptions{}
	cmd := &cobra.Command{
		Use:               "status [directory]",
		Short:             "Read verified pull request preview status from the VPS",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validatePreviewFormat(options.Format); err != nil {
				return err
			}
			if (options.PullRequest > 0) == options.All {
				return fmt.Errorf("choose exactly one of --pr <number> or --all")
			}
			root, err := previewProjectRoot(args)
			if err != nil {
				return err
			}
			report, err := readPreviewStatus(root, options.PullRequest, deps)
			if err != nil {
				return err
			}
			return printPreviewStatus(cmd, report, options.Format)
		},
	}
	addPreviewFlags(cmd, &options, false)
	cmd.Flags().BoolVar(&options.All, "all", false, "show all pull request previews for this repository")
	return cmd
}

func newDeployPreviewDestroyCommand(deps previewDependencies) *cobra.Command {
	options := previewOptions{}
	cmd := &cobra.Command{
		Use:               "destroy [directory]",
		Short:             "Remove a pull request preview through the trusted workflow",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validatePreviewFormat(options.Format); err != nil {
				return err
			}
			root, err := previewProjectRoot(args)
			if err != nil {
				return err
			}
			result, err := dispatchPreview(root, "destroy", options.PullRequest, deps)
			if err != nil {
				return err
			}
			return printPreviewDispatch(cmd, result, options.Format)
		},
	}
	addPreviewFlags(cmd, &options, true)
	return cmd
}

func addPreviewFlags(cmd *cobra.Command, options *previewOptions, requirePR bool) {
	cmd.Flags().IntVar(&options.PullRequest, "pr", 0, "GitHub pull request number")
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	if requirePR {
		must(cmd.MarkFlagRequired("pr"))
	}
}

func previewProjectRoot(args []string) (string, error) {
	target := "."
	if len(args) == 1 {
		target = args[0]
	}
	return filepath.Abs(target)
}

func validatePreviewFormat(format string) error {
	if format != "pretty" && format != "json" {
		return fmt.Errorf("unsupported output format %q; use pretty or json", format)
	}
	return nil
}

func newPreviewOperationID(reader io.Reader) (string, error) {
	value := make([]byte, 16)
	if _, err := io.ReadFull(reader, value); err != nil {
		return "", fmt.Errorf("create preview operation ID: %w", err)
	}
	return "preview-" + hex.EncodeToString(value), nil
}

func previewID(repository string, pullRequest int) string {
	parts := strings.Split(repository, "/")
	return fmt.Sprintf("%s-pr-%d", strings.ToLower(parts[len(parts)-1]), pullRequest)
}

func previewLiveURL(pullRequest int) string {
	return fmt.Sprintf("https://pr-%d.projects.os-home.net", pullRequest)
}

func printPreviewDispatch(cmd *cobra.Command, result previewDispatchResult, format string) error {
	if err := validatePreviewFormat(format); err != nil {
		return err
	}
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}
	fmt.Fprintf(cmd.OutOrStdout(), "Preview %s queued for PR #%d\n", result.Operation, result.PullRequest.Number)
	fmt.Fprintf(cmd.OutOrStdout(), "Repository: %s\n", result.RepositoryFullName)
	fmt.Fprintf(cmd.OutOrStdout(), "Head: %s (%s)\n", result.PullRequest.HeadRef, result.PullRequest.HeadSHA)
	fmt.Fprintf(cmd.OutOrStdout(), "Operation: %s\n", result.OperationID)
	if result.Operation == "deploy" {
		fmt.Fprintf(cmd.OutOrStdout(), "Expected URL (not verified yet): %s\n", result.ExpectedLiveURL)
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "Target URL: %s\n", result.ExpectedLiveURL)
	}
	return nil
}
