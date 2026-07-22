import { useEffect, useState } from 'react';
import { Drawer } from '@heroui/react';
import {
  ExternalLink,
  GitBranch,
  Plus,
  Trash2,
  X
} from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import { IssueMarkdown } from '@/features/project-desktop/components/issue-markdown';
import { cn } from '@/lib/utils';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import {
  moveRoadmapItem,
  roadmapIssueKey,
  validRoadmapMoveRange
} from '@/shared/roadmap-model';
import {
  RoadmapRelationshipEditor,
  type RoadmapRelationshipDirection
} from './roadmap-relationship-editor';
import { roadmapStatusLabel } from './roadmap-status';
import type { RoadmapController } from './use-roadmap';

function InspectorContent({
  issue,
  issueError,
  issues,
  isLoadingIssues,
  roadmap
}: {
  issue: RoadmapIssueNode;
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues?: boolean;
  roadmap: RoadmapController;
}) {
  const result = roadmap.result;
  const [editor, setEditor] = useState<RoadmapRelationshipDirection | null>(null);
  useEffect(() => setEditor(null), [issue.issue.id]);
  if (!result) return null;
  const canEdit = result.canEdit && result.dependencySync === 'current';
  const planIndex = result.plan.items.findIndex((item) => item.issue.id === issue.issue.id);
  const planItem = planIndex >= 0 ? result.plan.items[planIndex] : undefined;
  const moveRange = planItem
    ? validRoadmapMoveRange(result.plan.items, result.dependencies, planItem.issue)
    : undefined;
  const otherPlanItems = planItem
    ? result.plan.items.filter((item) => item.issue.id !== planItem.issue.id)
    : [];
  const incoming = result.dependencies.filter((edge) => edge.blocked.id === issue.issue.id);
  const outgoing = result.dependencies.filter((edge) => edge.blocker.id === issue.issue.id);
  const nodesById = new Map(result.issues.map((node) => [node.issue.id, node]));
  const catalogIssue = issues.find((entry) => (
    entry.number === issue.issue.number
    && issue.issue.fullName.toLowerCase() === result.repository.fullName.toLowerCase()
  ));
  const saveItem = (patch: Partial<NonNullable<typeof planItem>>) => {
    if (!planItem) return;
    void roadmap.savePlan(result.plan.goals, result.plan.items.map((item) => (
      item.issue.id === planItem.issue.id ? { ...item, ...patch } : item
    )));
  };
  return (
    <div className="flex min-w-0 flex-col gap-5 pb-4">
      <div className="min-w-0">
        <Text className="block font-mono text-xs text-emerald-400">
          {issue.issue.fullName}#{issue.issue.number}
        </Text>
        <Text className="mt-1 block text-base font-semibold leading-6 text-neutral-100">
          {issue.title}
        </Text>
        <Text className="mt-2 inline-flex rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400">
          {roadmapStatusLabel[issue.availability]}
        </Text>
      </div>

      <section className="border-t border-neutral-800 pt-4" aria-labelledby="roadmap-description-heading">
        <Text id="roadmap-description-heading" className="block text-xs font-semibold text-neutral-300">
          Description
        </Text>
        {isLoadingIssues && !catalogIssue ? (
          <div aria-label="Loading issue description" className="mt-3 grid gap-2">
            <span className="h-3 w-full animate-pulse rounded bg-neutral-800" />
            <span className="h-3 w-4/5 animate-pulse rounded bg-neutral-800" />
            <span className="h-3 w-2/3 animate-pulse rounded bg-neutral-800" />
          </div>
        ) : issueError && !catalogIssue ? (
          <Text className="mt-2 block text-xs text-rose-300">{issueError}</Text>
        ) : catalogIssue ? (
          <IssueMarkdown
            className="mt-3 text-sm leading-6 text-neutral-300"
            emptyText="No description provided."
            markdown={catalogIssue.body}
            repositoryFullName={result.repository.fullName}
          />
        ) : (
          <Text className="mt-2 block text-xs leading-5 text-neutral-500">
            Description unavailable for this external or inaccessible issue.
          </Text>
        )}
      </section>

      {planItem ? (
        <section className="grid gap-3 border-y border-neutral-800 py-4" aria-labelledby="roadmap-plan-order-heading">
          <div className="flex items-center justify-between gap-3">
            <span>
              <Text id="roadmap-plan-order-heading" className="block text-xs font-semibold text-neutral-300">Manual plan order</Text>
              <Text className="text-[11px] text-neutral-500">Dependencies use arrows; this is a separate priority.</Text>
            </span>
            <Text className="rounded border border-neutral-700 px-2 py-1 font-mono text-xs tabular-nums text-neutral-300">
              {String(planIndex + 1).padStart(2, '0')}
            </Text>
          </div>
          <label className="grid gap-1.5 text-xs text-neutral-400">
            Plan position
            <select
              className="min-h-10 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100"
              disabled={!canEdit || roadmap.isSaving || !moveRange}
              onChange={(event) => {
                const moved = moveRoadmapItem(
                  result.plan.items,
                  planItem.issue,
                  Number(event.target.value),
                  result.dependencies
                );
                if (moved) void roadmap.savePlan(result.plan.goals, moved);
              }}
              value={planIndex}
            >
              {Array.from({ length: result.plan.items.length }, (_, index) => (
                <option
                  disabled={!moveRange || index < moveRange.minimum || index > moveRange.maximum}
                  key={index}
                  value={index}
                >
                  {index === 0
                    ? `Beginning${otherPlanItems[0] ? ` · before #${otherPlanItems[0].issue.number}` : ''}`
                    : index === result.plan.items.length - 1
                      ? `End${otherPlanItems.at(-1) ? ` · after #${otherPlanItems.at(-1)?.issue.number}` : ''}`
                      : `Before #${otherPlanItems[index]?.issue.number}`}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1.5 text-xs text-neutral-400">
            Goal
            <select
              className="min-h-10 w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100"
              disabled={!canEdit || roadmap.isSaving}
              onChange={(event) => saveItem({ goalId: event.target.value || undefined })}
              value={planItem.goalId ?? ''}
            >
              <option value="">No goal</option>
              {result.plan.goals.map((goal) => <option key={goal.id} value={goal.id}>{goal.title}</option>)}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              isDisabled={!canEdit || roadmap.isSaving}
              onPress={() => saveItem({ plannedState: planItem.plannedState === 'active' ? 'planned' : 'active' })}
              size="sm"
              variant={planItem.plannedState === 'active' ? 'primary' : 'secondary'}
            >{planItem.plannedState === 'active' ? 'Active now' : 'Mark active'}</Button>
            <Button
              isDisabled={!result.canEdit || roadmap.isSaving}
              onPress={() => void roadmap.savePlan(
                result.plan.goals,
                result.plan.items.filter((item) => roadmapIssueKey(item.issue) !== roadmapIssueKey(planItem.issue))
              )}
              size="sm"
              variant="ghost"
            ><Trash2 className="size-3.5" /> Back to backlog</Button>
          </div>
        </section>
      ) : (
        <Text className="border-y border-neutral-800 py-4 text-sm text-neutral-500">
          External prerequisite shown for graph context; it has no local plan-order badge.
        </Text>
      )}

      <RelationshipList
        canEdit={canEdit}
        direction="prerequisite"
        edges={incoming.map((edge) => ({
          id: roadmapIssueKey(edge.blocker),
          issue: edge.blocker,
          node: nodesById.get(edge.blocker.id),
          remove: () => roadmap.removeDependency({
            blockedIssueNumber: edge.blocked.number,
            blocker: { fullName: edge.blocker.fullName, issueNumber: edge.blocker.number }
          })
        }))}
        isSaving={roadmap.isSaving}
        onAdd={() => setEditor('prerequisite')}
      />
      <RelationshipList
        canEdit={canEdit}
        direction="successor"
        edges={outgoing.map((edge) => ({
          id: roadmapIssueKey(edge.blocked),
          issue: edge.blocked,
          node: nodesById.get(edge.blocked.id),
          remove: () => roadmap.removeDependency({
            blockedIssueNumber: edge.blocked.number,
            blocker: { fullName: edge.blocker.fullName, issueNumber: edge.blocker.number }
          })
        }))}
        isSaving={roadmap.isSaving}
        onAdd={() => setEditor('successor')}
      />

      {editor ? (
        <RoadmapRelationshipEditor
          direction={editor}
          issue={issue}
          issueError={issueError}
          issues={issues}
          isLoadingIssues={isLoadingIssues}
          onClose={() => setEditor(null)}
          roadmap={roadmap}
        />
      ) : null}

      {issue.issue.url ? (
        <a className="inline-flex min-h-10 w-fit items-center gap-2 text-xs text-neutral-400 hover:text-neutral-100" href={issue.issue.url} rel="noreferrer" target="_blank">
          Open on GitHub <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function RelationshipList({
  canEdit,
  direction,
  edges,
  isSaving,
  onAdd
}: {
  canEdit: boolean;
  direction: RoadmapRelationshipDirection;
  edges: Array<{
    id: string;
    issue: RoadmapIssueNode['issue'];
    node?: RoadmapIssueNode;
    remove(): Promise<boolean>;
  }>;
  isSaving: boolean;
  onAdd(): void;
}) {
  const prerequisite = direction === 'prerequisite';
  return (
    <section aria-label={prerequisite ? 'Prerequisites' : 'Successors'}>
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-neutral-500" />
        <Text className="text-sm font-semibold text-neutral-200">
          {prerequisite ? 'Prerequisites' : 'Unlocks'}
        </Text>
      </div>
      <div className="mt-2 grid gap-2">
        {edges.map((edge) => (
          <div className="flex min-w-0 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/45 px-3 py-2" key={edge.id}>
            <span className="min-w-0 flex-1">
              <Text className="block font-mono text-[11px] text-neutral-500">{edge.issue.fullName}#{edge.issue.number}</Text>
              <Text className="line-clamp-2 text-xs text-neutral-200">{edge.node?.title ?? 'Issue is not accessible'}</Text>
            </span>
            <Button
              aria-label={`Remove ${prerequisite ? 'prerequisite' : 'successor'} #${edge.issue.number}`}
              isDisabled={!canEdit || isSaving}
              isIconOnly
              onPress={() => void edge.remove()}
              size="sm"
              variant="ghost"
            ><X className="size-3.5" /></Button>
          </div>
        ))}
        {edges.length === 0 ? (
          <Text className="text-xs text-neutral-500">
            {prerequisite ? 'No prerequisites. This is a graph root.' : 'No successors. This is a valid terminal branch.'}
          </Text>
        ) : null}
      </div>
      <Button className="mt-3 w-full" isDisabled={!canEdit || isSaving} onPress={onAdd} size="sm" variant="secondary">
        <Plus className="size-3.5" /> Add {prerequisite ? 'prerequisite' : 'successor'}
      </Button>
    </section>
  );
}

export function RoadmapInspector({
  issue,
  issueError,
  issues,
  isLoadingIssues,
  onClose,
  overlay = false,
  roadmap
}: {
  issue?: RoadmapIssueNode;
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues?: boolean;
  onClose(): void;
  overlay?: boolean;
  roadmap: RoadmapController;
}) {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const content = issue ? (
    <InspectorContent
      issue={issue}
      issueError={issueError}
      issues={issues}
      isLoadingIssues={isLoadingIssues}
      roadmap={roadmap}
    />
  ) : null;
  return (
    <>
      {!overlay || issue ? <aside className={cn(
        'hidden min-w-0 border-l border-neutral-800 md:block',
        overlay
          ? 'absolute inset-y-0 right-0 z-40 w-[23rem] overflow-y-auto bg-neutral-950/95 p-5 shadow-2xl shadow-black/60 backdrop-blur-xl'
          : 'pl-5'
      )}>
        {!isMobile
          ? issue ? <>
            {overlay ? (
              <Button aria-label="Close issue inspector" className="mb-3 ml-auto" isIconOnly onPress={onClose} size="sm" variant="ghost">
                <X className="size-4" />
              </Button>
            ) : null}
            {content}
          </> : overlay ? null : <Text className="text-sm text-neutral-500">Select an issue or dependency arrow to inspect it.</Text>
          : null}
      </aside> : null}
      <Drawer.Backdrop
        className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-sm md:hidden"
        isOpen={Boolean(issue) && isMobile}
        onOpenChange={(open) => { if (!open) onClose(); }}
      >
        <Drawer.Content className="fixed inset-x-0 bottom-0 w-full" placement="bottom">
          <Drawer.Dialog className="max-h-[min(38rem,68dvh)] rounded-t-[1.75rem] border border-b-0 border-neutral-700 bg-neutral-950 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
            <Drawer.Handle className="mx-auto mt-2 h-1 w-14 rounded-full bg-neutral-600" />
            <Drawer.Header className="flex items-center py-3">
              <Drawer.Heading className="text-sm font-semibold text-neutral-100">Roadmap issue</Drawer.Heading>
              <Drawer.CloseTrigger className="ml-auto grid size-10 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800">
                <X className="size-4" />
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="overflow-y-auto p-0">{isMobile ? content : null}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </>
  );
}
