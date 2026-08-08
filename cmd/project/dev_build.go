package main

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

const devBuildWorkflowFile = "build-pr-tools.yml"

var devBuildPlatforms = map[string]string{
	"linux-x64":   "linux_x64",
	"macos-arm64": "macos_arm64",
	"windows-x64": "windows_x64",
}

type devBuildOptions struct {
	PullRequest int
	Platforms   []string
	Format      string
}

type devBuildResult struct {
	RepositoryFullName string                     `json:"repositoryFullName"`
	PullRequest        previewPullRequestEvidence `json:"pullRequest"`
	Platforms          []string                   `json:"platforms"`
	Workflow           previewWorkflowDispatch    `json:"workflow"`
}

func newDevBuildCommand() *cobra.Command {
	return newDevBuildCommandWithDependencies(defaultPreviewDependencies())
}

func newDevBuildCommandWithDependencies(deps previewDependencies) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "dev-build",
		Short: "Build short-lived development tools for an exact pull request head",
	}
	cmd.AddCommand(newDevBuildCreateCommand(deps))
	return cmd
}

func newDevBuildCreateCommand(deps previewDependencies) *cobra.Command {
	options := devBuildOptions{}
	cmd := &cobra.Command{
		Use:               "create [directory]",
		Short:             "Request unsigned PR development tools",
		Args:              cobra.MaximumNArgs(1),
		ValidArgsFunction: directoryCompletion,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := validatePreviewFormat(options.Format); err != nil {
				return err
			}
			root, err := devBuildProjectRoot(args)
			if err != nil {
				return err
			}
			result, err := dispatchDevBuild(root, options, deps)
			if err != nil {
				return err
			}
			return printDevBuildDispatch(cmd, result, options.Format)
		},
	}
	cmd.Flags().IntVar(&options.PullRequest, "pr", 0, "GitHub pull request number")
	cmd.Flags().StringSliceVar(
		&options.Platforms,
		"platform",
		[]string{"linux-x64"},
		"development platform: linux-x64, macos-arm64, or windows-x64",
	)
	cmd.Flags().StringVar(&options.Format, "format", "pretty", "output format: pretty or json")
	must(cmd.MarkFlagRequired("pr"))
	must(cmd.RegisterFlagCompletionFunc("format", fixedValuesCompletion("pretty", "json")))
	must(cmd.RegisterFlagCompletionFunc(
		"platform",
		fixedValuesCompletion("linux-x64", "macos-arm64", "windows-x64"),
	))
	return cmd
}

func devBuildProjectRoot(args []string) (string, error) {
	target := "."
	if len(args) == 1 {
		target = args[0]
	}
	return filepath.Abs(target)
}

func dispatchDevBuild(
	projectRoot string,
	options devBuildOptions,
	deps previewDependencies,
) (devBuildResult, error) {
	if options.PullRequest <= 0 {
		return devBuildResult{}, fmt.Errorf("--pr must be a positive pull request number")
	}
	platforms, err := normalizedDevBuildPlatforms(options.Platforms)
	if err != nil {
		return devBuildResult{}, err
	}
	repository, err := resolvePreviewRepository(projectRoot, deps.run)
	if err != nil {
		return devBuildResult{}, err
	}
	repositoryRecord, err := loadPreviewRepository(repository, deps.githubAPI)
	if err != nil {
		return devBuildResult{}, err
	}
	if !strings.EqualFold(repositoryRecord.FullName, repository) {
		return devBuildResult{}, fmt.Errorf(
			"GitHub returned repository %q for origin %q",
			repositoryRecord.FullName,
			repository,
		)
	}
	if repositoryRecord.DefaultBranch != previewWorkflowRef {
		return devBuildResult{}, fmt.Errorf(
			"development builds require repository default branch %q, got %q",
			previewWorkflowRef,
			repositoryRecord.DefaultBranch,
		)
	}
	if !repositoryRecord.Permissions.Push {
		return devBuildResult{}, fmt.Errorf(
			"GitHub write permission is required to dispatch development builds",
		)
	}
	pull, err := loadPreviewPullRequest(repository, options.PullRequest, deps.githubAPI)
	if err != nil {
		return devBuildResult{}, err
	}
	if err := validatePreviewPullRequest(repository, options.PullRequest, pull, true); err != nil {
		return devBuildResult{}, fmt.Errorf("validate development-build source: %w", err)
	}

	selected := make(map[string]bool, len(platforms))
	for _, platform := range platforms {
		selected[platform] = true
	}
	args := []string{
		"workflow", "run", devBuildWorkflowFile,
		"--repo", repository,
		"--ref", previewWorkflowRef,
		"-f", fmt.Sprintf("pull_request=%d", options.PullRequest),
		"-f", "requested_head_sha=" + pull.Head.SHA,
	}
	for _, platform := range []string{"linux-x64", "macos-arm64", "windows-x64"} {
		args = append(args, "-f", fmt.Sprintf("%s=%t", devBuildPlatforms[platform], selected[platform]))
	}
	if _, err := deps.run(projectRoot, nil, "gh", args...); err != nil {
		return devBuildResult{}, fmt.Errorf("dispatch PR development tools workflow: %w", err)
	}
	return devBuildResult{
		RepositoryFullName: repository,
		PullRequest: previewPullRequestEvidence{
			Number: pull.Number, URL: pull.URL, State: pull.State,
			BaseRef: pull.Base.Ref, HeadRef: pull.Head.Ref, HeadSHA: pull.Head.SHA,
		},
		Platforms: platforms,
		Workflow: previewWorkflowDispatch{
			File: devBuildWorkflowFile, Ref: previewWorkflowRef, State: "queued",
		},
	}, nil
}

func normalizedDevBuildPlatforms(values []string) ([]string, error) {
	selected := make(map[string]struct{}, len(values))
	for _, value := range values {
		platform := strings.ToLower(strings.TrimSpace(value))
		if _, ok := devBuildPlatforms[platform]; !ok {
			return nil, fmt.Errorf(
				"unsupported development platform %q; use linux-x64, macos-arm64, or windows-x64",
				value,
			)
		}
		selected[platform] = struct{}{}
	}
	if len(selected) == 0 {
		return nil, fmt.Errorf("select at least one development platform")
	}
	platforms := make([]string, 0, len(selected))
	for platform := range selected {
		platforms = append(platforms, platform)
	}
	sort.Strings(platforms)
	return platforms, nil
}

func printDevBuildDispatch(cmd *cobra.Command, result devBuildResult, format string) error {
	if format == "json" {
		encoder := json.NewEncoder(cmd.OutOrStdout())
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	}
	fmt.Fprintf(
		cmd.OutOrStdout(),
		"Development tools queued for PR #%d at %s\n",
		result.PullRequest.Number,
		result.PullRequest.HeadSHA,
	)
	fmt.Fprintf(cmd.OutOrStdout(), "Platforms: %s\n", strings.Join(result.Platforms, ", "))
	fmt.Fprintln(cmd.OutOrStdout(), "The build is unsigned, short-lived, and does not block merging.")
	return nil
}
