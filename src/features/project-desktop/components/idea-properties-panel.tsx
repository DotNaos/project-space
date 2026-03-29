import {
  ListBox,
  ListBoxItem,
  Select,
  Surface,
  Text
} from '@heroui/react';

import type { ProjectWorktreeRecord } from '@/shared/electron-api';
import {
  getIdeaStateMeta,
  type EditableIdeaValues,
  type IdeaPresentationRecord
} from '../lib/idea-utils';

interface IdeaPropertiesPanelProps {
  assignedIdeaIds: string[];
  draftValues: EditableIdeaValues;
  onMoveIdeaToWorktree(ideaId: string, targetWorktreeId?: string): void;
  onUpdateValue<Key extends keyof EditableIdeaValues>(
    key: Key,
    value: EditableIdeaValues[Key]
  ): void;
  selectedIdea?: IdeaPresentationRecord;
  worktrees: ProjectWorktreeRecord[];
}

export function IdeaPropertiesPanel({
  assignedIdeaIds,
  draftValues,
  onMoveIdeaToWorktree,
  onUpdateValue,
  selectedIdea,
  worktrees = []
}: IdeaPropertiesPanelProps) {
  if (!selectedIdea) {
    return (
      <Surface
        variant="secondary"
        className="rounded-[2rem] border border-zinc-800/80 bg-zinc-950/38 px-5 py-5"
      >
        <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          Properties
        </Text>
        <Text className="mt-3 text-sm text-zinc-500">
          Select an idea to adjust its status and worktree.
        </Text>
      </Surface>
    );
  }

  const assignedWorktree = worktrees.find(
    (worktree) => !worktree.isBase && worktree.ideaIds.includes(selectedIdea.id)
  );
  const state = getIdeaStateMeta(selectedIdea, {
    assignedToWorktree: assignedIdeaIds.includes(selectedIdea.id)
  });

  return (
    <Surface
      variant="secondary"
      className="rounded-[2rem] border border-zinc-800/80 bg-zinc-950/38 px-5 py-5"
    >
      <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
        Properties
      </Text>

      <div className="mt-5 space-y-5">
        <div className="space-y-2">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Current state
          </Text>
          <div>
            <span
              className={
                state.id === 'in-worktree'
                  ? 'inline-flex rounded-full bg-zinc-100 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-950'
                  : state.id === 'ready'
                    ? 'inline-flex rounded-full bg-zinc-800 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-200'
                    : state.id === 'closed'
                      ? 'inline-flex rounded-full bg-zinc-900 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-500'
                      : 'inline-flex rounded-full bg-zinc-900 px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-400'
              }
            >
              {state.label}
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Status
          </Text>
          <Select
            aria-label="Idea status"
            className="w-full"
            isDisabled={selectedIdea.source !== 'github'}
            value={draftValues.githubState}
            variant="secondary"
            onChange={(value) => {
              if (value === 'open' || value === 'closed') {
                onUpdateValue('githubState', value);
              }
            }}
          >
            <Select.Trigger className="min-h-10 rounded-xl border border-zinc-800/70 bg-zinc-950/30 px-3 text-left text-zinc-200">
              <Select.Value>
                {draftValues.githubState === 'closed' ? 'Closed' : 'Open'}
              </Select.Value>
              <Select.Indicator className="text-zinc-500" />
            </Select.Trigger>
            <Select.Popover className="min-w-[220px] rounded-2xl border border-zinc-800/70 bg-zinc-900/90">
              <ListBox aria-label="Idea status options" selectionMode="single">
                <ListBoxItem id="open" textValue="Open" className="rounded-xl text-zinc-200">
                  Open
                </ListBoxItem>
                <ListBoxItem id="closed" textValue="Closed" className="rounded-xl text-zinc-200">
                  Closed
                </ListBoxItem>
              </ListBox>
            </Select.Popover>
          </Select>
          {selectedIdea.source !== 'github' ? (
            <Text className="text-xs text-zinc-500">
              Local drafts do not have an open or closed issue state yet.
            </Text>
          ) : null}
        </div>

        <div className="space-y-2">
          <Text className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
            Worktree
          </Text>
          <Select
            aria-label="Assigned worktree"
            className="w-full"
            value={assignedWorktree?.id ?? '__project__'}
            variant="secondary"
            onChange={(value) => {
              if (typeof value !== 'string') {
                return;
              }

              onMoveIdeaToWorktree(selectedIdea.id, value === '__project__' ? undefined : value);
            }}
          >
            <Select.Trigger className="min-h-10 rounded-xl border border-zinc-800/70 bg-zinc-950/30 px-3 text-left text-zinc-200">
              <Select.Value>
                {assignedWorktree?.branchName?.trim() || assignedWorktree?.name || 'Project backlog'}
              </Select.Value>
              <Select.Indicator className="text-zinc-500" />
            </Select.Trigger>
            <Select.Popover className="min-w-[220px] rounded-2xl border border-zinc-800/70 bg-zinc-900/90">
              <ListBox aria-label="Worktree options" selectionMode="single">
                <ListBoxItem id="__project__" textValue="Project backlog" className="rounded-xl text-zinc-200">
                  Project backlog
                </ListBoxItem>
                {worktrees
                  .filter((worktree) => !worktree.isBase)
                  .map((worktree) => (
                    <ListBoxItem
                      key={worktree.id}
                      id={worktree.id}
                      textValue={worktree.branchName?.trim() || worktree.name}
                      className="rounded-xl text-zinc-200"
                    >
                      {worktree.branchName?.trim() || worktree.name}
                    </ListBoxItem>
                  ))}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
      </div>
    </Surface>
  );
}
