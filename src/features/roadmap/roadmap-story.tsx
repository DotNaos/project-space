import { ArrowDown, ExternalLink, GitBranch } from 'lucide-react';

import { Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { RoadmapIssueNode, RoadmapResult } from '@/shared/roadmap-api';
import { roadmapIssueKey } from '@/shared/roadmap-model';
import { buildRoadmapStory } from './roadmap-model';
import { roadmapStatusClass, roadmapStatusLabel } from './roadmap-status';

const rowHeight = 132;

export function RoadmapStory({
  onOpenIssue,
  onSelect,
  result,
  selectedIssueId
}: {
  onOpenIssue(issue: RoadmapIssueNode): void;
  onSelect(issue: RoadmapIssueNode): void;
  result: RoadmapResult;
  selectedIssueId?: number;
}) {
  const story = buildRoadmapStory(result.plan, result.issues, result.dependencies);
  const rowByKey = new Map(
    story.nodes.map((node, index) => [roadmapIssueKey(node.issue.issue), index])
  );
  const goalById = new Map(result.plan.goals.map((goal) => [goal.id, goal]));

  return (
    <div className="relative mx-auto w-full max-w-3xl overflow-hidden" aria-label="Roadmap dependency story">
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 h-full w-14 overflow-visible sm:w-24"
        preserveAspectRatio="none"
        viewBox={`0 0 96 ${Math.max(rowHeight, story.nodes.length * rowHeight)}`}
      >
        <defs>
          <marker id="roadmap-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgb(115 115 115)" />
          </marker>
        </defs>
        {story.edges.map((edge, index) => {
          const from = rowByKey.get(roadmapIssueKey(edge.blocker));
          const to = rowByKey.get(roadmapIssueKey(edge.blocked));
          if (from === undefined || to === undefined) return null;
          const startY = from * rowHeight + 66;
          const endY = to * rowHeight + 66;
          const trackX = 18 + (index % 4) * 12;
          return (
            <path
              key={`${roadmapIssueKey(edge.blocker)}-${roadmapIssueKey(edge.blocked)}`}
              d={`M88 ${startY} H${trackX} V${endY} H82`}
              fill="none"
              markerEnd="url(#roadmap-arrow)"
              stroke={edge.freshness === 'stale' ? 'rgb(56 189 248)' : 'rgb(82 82 82)'}
              strokeDasharray={edge.freshness === 'stale' ? '4 5' : undefined}
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      <ol className="ml-14 sm:ml-24">
        {story.nodes.map((storyNode, index) => {
          const { issue, planItem } = storyNode;
          const incoming = result.dependencies.filter((edge) => (
            roadmapIssueKey(edge.blocked) === roadmapIssueKey(issue.issue)
          ));
          const isSelected = selectedIssueId === issue.issue.id;
          return (
            <li
              key={roadmapIssueKey(issue.issue)}
              className="relative flex min-h-[132px] min-w-0 items-center border-b border-neutral-900 first:border-t"
            >
              <span className={cn(
                'absolute -left-[2.3rem] top-1/2 size-3 -translate-y-1/2 rounded-full border-2 border-neutral-950 sm:-left-[2.8rem]',
                roadmapStatusClass[issue.availability]
              )} />
              <button
                aria-current={isSelected ? 'step' : undefined}
                className={cn(
                  'group min-h-24 w-full min-w-0 rounded-xl border px-4 py-3 text-left transition motion-reduce:transition-none',
                  isSelected
                    ? 'border-neutral-500 bg-neutral-900/75'
                    : 'border-neutral-800/80 bg-neutral-950/35 hover:border-neutral-700 hover:bg-neutral-900/45'
                )}
                onClick={() => onSelect(issue)}
                type="button"
              >
                <span className="flex min-w-0 items-start gap-3">
                  <Text className="shrink-0 font-mono text-xs tabular-nums text-neutral-500">
                    {planItem ? String(storyNode.position + 1).padStart(2, '0') : '↳'}
                  </Text>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <Text className="font-mono text-xs text-neutral-500">
                        {issue.issue.fullName}#{issue.issue.number}
                      </Text>
                      <Text className="text-[11px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                        {roadmapStatusLabel[issue.availability]}
                      </Text>
                      {planItem?.plannedState === 'active' ? (
                        <Text className="text-[11px] font-semibold uppercase tracking-[0.12em] text-emerald-300">Active</Text>
                      ) : null}
                    </span>
                    <Text className="mt-1 block line-clamp-2 text-sm font-semibold leading-5 text-neutral-100">
                      {issue.title}
                    </Text>
                    <span className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
                      {planItem?.goalId ? (
                        <span>{goalById.get(planItem.goalId)?.title ?? 'Unknown goal'}</span>
                      ) : null}
                      {incoming.length > 0 ? (
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <GitBranch className="size-3 shrink-0" />
                          {incoming.map((edge) => `#${edge.blocker.number}`).join(', ')} before this
                        </span>
                      ) : (
                        <span>{index === 0 ? 'Start here when ready' : 'No open prerequisite recorded'}</span>
                      )}
                    </span>
                  </span>
                </span>
              </button>
              <button
                aria-label={`Open issue #${issue.issue.number}`}
                className="absolute right-2 top-2 grid size-8 place-items-center rounded-lg text-neutral-600 opacity-40 transition hover:bg-neutral-800 hover:text-neutral-100 hover:opacity-100 focus-visible:opacity-100"
                onClick={() => onOpenIssue(issue)}
                type="button"
              >
                {issue.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
                  ? <ArrowDown className="size-3.5 -rotate-90" />
                  : <ExternalLink className="size-3.5" />}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
