import { useEffect, useState } from 'react';
import { Drawer } from '@heroui/react';
import { ExternalLink, GitBranch, Trash2, X } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { RoadmapIssueNode } from '@/shared/roadmap-api';
import { roadmapIssueKey } from '@/shared/roadmap-model';
import type { RoadmapController } from './use-roadmap';
import { roadmapStatusLabel } from './roadmap-status';

function InspectorContent({ issue, roadmap }: { issue: RoadmapIssueNode; roadmap: RoadmapController }) {
  const result = roadmap.result;
  const [blockerRepository, setBlockerRepository] = useState(result?.repository.fullName ?? '');
  const [blockerNumber, setBlockerNumber] = useState('');
  useEffect(() => {
    setBlockerRepository(result?.repository.fullName ?? '');
    setBlockerNumber('');
  }, [issue.issue.id, result?.repository.fullName]);
  if (!result) return null;
  const canEdit = result.canEdit && result.dependencySync === 'current';
  const planItem = result.plan.items.find((item) => item.issue.id === issue.issue.id);
  const incoming = result.dependencies.filter((edge) => edge.blocked.id === issue.issue.id);
  const outgoing = result.dependencies.filter((edge) => edge.blocker.id === issue.issue.id);
  const saveItem = (patch: Partial<NonNullable<typeof planItem>>) => {
    if (!planItem) return;
    void roadmap.savePlan(result.plan.goals, result.plan.items.map((item) => (
      item.issue.id === planItem.issue.id ? { ...item, ...patch } : item
    )));
  };
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="min-w-0">
        <Text className="block font-mono text-xs text-neutral-500">
          {issue.issue.fullName}#{issue.issue.number}
        </Text>
        <Text className="mt-1 block text-base font-semibold leading-6 text-neutral-100">
          {issue.title}
        </Text>
        <Text className="mt-2 block text-xs text-neutral-500">
          {roadmapStatusLabel[issue.availability]}
        </Text>
      </div>

      {planItem ? (
        <div className="grid gap-3 border-y border-neutral-800 py-4">
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
            >
              {planItem.plannedState === 'active' ? 'Active now' : 'Mark active'}
            </Button>
            <Button
              isDisabled={!canEdit || roadmap.isSaving}
              onPress={() => void roadmap.savePlan(
                result.plan.goals,
                result.plan.items.filter((item) => roadmapIssueKey(item.issue) !== roadmapIssueKey(planItem.issue))
              )}
              size="sm"
              variant="ghost"
            >
              <Trash2 className="size-3.5" /> Back to backlog
            </Button>
          </div>
        </div>
      ) : (
        <Text className="border-y border-neutral-800 py-4 text-sm text-neutral-500">
          This is an external prerequisite. It is shown for context and is not part of this repository’s manual order.
        </Text>
      )}

      <section aria-labelledby="roadmap-prerequisites-heading">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-neutral-500" />
          <Text id="roadmap-prerequisites-heading" className="text-sm font-semibold text-neutral-200">
            Prerequisites
          </Text>
        </div>
        <div className="mt-3 grid gap-2">
          {incoming.map((edge) => (
            <div key={roadmapIssueKey(edge.blocker)} className="flex min-w-0 items-center gap-2 rounded-lg bg-neutral-900/60 px-3 py-2">
              <Text className="min-w-0 flex-1 truncate text-xs text-neutral-300">
                {edge.blocker.fullName}#{edge.blocker.number}
              </Text>
              <Button
                aria-label={`Remove prerequisite #${edge.blocker.number}`}
                isDisabled={!canEdit || roadmap.isSaving}
                isIconOnly
                onPress={() => void roadmap.removeDependency({
                  blockedIssueNumber: edge.blocked.number,
                  blocker: { fullName: edge.blocker.fullName, issueNumber: edge.blocker.number }
                })}
                size="sm"
                variant="ghost"
              ><X className="size-3.5" /></Button>
            </div>
          ))}
          {incoming.length === 0 ? <Text className="text-xs text-neutral-500">No prerequisites recorded.</Text> : null}
        </div>
        {planItem ? (
          <form
            className="mt-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const issueNumber = Number(blockerNumber);
              if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) return;
              void roadmap.addDependency({
                blockedIssueNumber: issue.issue.number,
                blocker: { fullName: blockerRepository.trim(), issueNumber }
              }).then((saved) => {
                if (saved) setBlockerNumber('');
              });
            }}
          >
            <Text className="text-xs font-medium text-neutral-400">Add exact GitHub prerequisite</Text>
            <div className="grid gap-2 sm:grid-cols-[1fr_5rem_auto]">
              <input
                aria-label="Prerequisite repository owner and name"
                className="min-h-10 min-w-0 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 placeholder:text-neutral-600"
                onChange={(event) => setBlockerRepository(event.target.value)}
                placeholder="owner/repository"
                value={blockerRepository}
              />
              <input
                aria-label="Prerequisite issue number"
                className="min-h-10 min-w-0 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 placeholder:text-neutral-600"
                min="1"
                onChange={(event) => setBlockerNumber(event.target.value)}
                placeholder="#"
                type="number"
                value={blockerNumber}
              />
              <Button
                isDisabled={!canEdit || roadmap.isSaving}
                type="submit"
                variant="secondary"
              >Add</Button>
            </div>
          </form>
        ) : null}
      </section>

      {outgoing.length > 0 ? (
        <section>
          <Text className="text-sm font-semibold text-neutral-200">Unlocks</Text>
          <div className="mt-2 grid gap-1 text-xs text-neutral-500">
            {outgoing.map((edge) => <Text key={roadmapIssueKey(edge.blocked)}>#{edge.blocked.number}</Text>)}
          </div>
        </section>
      ) : null}

      {issue.issue.url ? (
        <a className="inline-flex w-fit items-center gap-2 text-xs text-neutral-400 hover:text-neutral-100" href={issue.issue.url} rel="noreferrer" target="_blank">
          Open on GitHub <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

export function RoadmapInspector({
  issue,
  onClose,
  roadmap
}: {
  issue?: RoadmapIssueNode;
  onClose(): void;
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
  return (
    <>
      <aside className="hidden min-w-0 border-l border-neutral-800 pl-5 md:block">
        {issue ? <InspectorContent issue={issue} roadmap={roadmap} /> : (
          <Text className="text-sm text-neutral-500">Select a step to inspect its plan and prerequisites.</Text>
        )}
      </aside>
      <Drawer.Backdrop
        className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm md:hidden"
        isOpen={Boolean(issue) && isMobile}
        onOpenChange={(open) => { if (!open) onClose(); }}
      >
        <Drawer.Content className="fixed inset-x-0 bottom-0 w-full" placement="bottom">
          <Drawer.Dialog className="max-h-[min(42rem,calc(100dvh-1rem))] rounded-t-[1.75rem] border border-b-0 border-neutral-700 bg-neutral-950 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none">
            <Drawer.Handle className="mx-auto mt-2 h-1 w-14 rounded-full bg-neutral-600" />
            <Drawer.Header className="flex items-center py-4">
              <Drawer.Heading className="text-sm font-semibold text-neutral-100">Roadmap step</Drawer.Heading>
              <Drawer.CloseTrigger className="ml-auto grid size-10 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800">
                <X className="size-4" />
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body className="overflow-y-auto p-0">
              {issue ? <InspectorContent issue={issue} roadmap={roadmap} /> : null}
            </Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </>
  );
}
