import { Button, Chip, ScrollShadow, Text } from '@heroui/react';
import { Folder, FolderPlus } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';

interface WorkflowExplorerProps {
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  onSelectWorktree(worktreeId: string): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
}

interface TargetRowProps {
  badge?: string;
  label: string;
  onPress(): void;
  selected: boolean;
}

function TargetRow({ badge, label, onPress, selected }: TargetRowProps) {
  return (
    <Button
      variant="ghost"
      onPress={onPress}
      className={cn(
        'h-auto w-full justify-start rounded-2xl px-3 py-3 text-left transition',
        selected
          ? 'bg-zinc-800/65 text-zinc-50'
          : 'text-zinc-300 hover:bg-zinc-900/30 hover:text-zinc-50'
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Folder
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            selected ? 'text-zinc-100' : 'text-zinc-500'
          )}
          strokeWidth={1.9}
        />
        <div className="min-w-0 flex-1">
          <Text className="truncate text-left text-[15px] font-medium text-current">
            {label}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-3">
          {badge ? (
            <Chip
              color="default"
              size="sm"
              variant="soft"
              className="rounded-full bg-zinc-900/85 px-2 text-[10px] uppercase tracking-[0.16em] text-zinc-100"
            >
              {badge}
            </Chip>
          ) : null}
        </div>
      </div>
    </Button>
  );
}

export function WorkflowExplorer({
  onOpenNewWorktree,
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  worktrees
}: WorkflowExplorerProps) {
  const baseWorktree = worktrees.find((worktree) => worktree.isBase);

  return (
    <ScrollShadow className="flex-1 px-4 py-5" hideScrollBar>
      {project ? (
        worktrees.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <Text className="text-[15px] font-semibold text-zinc-400">
                Worktrees
              </Text>
              <Button
                aria-label="Create new worktree"
                isIconOnly
                variant="ghost"
                onPress={onOpenNewWorktree}
                className="h-8 w-8 min-w-0 rounded-xl text-zinc-500 hover:bg-zinc-900/30 hover:text-zinc-100"
              >
                <FolderPlus className="h-4 w-4" strokeWidth={1.9} />
              </Button>
            </div>

            <div className="space-y-1">
              {worktrees.map((worktree) => {
                const isBaseRow = worktree.isBase;
                const isSelected = isBaseRow
                  ? selectedExplorerTarget.kind === 'workspace' ||
                    (selectedExplorerTarget.kind === 'worktree' &&
                      selectedExplorerTarget.worktreeId === worktree.id)
                  : selectedExplorerTarget.kind === 'worktree' &&
                    selectedExplorerTarget.worktreeId === worktree.id;

                return (
                  <TargetRow
                    key={worktree.id}
                    badge={
                      worktree.status === 'broken' ? 'broken' : worktree.isBase ? 'base' : undefined
                    }
                    label={worktree.name}
                    onPress={() => {
                      if (isBaseRow && baseWorktree?.id === worktree.id) {
                        onSelectWorkspace();
                        return;
                      }

                      onSelectWorktree(worktree.id);
                    }}
                    selected={isSelected}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <Text className="text-[15px] font-semibold text-zinc-400">
                Worktrees
              </Text>
              <Button
                aria-label="Create new worktree"
                isIconOnly
                variant="ghost"
                onPress={onOpenNewWorktree}
                className="h-8 w-8 min-w-0 rounded-xl text-zinc-500 hover:bg-zinc-900/30 hover:text-zinc-100"
              >
                <FolderPlus className="h-4 w-4" strokeWidth={1.9} />
              </Button>
            </div>

            <TargetRow
              badge={project.kind === 'workspace' ? 'root' : undefined}
              label={project.name}
              onPress={onSelectWorkspace}
              selected
            />
          </div>
        )
      ) : (
        <Text className="px-3 py-2 text-sm text-zinc-500">
          No projects yet. Create one with the + button below.
        </Text>
      )}
    </ScrollShadow>
  );
}
