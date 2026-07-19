import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ListPlus, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  GitHubBranchRecord,
  GitHubIssueRecord,
  GitHubPullRequestRecord
} from '@/shared/project-space-api';
import type { RoadmapPlanItem } from '@/shared/roadmap-api';
import { moveRoadmapItem, roadmapIssueKey, validRoadmapMoveRange } from '@/shared/roadmap-model';
import type { RoadmapController } from '../../roadmap/use-roadmap';
import { roadmapStatusClass, roadmapStatusLabel } from '../../roadmap/roadmap-status';
import { GitHubMark } from './github-mark';
import { IssueBranchMenu, IssuePullRequestChip } from './issue-branch-menu';
import { issuePullRequestsForIssue } from './issue-branch-model';
import {
  issueUpdatedAtLabel,
  issuePlacementIndices,
  loadIssueColumnOverrides,
  resolveIssueColumn,
  resolveIssueColumnFromPlacement,
  type IssueColumnOverrides
} from './issue-board-model';
import { IssueAuthorAvatar, IssueLabelChip, IssueStatusDot } from './issue-visuals';

export function IssueListView({
  branches,
  defaultBranch,
  issues,
  onBranchCreated,
  onOpenIssue,
  placementIssues,
  pullRequests,
  roadmap,
  repoFullName
}: {
  branches: GitHubBranchRecord[];
  defaultBranch: string;
  issues: GitHubIssueRecord[];
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  placementIssues: GitHubIssueRecord[];
  pullRequests: GitHubPullRequestRecord[];
  roadmap?: RoadmapController;
  repoFullName?: string;
}) {
  const [overrides, setOverrides] = useState<IssueColumnOverrides>(() =>
    loadIssueColumnOverrides(repoFullName)
  );
  const placementIndices = useMemo(
    () => issuePlacementIndices(placementIssues),
    [placementIssues]
  );

  useEffect(() => {
    setOverrides(loadIssueColumnOverrides(repoFullName));
  }, [repoFullName]);

  return (
    <div className="issue-rise-in flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-950/40">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {roadmap?.result ? (
          <RoadmapPlanRows
            issues={issues}
            onOpenIssue={onOpenIssue}
            roadmap={roadmap}
            repoFullName={repoFullName}
          />
        ) : null}
        {roadmap?.result?.plan.items.length ? (
          <div className="border-y border-neutral-800/80 bg-neutral-950 px-3 py-2">
            <Text className="text-[11px] font-semibold uppercase tracking-[0.15em] text-neutral-500">
              Backlog · not ordered yet
            </Text>
          </div>
        ) : null}
        {issues.map((issue, index) => (
          roadmap?.result?.plan.items.some((item) => item.issue.id === issue.id) ? null :
          <IssueListRow
            branches={branches}
            key={issue.number}
            columnId={resolveIssueColumnFromPlacement(
              issue,
              index,
              overrides,
              placementIndices
            )}
            defaultBranch={defaultBranch}
            isLast={index === issues.length - 1}
            issue={issue}
            onBranchCreated={onBranchCreated}
            onAddToPlan={roadmap?.result?.canEdit && roadmap.result.dependencySync === 'current' && issue.id && repoFullName ? () => {
              const result = roadmap.result;
              if (!result) return;
              void roadmap.savePlan(result.plan.goals, [
                ...result.plan.items,
                {
                  issue: { fullName: repoFullName, id: issue.id as number, number: issue.number, url: issue.url },
                  plannedState: 'planned'
                }
              ]);
            } : undefined}
            onOpenIssue={onOpenIssue}
            pullRequests={pullRequests}
            repoFullName={repoFullName}
          />
        ))}
      </div>
    </div>
  );
}

