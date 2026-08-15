package projectstorage

import (
	"context"
	"sort"
	"sync"
	"time"
)

type PurgeBatchPlan struct {
	CheckedAt      string      `json:"checkedAt"`
	Plans          []PurgePlan `json:"plans"`
	PurgeableBytes int64       `json:"purgeableBytes"`
	PurgeableCount int         `json:"purgeableCount"`
	SchemaVersion  int         `json:"schemaVersion"`
	SkippedCount   int         `json:"skippedCount"`
}

func PlanAllWorktreePurges(
	ctx context.Context,
	projectID, repository, projectPath string,
	options PurgeOptions,
) (PurgeBatchPlan, error) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	report, err := Audit(ctx, projectID, repository, projectPath, Options{Meter: zeroMeter, Now: now})
	if err != nil {
		return PurgeBatchPlan{}, err
	}
	targets := make([]Entry, 0, len(report.Worktrees))
	for _, entry := range report.Worktrees {
		if !entry.IsMain {
			targets = append(targets, entry)
		}
	}
	plans := make([]PurgePlan, len(targets))
	semaphore := make(chan struct{}, 4)
	group := sync.WaitGroup{}
	for index, target := range targets {
		index, target := index, target
		group.Add(1)
		go func() {
			defer group.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			plans[index] = planWorktreeEntry(ctx, projectID, repository, report.Path, target, now, options)
		}()
	}
	group.Wait()
	sort.Slice(plans, func(left, right int) bool {
		return plans[left].Candidate.Path < plans[right].Candidate.Path
	})
	result := PurgeBatchPlan{
		CheckedAt: now().UTC().Format(time.RFC3339Nano), Plans: plans, SchemaVersion: 1,
	}
	for _, plan := range plans {
		if plan.Purgeable {
			result.PurgeableCount++
			result.PurgeableBytes += plan.Candidate.Bytes
		} else {
			result.SkippedCount++
		}
	}
	return result, nil
}
