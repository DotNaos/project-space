package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/DotNaos/project-space/internal/projectstorage"
	"github.com/spf13/cobra"
)

type worktreePurgePolicy struct {
	IncludeOpenPRs bool
}

type worktreePurgeDependencies struct {
	Checks        func(context.Context, worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error)
	DiscoverLocal localProjectDiscovery
	LoadCatalog   projectCatalogLoader
	Plan          func(context.Context, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgePlan, error)
	PlanAll       func(context.Context, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeBatchPlan, error)
	Purge         func(context.Context, string, string, string, string, string, projectstorage.PurgeOptions) (projectstorage.PurgeResult, error)
}

func defaultWorktreePurgeDependencies() worktreePurgeDependencies {
	return worktreePurgeDependencies{
		Checks: func(ctx context.Context, policy worktreePurgePolicy) ([]projectstorage.EvidenceCheck, error) {
			return []projectstorage.EvidenceCheck{
				codexWorktreeEvidence(), processWorktreeEvidence(), integrationWorktreeEvidence(policy),
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
	apply, dryRun, allSafe, includeOpenPRs := false, false, false, false
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
			policy := worktreePurgePolicy{IncludeOpenPRs: includeOpenPRs}
			checks, err := dependencies.Checks(command.Context(), policy)
			if err != nil {
				checks = []projectstorage.EvidenceCheck{func(context.Context, projectstorage.PurgeCandidate) (projectstorage.EvidenceResult, error) {
					return projectstorage.EvidenceResult{}, err
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
				result := applySafeWorktreeBatch(command.Context(), dependencies, project.ID, project.Repository, projectPath, batch, policy)
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
				command.OutOrStdout(), "Purged %s (%s measured; %s); retained branch and verified removal. %s\n",
				result.Path, humanBytes(result.MeasuredBytesRemoved), worktreeRecoveryLabel(result.Evidence),
				freeSpaceResult(result.FreeSpaceMeasured, result.FreeSpaceDeltaBytes),
			)
			return err
		},
	}
	command.Flags().StringVar(&selector, "project", "", "project ID, repository, or unique name")
	command.Flags().StringVar(&targetID, "id", "", "opaque worktree ID from project storage audit")
	command.Flags().StringVar(&expectedHead, "expect-head", "", "exact full reviewed worktree commit required for apply")
	command.Flags().BoolVar(&apply, "apply", false, "perform the purge after a fresh safety check")
	command.Flags().BoolVar(&allSafe, "all-safe", false, "inspect every linked worktree and act only on proven-safe candidates")
	command.Flags().BoolVar(&includeOpenPRs, "include-open-prs", false, "also allow clean worktrees whose exact remote head is preserved by an open pull request")
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
	policy worktreePurgePolicy,
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
		checks, err := dependencies.Checks(ctx, policy)
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
			if _, err := fmt.Fprintf(
				command.OutOrStdout(), "PURGED  %s  %s  %s\n",
				item.Candidate.WorktreeID, item.Candidate.Path, worktreeRecoveryLabel(item.Result.Evidence),
			); err != nil {
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
		recovery := worktreeRecoveryLabel(plan.Evidence)
		_, err := fmt.Fprintf(
			command.OutOrStdout(), "PURGEABLE  %s  %s  %s  %s\nApply with --expect-head %s --apply\n",
			plan.Candidate.WorktreeID, plan.Candidate.Branch, humanBytes(plan.Candidate.Bytes), recovery, plan.Candidate.HeadSHA,
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

func worktreeRecoveryLabel(evidence []projectstorage.Evidence) string {
	for _, item := range evidence {
		if item.RecoveryState == "merged" {
			return fmt.Sprintf("merged PR #%d", item.PullRequest)
		}
		if item.RecoveryState == "open-pr-backed" {
			return fmt.Sprintf("open PR #%d", item.PullRequest)
		}
	}
	return "recovery proof unavailable"
}
