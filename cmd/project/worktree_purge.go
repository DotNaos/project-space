package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/DotNaos/project-space/internal/projectstorage"
	"github.com/spf13/cobra"
)

type worktreePurgeDependencies struct {
	Checks        func(context.Context) ([]projectstorage.EvidenceCheck, error)
	DiscoverLocal localProjectDiscovery
	LoadCatalog   projectCatalogLoader
	Plan          func(context.Context, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgePlan, error)
	PlanAll       func(context.Context, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeBatchPlan, error)
	Purge         func(context.Context, string, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeResult, error)
}

func defaultWorktreePurgeDependencies() worktreePurgeDependencies {
	return worktreePurgeDependencies{
		Checks: func(ctx context.Context) ([]projectstorage.EvidenceCheck, error) {
			return []projectstorage.EvidenceCheck{
				codexWorktreeEvidence(), processWorktreeEvidence(), integrationWorktreeEvidence(),
			}, nil
		},
		DiscoverLocal: discoverLocalProjectPaths,
		LoadCatalog:   loadProjectCatalog,
		Plan:          projectstorage.PlanWorktreePurge,
		PlanAll:       projectstorage.PlanAllWorktreePurges,
		Purge:         projectstorage.PurgeWorktree,
	}
}

type worktreeBatchItem struct {
	Blockers  []projectstorage.Blocker      `json:"blockers,omitempty"`
	Candidate projectstorage.PurgeCandidate `json:"candidate"`
	Error     string                        `json:"error,omitempty"`
	Result    *projectstorage.PurgeResult   `json:"result,omitempty"`
	State     string                        `json:"state"`
}

type worktreeBatchResult struct {
	FreeSpaceDeltaBytes int64               `json:"freeSpaceDeltaBytes,omitempty"`
	FreeSpaceMeasured   bool                `json:"freeSpaceMeasured"`
	Items               []worktreeBatchItem `json:"items"`
	PurgedCount         int                 `json:"purgedCount"`
	SchemaVersion       int                 `json:"schemaVersion"`
	SkippedCount        int                 `json:"skippedCount"`
}

func newWorktreePurgeCommand() *cobra.Command {
	return newWorktreePurgeCommandWithDependencies(defaultWorktreePurgeDependencies())
}

