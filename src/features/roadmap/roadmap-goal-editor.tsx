import { useState } from 'react';
import { Check, Pencil, Plus, Target, Trash2, X } from 'lucide-react';

import { Button, Text } from '@/app/dotnaos-ui';
import type { RoadmapController } from './use-roadmap';

function goalId(title: string) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42);
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Date.now().toString(36);
  return `${slug || 'goal'}-${suffix}`;
}

export function RoadmapGoalEditor({ roadmap }: { roadmap: RoadmapController }) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [editingId, setEditingId] = useState('');
  const [editingTitle, setEditingTitle] = useState('');
  const result = roadmap.result;
  if (!result) return null;
  const canEdit = result.canEdit && result.dependencySync === 'current';
  return (
    <div className="border-b border-neutral-800/80 pb-4">
      <Button onPress={() => setIsOpen((open) => !open)} size="sm" variant="ghost">
        <Target className="size-3.5" /> Goals
      </Button>
      {isOpen ? (
        <div className="mt-3 grid gap-3 rounded-xl bg-neutral-900/45 p-3">
          <div className="grid gap-2">
            {result.plan.goals.map((goal) => (
              <div key={goal.id} className="flex min-w-0 items-center gap-2">
                {editingId === goal.id ? (
                  <input
                    aria-label={`Rename goal ${goal.title}`}
                    autoFocus
                    className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100"
                    onChange={(event) => setEditingTitle(event.target.value)}
                    value={editingTitle}
                  />
                ) : <Text className="min-w-0 flex-1 text-sm font-medium text-neutral-200">{goal.title}</Text>}
                {editingId === goal.id ? (
                  <>
                    <Button
                      aria-label={`Save goal ${goal.title}`}
                      isDisabled={!editingTitle.trim() || roadmap.isSaving}
                      isIconOnly
                      onPress={() => {
                        void roadmap.savePlan(
                          result.plan.goals.map((entry) => entry.id === goal.id ? { ...entry, title: editingTitle } : entry),
                          result.plan.items
                        ).then((saved) => { if (saved) setEditingId(''); });
                      }}
                      size="sm"
                      variant="ghost"
                    ><Check className="size-3.5" /></Button>
                    <Button aria-label="Cancel rename" isIconOnly onPress={() => setEditingId('')} size="sm" variant="ghost"><X className="size-3.5" /></Button>
                  </>
                ) : (
                  <>
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
                      onPress={() => void roadmap.savePlan(
                        result.plan.goals.filter((entry) => entry.id !== goal.id),
                        result.plan.items.map((item) => item.goalId === goal.id
                          ? { ...item, goalId: undefined }
                          : item)
                      )}
                      size="sm"
                      variant="ghost"
                    ><Trash2 className="size-3.5" /></Button>
                  </>
                )}
              </div>
            ))}
          </div>
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const nextTitle = title.trim();
              if (!nextTitle) return;
              void roadmap.savePlan(
                [...result.plan.goals, { id: goalId(nextTitle), title: nextTitle }],
                result.plan.items
              ).then((saved) => { if (saved) setTitle(''); });
            }}
          >
            <input
              aria-label="New goal title"
              className="min-h-10 min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-950 px-3 text-sm text-neutral-100 placeholder:text-neutral-600"
              disabled={!canEdit || roadmap.isSaving}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Name the next outcome"
              value={title}
            />
            <Button isDisabled={!title.trim() || !canEdit || roadmap.isSaving} type="submit" variant="secondary">
              <Plus className="size-3.5" /> Add
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
