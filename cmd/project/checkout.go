package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/DotNaos/project-space/internal/projectstorage"
	"github.com/spf13/cobra"
)

type checkoutPurgeDependencies struct {
	Checks        func(context.Context) ([]projectstorage.CheckoutEvidenceCheck, error)
	DiscoverLocal localProjectDiscovery
	LoadCatalog   projectCatalogLoader
	Plan          func(context.Context, string, string, string, projectstorage.CheckoutOptions) (projectstorage.CheckoutPlan, error)
	Purge         func(context.Context, string, string, string, string, projectstorage.CheckoutOptions) (projectstorage.CheckoutPurgeResult, error)
	SafetyDirs    func() (string, string, string, error)
}

func defaultCheckoutPurgeDependencies() checkoutPurgeDependencies {
	return checkoutPurgeDependencies{
		Checks: func(ctx context.Context) ([]projectstorage.CheckoutEvidenceCheck, error) {
			return []projectstorage.CheckoutEvidenceCheck{
				codexCheckoutEvidence, processCheckoutEvidence, remoteCheckoutEvidence,
			}, nil
		},
		DiscoverLocal: discoverLocalProjectPaths,
		LoadCatalog:   loadProjectCatalog,
		Plan:          projectstorage.PlanCheckoutPurge,
		Purge:         projectstorage.PurgeCheckout,
		SafetyDirs:    checkoutSafetyDirectories,
	}
}

func newCheckoutCommand() *cobra.Command {
	command := &cobra.Command{Use: "checkout", Short: "Manage local main project checkouts", Args: cobra.NoArgs}
	command.AddCommand(newCheckoutPurgeCommandWithDependencies(defaultCheckoutPurgeDependencies()))
	return command
}

func newCheckoutPurgeCommandWithDependencies(dependencies checkoutPurgeDependencies) *cobra.Command {
	apply, dryRun := false, false
	selector, expectedHead, format := "", "", "text"
	command := &cobra.Command{
		Use:   "purge",
		Short: "Remove one reconstructible main checkout after stronger safety checks",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if apply && dryRun {
				return errors.New("--apply and --dry-run cannot be combined")
			}
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			project, projectPath, err := loadLocalStorageProject(
				command.Context(), dependencies.LoadCatalog, dependencies.DiscoverLocal, selector,
			)
			if err != nil {
				return err
			}
			authorizedRoot, lockDirectory, recoveryDirectory, err := dependencies.SafetyDirs()
			if err != nil {
				return err
			}
			checks, err := dependencies.Checks(command.Context())
			if err != nil {
				checks = []projectstorage.CheckoutEvidenceCheck{func(context.Context, projectstorage.CheckoutCandidate) ([]projectstorage.Blocker, error) {
					return nil, err
				}}
			}
			options := projectstorage.CheckoutOptions{
				AuthorizedRoot: authorizedRoot, Checks: checks,
				LockDirectory: lockDirectory, RecoveryDir: recoveryDirectory,
			}
			if !apply {
				plan, planErr := dependencies.Plan(command.Context(), project.ID, project.Repository, projectPath, options)
				if planErr != nil {
					return planErr
				}
				if format == "json" {
					return writeIndentedJSON(command, plan)
				}
				return writeCheckoutPurgePlan(command, plan)
			}
			result, purgeErr := dependencies.Purge(
				command.Context(), project.ID, project.Repository, projectPath, expectedHead, options,
			)
			if purgeErr != nil {
				return purgeErr
			}
			if format == "json" {
				return writeIndentedJSON(command, result)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(),
				"Purged %s (%s measured); recovery manifest: %s. %s\n",
				result.Path, humanBytes(result.MeasuredBytesRemoved), result.ManifestPath,
				freeSpaceResult(result.FreeSpaceMeasured, result.FreeSpaceDeltaBytes),
			)
			return err
		},
	}
	command.Flags().StringVar(&selector, "project", "", "project ID, repository, or unique name")
	command.Flags().StringVar(&expectedHead, "expect-head", "", "exact full reviewed checkout commit required for apply")
	command.Flags().BoolVar(&apply, "apply", false, "perform the purge after a fresh safety check")
	command.Flags().BoolVar(&dryRun, "dry-run", false, "explicitly request the default read-only plan")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	_ = command.MarkFlagRequired("project")
	return command
}

func writeCheckoutPurgePlan(command *cobra.Command, plan projectstorage.CheckoutPlan) error {
	if plan.Candidate == nil {
		return errors.New("checkout purge plan has no candidate")
	}
	if plan.Purgeable {
		_, err := fmt.Fprintf(
			command.OutOrStdout(), "PURGEABLE  %s  %s\nApply with --expect-head %s --apply\n",
			plan.Candidate.Path, humanBytes(plan.Candidate.Bytes), plan.Candidate.HeadSHA,
		)
		return err
	}
	if _, err := fmt.Fprintf(command.OutOrStdout(), "BLOCKED  %s\n", plan.Candidate.Path); err != nil {
		return err
	}
	for _, item := range plan.Blockers {
		if _, err := fmt.Fprintf(command.OutOrStdout(), "- %s: %s\n", item.Code, item.Message); err != nil {
			return err
		}
	}
	return nil
}

func checkoutSafetyDirectories() (string, string, string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", "", errors.New("resolve authorized projects root")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return "", "", "", errors.New("resolve checkout recovery directory")
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", "", "", errors.New("resolve checkout purge lock directory")
	}
	return filepath.Join(home, "projects"), filepath.Join(cache, "project-space", "locks"), filepath.Join(config, "project-space", "recovery", "checkouts"), nil
}

