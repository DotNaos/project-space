import { useEffect, useState } from 'react';
import { Drawer } from '@heroui/react';
import { Check, Pencil, Plus, Target, Trash2, Undo2, X } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { GitHubIssueRecord } from '@/shared/project-space-api';
import type { RoadmapGoal } from '@/shared/roadmap-api';
import { RoadmapIssuePicker } from './roadmap-issue-picker';
import type { RoadmapController } from './use-roadmap';

export type RoadmapEditorMode = 'goals' | 'work' | null;

function goalId(title: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Date.now().toString(36);
  return `${slug || 'goal'}-${suffix}`;
}

export function RoadmapGoalEditor({
  issueError,
  issues,
  isLoadingIssues,
  mode,
  onModeChange,
  roadmap
}: {
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues?: boolean;
  mode: RoadmapEditorMode;
  onModeChange(mode: RoadmapEditorMode): void;
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
  const content = mode ? (
    <EditorContent
      issueError={issueError}
      issues={issues}
      isLoadingIssues={isLoadingIssues}
      mode={mode}
      onDone={() => onModeChange(null)}
      roadmap={roadmap}
    />
  ) : null;
  return (
    <>
      {mode && !isMobile ? (
        <section className="mb-5 hidden rounded-2xl border border-neutral-800 bg-neutral-950/55 p-4 md:block">
          {content}
        </section>
      ) : null}
      <Drawer.Backdrop
        className="fixed inset-0 z-[125] bg-black/65 backdrop-blur-sm md:hidden"
        isOpen={Boolean(mode) && isMobile}
        onOpenChange={(open) => { if (!open) onModeChange(null); }}
      >
        <Drawer.Content className="fixed inset-x-0 bottom-0 w-full" placement="bottom">
          <Drawer.Dialog className="max-h-[min(46rem,calc(100dvh-0.75rem))] rounded-t-[1.75rem] border border-b-0 border-neutral-700 bg-neutral-950 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
            <Drawer.Handle className="mx-auto mt-2 h-1 w-14 rounded-full bg-neutral-600" />
            <Drawer.Header className="flex items-center py-4">
              <Drawer.Heading className="text-sm font-semibold text-neutral-100">
                {mode === 'goals' ? 'Edit roadmap goals' : 'Add work to the roadmap'}
              </Drawer.Heading>
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

function EditorContent({
  issueError,
  issues,
  isLoadingIssues,
  mode,
  onDone,
  roadmap
}: {
  issueError?: string;
  issues: readonly GitHubIssueRecord[];
  isLoadingIssues?: boolean;
  mode: Exclude<RoadmapEditorMode, null>;
  onDone(): void;
  roadmap: RoadmapController;
}) {
  const result = roadmap.result;
  const [title, setTitle] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const [pickingGoalId, setPickingGoalId] = useState('');
  const [createdGoalId, setCreatedGoalId] = useState('');
  if (!result) return null;
  const canEdit = result.canEdit && result.dependencySync === 'current';
  const plannedNumbers = new Set(result.plan.items.map((item) => item.issue.number));
  const addIssue = (issueNumber: number, goalId?: string) => {
    void roadmap.addIssue(issueNumber, { goalId }).then((saved) => {
      if (saved) {
        setPickingGoalId('');
        setCreatedGoalId('');
        if (mode === 'work') onDone();
      }
    });
  };
  if (mode === 'work') {
    return (
      <div className="grid gap-3">
        {!canEdit ? (
          <Text role="status" className="text-sm text-amber-200">
            Roadmap edits are unavailable until GitHub access and dependency data are current.
          </Text>
        ) : null}
        <RoadmapIssuePicker
          error={issueError}
          excludedNumbers={plannedNumbers}
          isDisabled={!canEdit || roadmap.isSaving}
          isLoading={isLoadingIssues}
          issues={issues}
          onSelect={(issue) => addIssue(issue.number)}
          onUseExactNumber={(number) => addIssue(number)}
          title="Add an existing GitHub issue"
        />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="flex items-center gap-2 text-neutral-300">
            <Target className="size-4" />
            <Text className="text-sm font-semibold">Goals and planned work</Text>
          </span>
          <Text className="mt-1 block text-xs text-neutral-500">
            Goals group related work. Plan badges remain a separate manual order.
          </Text>
        </span>
        <Button className="hidden md:inline-flex" onPress={onDone} size="sm" variant="ghost">
          Done
        </Button>
      </div>

      <div className="grid gap-2">
        {result.plan.goals.map((goal) => {
          const assigned = result.plan.items.filter((item) => item.goalId === goal.id);
          const canUndo = createdGoalId === goal.id && assigned.length === 0;
          return (
            <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-3" key={goal.id}>
              <div className="flex min-w-0 items-center gap-2">
                {editingId === goal.id ? (
                  <input
                    aria-label={`Rename goal ${goal.title}`}
                    autoFocus
                    className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-neutral-500"
                    onChange={(event) => setEditingTitle(event.target.value)}
                    value={editingTitle}
                  />
                ) : (
                  <span className="min-w-0 flex-1">
                    <Text className="block truncate text-sm font-medium text-neutral-100">{goal.title}</Text>
                    <Text className="text-xs text-neutral-500">
                      {assigned.length > 0 ? `${assigned.length} planned issue${assigned.length === 1 ? '' : 's'}` : 'No work planned yet'}
                    </Text>
                  </span>
                )}
                {editingId === goal.id ? (
                  <>
                    <Button
                      aria-label={`Save goal ${goal.title}`}
                      isDisabled={!editingTitle.trim() || roadmap.isSaving}
                      isIconOnly
                      onPress={() => void roadmap.savePlan(
                        result.plan.goals.map((entry) => entry.id === goal.id
                          ? { ...entry, title: editingTitle.trim() }
                          : entry),
                        result.plan.items
                      ).then((saved) => { if (saved) setEditingId(''); })}
                      size="sm"
                      variant="ghost"
                    ><Check className="size-3.5" /></Button>
                    <Button aria-label="Cancel rename" isIconOnly onPress={() => setEditingId('')} size="sm" variant="ghost"><X className="size-3.5" /></Button>
                  </>
                ) : (
                  <>
                    {canUndo ? (
                      <Button
                        isDisabled={roadmap.isSaving}
                        onPress={() => void deleteGoal(goal, result.plan.goals, result.plan.items, roadmap).then((saved) => {
                          if (saved) setCreatedGoalId('');
                        })}
                        size="sm"
                        variant="ghost"
                      ><Undo2 className="size-3.5" /> Undo</Button>
                    ) : null}
                    <Button
                      aria-label={`Rename goal ${goal.title}`}
                      isDisabled={!canEdit || roadmap.isSaving}
                      isIconOnly
                      onPress={() => { setEditingId(goal.id); setEditingTitle(goal.title); }}
                      size="sm"
                      variant="ghost"
                    ><Pencil className="size-3.5" /></Button>
                    <Button
                      aria-label={`Delete goal ${goal.title}`}
                      isDisabled={!canEdit || roadmap.isSaving}
                      isIconOnly
                      onPress={() => void deleteGoal(goal, result.plan.goals, result.plan.items, roadmap)}
                      size="sm"
                      variant="ghost"
                    ><Trash2 className="size-3.5" /></Button>
                  </>
                )}
              </div>
              {assigned.length === 0 && pickingGoalId !== goal.id ? (
                <Button
                  className="mt-3"
                  isDisabled={!canEdit || roadmap.isSaving}
                  onPress={() => setPickingGoalId(goal.id)}
                  size="sm"
                  variant="secondary"
                ><Plus className="size-3.5" /> Add first issue</Button>
              ) : null}
              {pickingGoalId === goal.id ? (
                <div className="mt-3 border-t border-neutral-800 pt-3">
                  <RoadmapIssuePicker
                    error={issueError}
                    excludedNumbers={plannedNumbers}
                    isDisabled={!canEdit || roadmap.isSaving}
                    isLoading={isLoadingIssues}
                    issues={issues}
                    onSelect={(issue) => addIssue(issue.number, goal.id)}
                    onUseExactNumber={(number) => addIssue(number, goal.id)}
                    title={`Add the first issue to ${goal.title}`}
                  />
                  <Button className="mt-2" onPress={() => setPickingGoalId('')} size="sm" variant="ghost">Cancel</Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <form
        className="flex min-w-0 gap-2 border-t border-neutral-800 pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          const nextTitle = title.trim();
          if (!nextTitle) return;
          const nextGoal = { id: goalId(nextTitle), title: nextTitle };
          void roadmap.savePlan([...result.plan.goals, nextGoal], result.plan.items)
            .then((saved) => {
              if (!saved) return;
              setTitle('');
              setCreatedGoalId(nextGoal.id);
              setPickingGoalId(nextGoal.id);
            });
        }}
      >
        <input
          aria-label="New goal title"
          className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
          disabled={!canEdit || roadmap.isSaving}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Name the next outcome"
          value={title}
        />
        <Button isDisabled={!title.trim() || !canEdit || roadmap.isSaving} type="submit" variant="secondary">
          <Plus className="size-3.5" /> New goal
        </Button>
      </form>
    </div>
  );
}

function deleteGoal(
  goal: RoadmapGoal,
  goals: RoadmapGoal[],
  items: NonNullable<RoadmapController['result']>['plan']['items'],
  roadmap: RoadmapController
) {
  return roadmap.savePlan(
    goals.filter((entry) => entry.id !== goal.id),
    items.map((item) => item.goalId === goal.id ? { ...item, goalId: undefined } : item)
  );
}