func newWorktreePurgeCommandWithDependencies(dependencies worktreePurgeDependencies) *cobra.Command {
	apply, dryRun, allSafe := false, false, false
	selector, targetID, expectedHead, format := "", "", "", "text"
	command := &cobra.Command{
		Use:   "purge",
		Short: "Remove one linked worktree only after every safety gate passes",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if apply && dryRun {
				return errors.New("--apply and --dry-run cannot be combined")
			}
			if format != "text" && format != "json" {
				return errors.New("--format must be text or json")
			}
			if allSafe == (strings.TrimSpace(targetID) != "") {
				return errors.New("choose exactly one of --id or --all-safe")
			}
			if allSafe && strings.TrimSpace(expectedHead) != "" {
				return errors.New("--expect-head is only valid with --id")
			}
			project, projectPath, err := loadLocalStorageProject(
				command.Context(), dependencies.LoadCatalog, dependencies.DiscoverLocal, selector,
			)
			if err != nil {
				return err
			}
			checks, err := dependencies.Checks(command.Context())
			if err != nil {
				checks = []projectstorage.EvidenceCheck{func(context.Context, projectstorage.PurgeCandidate) ([]projectstorage.Blocker, error) {
					return nil, err
				}}
			}
			options := projectstorage.PurgeOptions{Checks: checks}
			if allSafe {
				batch, batchErr := dependencies.PlanAll(command.Context(), project.ID, project.Repository, projectPath, options)
				if batchErr != nil {
					return batchErr
				}
				if !apply {
					if format == "json" {
						return writeIndentedJSON(command, batch)
					}
					return writeWorktreeBatchPlan(command, batch)
				}
				result := applySafeWorktreeBatch(command.Context(), dependencies, project.ID, project.Repository, projectPath, batch)
				if format == "json" {
					return writeIndentedJSON(command, result)
				}
				return writeWorktreeBatchResult(command, result)
			}
			if !apply {
				plan, planErr := dependencies.Plan(command.Context(), project.ID, project.Repository, projectPath, targetID, options)
				if planErr != nil {
					return planErr
				}
				if format == "json" {
					return writeIndentedJSON(command, plan)
				}
				return writeWorktreePurgePlan(command, plan)
			}
			result, purgeErr := dependencies.Purge(
				command.Context(), project.ID, project.Repository, projectPath,
				targetID, expectedHead, options,
			)
			if purgeErr != nil {
				return purgeErr
			}
			if format == "json" {
				return writeIndentedJSON(command, result)
			}
			_, err = fmt.Fprintf(
				command.OutOrStdout(), "Purged %s (%s measured); retained branch and verified removal. %s\n",
				result.Path, humanBytes(result.MeasuredBytesRemoved), freeSpaceResult(result.FreeSpaceMeasured, result.FreeSpaceDeltaBytes),
			)
			return err
		},
	}
	command.Flags().StringVar(&selector, "project", "", "project ID, repository, or unique name")
	command.Flags().StringVar(&targetID, "id", "", "opaque worktree ID from project storage audit")
	command.Flags().StringVar(&expectedHead, "expect-head", "", "exact full reviewed worktree commit required for apply")
	command.Flags().BoolVar(&apply, "apply", false, "perform the purge after a fresh safety check")
	command.Flags().BoolVar(&allSafe, "all-safe", false, "inspect every linked worktree and act only on proven-safe candidates")
	command.Flags().BoolVar(&dryRun, "dry-run", false, "explicitly request the default read-only plan")
	command.Flags().StringVar(&format, "format", "text", "output format: text or json")
	_ = command.MarkFlagRequired("project")
	return command
}

func applySafeWorktreeBatch(
	ctx context.Context,
	dependencies worktreePurgeDependencies,
	projectID, repository, projectPath string,
	batch projectstorage.PurgeBatchPlan,
) worktreeBatchResult {
	result := worktreeBatchResult{Items: make([]worktreeBatchItem, 0, len(batch.Plans)), SchemaVersion: 1}
	allFreeSpaceMeasured := true
	for _, plan := range batch.Plans {
		item := worktreeBatchItem{Candidate: *plan.Candidate, State: "skipped"}
		if !plan.Purgeable {
			item.Blockers = plan.Blockers
			result.SkippedCount++
			result.Items = append(result.Items, item)
			continue
		}
		checks, err := dependencies.Checks(ctx)
		if err != nil {
			item.Error = "fresh safety evidence is unavailable: " + err.Error()
			result.SkippedCount++
			result.Items = append(result.Items, item)
			continue
		}
		purged, err := dependencies.Purge(
			ctx, projectID, repository, projectPath,
			plan.Candidate.WorktreeID, plan.Candidate.HeadSHA,
			projectstorage.PurgeOptions{Checks: checks},
		)
		if err != nil {
			item.Error = err.Error()
			result.SkippedCount++
			result.Items = append(result.Items, item)
			continue
		}
		item.Result = &purged
		item.State = "purged"
		result.PurgedCount++
		result.FreeSpaceDeltaBytes += purged.FreeSpaceDeltaBytes
		allFreeSpaceMeasured = allFreeSpaceMeasured && purged.FreeSpaceMeasured
		result.Items = append(result.Items, item)
	}
	result.FreeSpaceMeasured = result.PurgedCount > 0 && allFreeSpaceMeasured
	return result
}