func codexCheckoutEvidence(ctx context.Context, candidate projectstorage.CheckoutCandidate) ([]projectstorage.Blocker, error) {
	inventory, err := listLocalCodexThreads(ctx)
	if err != nil {
		return nil, fmt.Errorf("list Codex tasks: %w", err)
	}
	blockers := make([]projectstorage.Blocker, 0)
	for _, session := range inventory {
		if pathContains(candidate.Path, session.CWD) {
			blockers = append(blockers, projectstorage.Blocker{
				Code: "codex_thread_unarchived", Message: "Codex task " + session.ID + " still uses this checkout.",
			})
		}
	}
	return blockers, nil
}

func processCheckoutEvidence(ctx context.Context, candidate projectstorage.CheckoutCandidate) ([]projectstorage.Blocker, error) {
	paths, err := openProcessPaths(ctx)
	return processPathEvidence(paths, err, candidate.Path, "checkout")
}

func remoteCheckoutEvidence(ctx context.Context, candidate projectstorage.CheckoutCandidate) ([]projectstorage.Blocker, error) {
	remoteURL, err := commandOutput(ctx, candidate.Path, "git", "remote", "get-url", "origin")
	if err != nil {
		return nil, fmt.Errorf("read origin URL: %w", err)
	}
	if githubRemoteRepository(strings.TrimSpace(remoteURL)) != strings.ToLower(candidate.Repository) {
		return []projectstorage.Blocker{{Code: "remote_mismatch", Message: "The origin remote does not match the Project Space repository."}}, nil
	}
	if _, err := commandOutput(ctx, candidate.Path, "git", "fetch", "--prune", "--tags", "origin"); err != nil {
		return nil, fmt.Errorf("refresh origin before reconstructibility check: %w", err)
	}
	if _, err := commandOutput(ctx, candidate.Path, "git", "remote", "set-head", "origin", "--auto"); err != nil {
		return nil, fmt.Errorf("verify origin default branch: %w", err)
	}
	unique, err := commandOutput(ctx, candidate.Path, "git", "rev-list", "--all", "--reflog", "--not", "--remotes=origin")
	if err != nil {
		return nil, fmt.Errorf("inspect local-only Git history: %w", err)
	}
	if strings.TrimSpace(unique) != "" {
		return []projectstorage.Blocker{{Code: "local_only_history", Message: "Local commits, branches, tags, or reflog history are not recoverable from origin."}}, nil
	}
	localBranches, err := commandOutput(ctx, candidate.Path, "git", "for-each-ref", "--format=%(refname:short)", "refs/heads")
	if err != nil {
		return nil, fmt.Errorf("inspect local branch names: %w", err)
	}
	remoteBranches, err := commandOutput(ctx, candidate.Path, "git", "for-each-ref", "--format=%(refname:strip=3)", "refs/remotes/origin")
	if err != nil {
		return nil, fmt.Errorf("inspect origin branch names: %w", err)
	}
	if missing := missingNames(localBranches, remoteBranches, "HEAD"); len(missing) != 0 {
		return []projectstorage.Blocker{{Code: "local_only_refs", Message: "Local branch names are not recoverable from origin: " + strings.Join(missing, ", ")}}, nil
	}
	localTags, err := commandOutput(ctx, candidate.Path, "git", "tag", "--list")
	if err != nil {
		return nil, fmt.Errorf("inspect local tags: %w", err)
	}
	remoteTagsOutput, err := commandOutput(ctx, candidate.Path, "git", "ls-remote", "--tags", "--refs", "origin")
	if err != nil {
		return nil, fmt.Errorf("inspect origin tags: %w", err)
	}
	remoteTags := make([]string, 0)
	for _, line := range strings.Split(remoteTagsOutput, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 {
			remoteTags = append(remoteTags, strings.TrimPrefix(fields[1], "refs/tags/"))
		}
	}
	if missing := missingNames(localTags, strings.Join(remoteTags, "\n")); len(missing) != 0 {
		return []projectstorage.Blocker{{Code: "local_only_refs", Message: "Local tag names are not recoverable from origin: " + strings.Join(missing, ", ")}}, nil
	}
	contains := exec.CommandContext(ctx, "git", "-C", candidate.Path, "branch", "-r", "--contains", candidate.HeadSHA, "--format=%(refname)")
	output, err := contains.CombinedOutput()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return []projectstorage.Blocker{{Code: "head_not_on_origin", Message: "The checked-out commit is not recoverable from an origin branch."}}, nil
	}
	return nil, nil
}

func missingNames(localOutput, remoteOutput string, ignored ...string) []string {
	remote := map[string]bool{}
	for _, name := range strings.Fields(remoteOutput) {
		remote[strings.TrimSpace(name)] = true
	}
	for _, name := range ignored {
		remote[name] = true
	}
	missing := make([]string, 0)
	for _, name := range strings.Fields(localOutput) {
		if !remote[name] {
			missing = append(missing, name)
		}
	}
	return missing
}

func githubRemoteRepository(remote string) string {
	remote = strings.TrimSpace(strings.TrimSuffix(remote, ".git"))
	switch {
	case strings.HasPrefix(remote, "git@github.com:"):
		return strings.ToLower(strings.TrimPrefix(remote, "git@github.com:"))
	case strings.HasPrefix(remote, "ssh://git@github.com/"):
		return strings.ToLower(strings.TrimPrefix(remote, "ssh://git@github.com/"))
	case strings.HasPrefix(remote, "https://github.com/"):
		return strings.ToLower(strings.TrimPrefix(remote, "https://github.com/"))
	default:
		return ""
	}
}