function RoadmapPlanRows({
  issues,
  onOpenIssue,
  roadmap,
  repoFullName
}: {
  issues: GitHubIssueRecord[];
  onOpenIssue(issueNumber: number): void;
  roadmap: RoadmapController;
  repoFullName?: string;
}) {
  const result = roadmap.result;
  if (!result) return null;
  const nodesByKey = new Map(result.issues.map((node) => [roadmapIssueKey(node.issue), node]));
  const canEdit = result.canEdit && result.dependencySync === 'current';
  const visibleNumbers = new Set(issues.map((issue) => issue.number));
  const hasFilteredIssues = issues.length > 0;
  const goalsById = new Map(result.plan.goals.map((goal) => [goal.id, goal]));
  const updateItem = (target: RoadmapPlanItem, patch: Partial<RoadmapPlanItem>) => {
    void roadmap.savePlan(
      result.plan.goals,
      result.plan.items.map((item) => (
        roadmapIssueKey(item.issue) === roadmapIssueKey(target.issue) ? { ...item, ...patch } : item
      ))
    );
  };
  let previousGoalId: string | undefined;
  return (
    <ol aria-label="Planned implementation order" className="divide-y divide-neutral-900">
      {result.plan.items.map((item, index) => {
        const node = nodesByKey.get(roadmapIssueKey(item.issue));
        const issue = issues.find((entry) => entry.id === item.issue.id);
        if (hasFilteredIssues && !visibleNumbers.has(item.issue.number) && node?.state !== 'unknown') {
          return null;
        }
        const range = validRoadmapMoveRange(result.plan.items, result.dependencies, item.issue);
        const goalChanged = item.goalId !== previousGoalId;
        previousGoalId = item.goalId;
        const blockers = result.dependencies.filter((edge) => (
          roadmapIssueKey(edge.blocked) === roadmapIssueKey(item.issue)
        ));
        return (
          <li key={roadmapIssueKey(item.issue)} className="min-w-0">
            {goalChanged && item.goalId ? (
              <div className="border-b border-neutral-900 bg-neutral-900/25 px-3 py-2">
                <Text className="text-xs font-semibold text-neutral-300">
                  {goalsById.get(item.goalId)?.title ?? 'Unknown goal'}
                </Text>
              </div>
            ) : null}
            <div className="group/plan flex min-w-0 flex-wrap items-start gap-2 px-3 py-3 hover:bg-neutral-900/45">
              <Text className="mt-1 w-7 shrink-0 font-mono text-xs tabular-nums text-neutral-500">
                {index + 1}.
              </Text>
              <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', roadmapStatusClass[node?.availability ?? 'stale'])} />
              <button
                type="button"
                onClick={() => onOpenIssue(item.issue.number)}
                className="min-w-[min(100%,12rem)] flex-1 text-left"
              >
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <Text className="font-mono text-xs text-neutral-500">#{item.issue.number}</Text>
                  <Text className="min-w-0 text-sm font-medium leading-5 text-neutral-100">
                    {node?.title ?? issue?.title ?? 'Issue is not accessible'}
                  </Text>
                </span>
                <Text className="mt-1 block text-xs text-neutral-500">
                  {roadmapStatusLabel[node?.availability ?? 'stale']}
                  {blockers.length > 0
                    ? ` · depends on ${blockers.map((edge) => `${edge.blocker.fullName}#${edge.blocker.number}`).join(', ')}`
                    : ''}
                </Text>
              </button>
              <div className="ml-11 flex w-[calc(100%_-_2.75rem)] flex-wrap items-center justify-end gap-1 sm:ml-0 sm:w-auto sm:shrink-0">
                <select
                  aria-label={`Goal for issue #${item.issue.number}`}
                  disabled={!canEdit || roadmap.isSaving}
                  value={item.goalId ?? ''}
                  onChange={(event) => updateItem(item, { goalId: event.target.value || undefined })}
                  className="min-h-11 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-300 max-sm:w-full max-sm:basis-full max-sm:flex-none sm:min-h-8 sm:max-w-32 sm:flex-none"
                >
                  <option value="">No goal</option>
                  {result.plan.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
                </select>
                <Button
                  aria-label={`${item.plannedState === 'active' ? 'Mark planned' : 'Mark active'} issue #${item.issue.number}`}
                  className="max-sm:min-h-11"
                  isDisabled={!canEdit || roadmap.isSaving}
                  onPress={() => updateItem(item, { plannedState: item.plannedState === 'active' ? 'planned' : 'active' })}
                  size="sm"
                  variant={item.plannedState === 'active' ? 'primary' : 'ghost'}
                >
                  {item.plannedState === 'active' ? 'Active' : 'Planned'}
                </Button>
                <Button
                  aria-label={`Move issue #${item.issue.number} earlier`}
                  className="max-sm:min-h-11"
                  isDisabled={!canEdit || roadmap.isSaving || !range || index <= range.minimum}
                  isIconOnly
                  onPress={() => {
                    const moved = moveRoadmapItem(result.plan.items, item.issue, index - 1, result.dependencies);
                    if (moved) void roadmap.savePlan(result.plan.goals, moved);
                  }}
                  size="sm"
                  variant="ghost"
                ><ArrowUp className="size-3.5" /></Button>
                <Button
                  aria-label={`Move issue #${item.issue.number} later`}
                  className="max-sm:min-h-11"
                  isDisabled={!canEdit || roadmap.isSaving || !range || index >= range.maximum}
                  isIconOnly
                  onPress={() => {
                    const moved = moveRoadmapItem(result.plan.items, item.issue, index + 1, result.dependencies);
                    if (moved) void roadmap.savePlan(result.plan.goals, moved);
                  }}
                  size="sm"
                  variant="ghost"
                ><ArrowDown className="size-3.5" /></Button>
                <Button
                  aria-label={`Remove issue #${item.issue.number} from plan`}
                  className="max-sm:min-h-11"
                  isDisabled={!canEdit || roadmap.isSaving}
                  isIconOnly
                  onPress={() => void roadmap.savePlan(
                    result.plan.goals,
                    result.plan.items.filter((entry) => roadmapIssueKey(entry.issue) !== roadmapIssueKey(item.issue))
                  )}
                  size="sm"
                  variant="ghost"
                ><X className="size-3.5" /></Button>
              </div>
            </div>
          </li>
        );
      })}
      {result.plan.items.length === 0 ? (
        <li className="px-4 py-5 text-sm text-neutral-500">
          Nothing is planned yet. Add an issue from the backlog to define what comes next.
        </li>
      ) : null}
      {issues.filter((issue) => !result.plan.items.some((item) => item.issue.id === issue.id)).length > 0 ? null : (
        <li className="sr-only">No backlog issues.</li>
      )}
    </ol>
  );
}

function IssueListRow({
  branches,
  columnId,
  defaultBranch,
  isLast,
  issue,
  onAddToPlan,
  onBranchCreated,
  repoFullName,
  onOpenIssue,
  pullRequests
}: {
  branches: GitHubBranchRecord[];
  columnId: ReturnType<typeof resolveIssueColumn>;
  defaultBranch: string;
  isLast: boolean;
  issue: GitHubIssueRecord;
  onAddToPlan?(): void;
  onBranchCreated(branch: GitHubBranchRecord): void;
  onOpenIssue(issueNumber: number): void;
  pullRequests: GitHubPullRequestRecord[];
  repoFullName?: string;
}) {
  const updated = issueUpdatedAtLabel(issue);
  const issuePullRequests = issuePullRequestsForIssue({
    issue,
    pullRequests
  });

  return (
    <div
      className={cn(
        'group/row flex min-w-0 items-center gap-3 pl-3 pr-2 transition hover:bg-neutral-900/50',
        !isLast && 'border-b border-neutral-900'
      )}
    >
      <IssueStatusDot columnId={columnId} />
      <button
        type="button"
        onClick={() => onOpenIssue(issue.number)}
        className="flex min-w-0 flex-1 items-center gap-3 py-2.5 text-left max-sm:flex-col max-sm:items-start max-sm:gap-0.5"
      >
        <Text className="w-12 shrink-0 font-mono text-xs tabular-nums text-neutral-500 max-sm:w-auto">
          #{issue.number}
        </Text>
        <Text className="min-w-0 max-w-full truncate text-sm font-medium text-neutral-100">
          {issue.title}
        </Text>
        {issue.labels.length > 0 ? (
          <span className="hidden shrink-0 items-center gap-1 md:flex">
            {issue.labels.slice(0, 3).map((label) => (
              <IssueLabelChip key={label} label={label} />
            ))}
            {issue.labels.length > 3 ? (
              <Text className="text-[10px] text-neutral-600">+{issue.labels.length - 3}</Text>
            ) : null}
          </span>
        ) : null}
      </button>
      {onAddToPlan ? (
        <Button
          aria-label={`Add issue #${issue.number} to roadmap plan`}
          className="opacity-70 group-hover/row:opacity-100"
          isIconOnly
          onPress={onAddToPlan}
          size="sm"
          title="Add to roadmap plan"
          variant="ghost"
        >
          <ListPlus className="size-3.5" />
        </Button>
      ) : null}
      <IssueBranchMenu
        branches={branches}
        defaultBranch={defaultBranch}
        issue={issue}
        onBranchCreated={onBranchCreated}
        repoFullName={repoFullName}
      />
      {issuePullRequests.slice(0, 1).map((pullRequest) => (
        <IssuePullRequestChip
          key={pullRequest.number}
          pullRequest={pullRequest}
          className="hidden lg:inline-flex"
        />
      ))}
      <span className="hidden shrink-0 items-center gap-1.5 lg:flex">
        {issue.author ? (
          <>
            <IssueAuthorAvatar author={issue.author} />
            <Text className="max-w-28 truncate text-[11px] text-neutral-500">{issue.author}</Text>
          </>
        ) : null}
      </span>
      {updated ? (
        <Text className="hidden w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-neutral-600 sm:block">
          {updated}
        </Text>
      ) : null}
      {issue.url ? (
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open issue #${issue.number} on GitHub`}
          title="Open on GitHub"
          className="hidden size-7 shrink-0 items-center justify-center rounded-md text-neutral-600 opacity-0 transition hover:bg-neutral-800 hover:text-neutral-100 focus-visible:opacity-100 group-hover/row:opacity-100 sm:flex"
        >
          <GitHubMark className="size-3.5" />
        </a>
      ) : (
        <span className="hidden size-7 shrink-0 sm:block" />
      )}
    </div>
  );
}