func writeWorktreeBatchPlan(command *cobra.Command, batch projectstorage.PurgeBatchPlan) error {
	for _, plan := range batch.Plans {
		if err := writeWorktreePurgePlan(command, plan); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(
		command.OutOrStdout(), "Purgeable: %d (%s); skipped: %d.\n",
		batch.PurgeableCount, humanBytes(batch.PurgeableBytes), batch.SkippedCount,
	)
	return err
}

func writeWorktreeBatchResult(command *cobra.Command, result worktreeBatchResult) error {
	for _, item := range result.Items {
		if item.State == "purged" {
			if _, err := fmt.Fprintf(command.OutOrStdout(), "PURGED  %s  %s\n", item.Candidate.WorktreeID, item.Candidate.Path); err != nil {
				return err
			}
			continue
		}
		reason := item.Error
		if reason == "" {
			reason = summarizeProjectStorageBlockers(item.Blockers)
		}
		if _, err := fmt.Fprintf(command.OutOrStdout(), "SKIPPED  %s  %s\n", item.Candidate.WorktreeID, reason); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintf(command.OutOrStdout(), "Purged: %d; skipped: %d. %s\n", result.PurgedCount, result.SkippedCount, freeSpaceResult(result.FreeSpaceMeasured, result.FreeSpaceDeltaBytes))
	return err
}

func summarizeProjectStorageBlockers(blockers []projectstorage.Blocker) string {
	parts := make([]string, 0, len(blockers))
	for _, blocker := range blockers {
		parts = append(parts, blocker.Code)
	}
	return strings.Join(parts, ", ")
}

func freeSpaceResult(measured bool, delta int64) string {
	if !measured {
		return "Free-space delta was unavailable."
	}
	if delta < 0 {
		return "Free-space delta: -" + humanBytes(-delta) + "."
	}
	return "Free-space delta: " + humanBytes(delta) + "."
}

func writeIndentedJSON(command *cobra.Command, value any) error {
	encoder := json.NewEncoder(command.OutOrStdout())
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeWorktreePurgePlan(command *cobra.Command, plan projectstorage.PurgePlan) error {
	if plan.Candidate == nil {
		return errors.New("worktree purge plan has no candidate")
	}
	if plan.Purgeable {
		_, err := fmt.Fprintf(
			command.OutOrStdout(), "PURGEABLE  %s  %s  %s\nApply with --expect-head %s --apply\n",
			plan.Candidate.WorktreeID, plan.Candidate.Branch, humanBytes(plan.Candidate.Bytes), plan.Candidate.HeadSHA,
		)
		return err
	}
	if _, err := fmt.Fprintf(command.OutOrStdout(), "BLOCKED  %s  %s\n", plan.Candidate.WorktreeID, plan.Candidate.Branch); err != nil {
		return err
	}
	for _, item := range plan.Blockers {
		if _, err := fmt.Fprintf(command.OutOrStdout(), "- %s: %s\n", item.Code, item.Message); err != nil {
			return err
		}
	}
	return nil
}

func codexWorktreeEvidence() projectstorage.EvidenceCheck {
	var inventory []localCodexThread
	var inventoryErr error
	once := sync.Once{}
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) ([]projectstorage.Blocker, error) {
		once.Do(func() {
			inventory, inventoryErr = listLocalCodexThreads(ctx)
		})
		if inventoryErr != nil {
			return nil, fmt.Errorf("list Codex tasks: %w", inventoryErr)
		}
		blockers := make([]projectstorage.Blocker, 0)
		for _, session := range inventory {
			if session.ID == candidate.OwnerThreadID || pathContains(candidate.Path, session.CWD) {
				blockers = append(blockers, projectstorage.Blocker{
					Code: "codex_thread_unarchived", Message: "Codex task " + session.ID + " still uses this worktree.",
				})
			}
		}
		return blockers, nil
	}
}

func processWorktreeEvidence() projectstorage.EvidenceCheck {
	once := sync.Once{}
	paths := []string{}
	var inventoryErr error
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) ([]projectstorage.Blocker, error) {
		once.Do(func() { paths, inventoryErr = openProcessPaths(ctx) })
		return processPathEvidence(paths, inventoryErr, candidate.Path, "worktree")
	}
}

func openProcessPaths(ctx context.Context) ([]string, error) {
	command := exec.CommandContext(ctx, "lsof", "-Fn")
	output, err := command.Output()
	if err != nil {
		return nil, fmt.Errorf("inspect process file usage: %w", err)
	}
	paths := make([]string, 0)
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "n") {
			paths = append(paths, strings.TrimPrefix(line, "n"))
		}
	}
	return paths, nil
}

func processPathEvidence(paths []string, inventoryErr error, path, label string) ([]projectstorage.Blocker, error) {
	if inventoryErr != nil {
		return nil, inventoryErr
	}
	for _, openPath := range paths {
		if pathContains(path, openPath) {
			return []projectstorage.Blocker{{Code: "process_active", Message: "A running process has a working directory or open file inside this " + label + "."}}, nil
		}
	}
	return nil, nil
}

type pullRequestRecord struct {
	HeadRefName string  `json:"headRefName"`
	HeadRefOID  string  `json:"headRefOid"`
	IsDraft     bool    `json:"isDraft"`
	MergedAt    *string `json:"mergedAt"`
	Number      int     `json:"number"`
	State       string  `json:"state"`
	URL         string  `json:"url"`
}

func integrationWorktreeEvidence() projectstorage.EvidenceCheck {
	refreshOnce, pullRequestsOnce := sync.Once{}, sync.Once{}
	defaultRef := ""
	var refreshErr, pullRequestsErr error
	records := []pullRequestRecord{}
	return func(ctx context.Context, candidate projectstorage.PurgeCandidate) ([]projectstorage.Blocker, error) {
		refreshOnce.Do(func() {
			if _, err := commandOutput(ctx, candidate.Path, "git", "fetch", "--prune", "origin"); err != nil {
				refreshErr = fmt.Errorf("refresh origin before integration check: %w", err)
				return
			}
			resolved, err := commandOutput(ctx, candidate.Path, "git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
			if err != nil {
				refreshErr = fmt.Errorf("resolve origin default branch: %w", err)
				return
			}
			defaultRef = strings.TrimSpace(resolved)
		})
		if refreshErr != nil {
			return nil, refreshErr
		}
		ancestor := exec.CommandContext(ctx, "git", "-C", candidate.Path, "merge-base", "--is-ancestor", candidate.HeadSHA, defaultRef)
		if ancestor.Run() == nil {
			return nil, nil
		}
		pullRequestsOnce.Do(func() {
			output, err := commandOutput(
				ctx, candidate.Path, "gh", "pr", "list", "--repo", candidate.Repository,
				"--state", "all", "--limit", "1000",
				"--json", "number,state,isDraft,mergedAt,headRefName,headRefOid,url",
			)
			if err != nil {
				pullRequestsErr = fmt.Errorf("load pull request evidence: %w", err)
				return
			}
			if json.Unmarshal([]byte(output), &records) != nil {
				pullRequestsErr = errors.New("load pull request evidence: invalid GitHub response")
			}
		})
		if pullRequestsErr != nil {
			return nil, pullRequestsErr
		}
		for _, record := range records {
			if record.HeadRefName != candidate.Branch || record.HeadRefOID != candidate.HeadSHA {
				continue
			}
			if record.State == "MERGED" && record.MergedAt != nil && !record.IsDraft {
				return nil, nil
			}
			return []projectstorage.Blocker{{Code: "pull_request_not_merged", Message: fmt.Sprintf("Pull request #%d for the exact head is not merged.", record.Number)}}, nil
		}
		return []projectstorage.Blocker{{Code: "pull_request_not_merged", Message: "No merged pull request proves the current unique worktree head."}}, nil
	}
}

func commandOutput(ctx context.Context, directory, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return string(output), nil
}

func pathContains(parent, child string) bool {
	if strings.TrimSpace(child) == "" {
		return false
	}
	parent, parentErr := filepath.Abs(filepath.Clean(parent))
	child, childErr := filepath.Abs(filepath.Clean(child))
	if parentErr != nil || childErr != nil {
		return false
	}
	relative, err := filepath.Rel(parent, child)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
