import { Button, Chip, ScrollShadow, Surface, Text } from '@heroui/react';

import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';

interface WorkflowExplorerProps {
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
  secondary?: boolean;
  selected: boolean;
}

function TargetRow({ badge, label, onPress, secondary = false, selected }: TargetRowProps) {
  return (
    <Button
      variant="ghost"
      onPress={onPress}
      className={cn(
        'h-auto w-full justify-start rounded-3xl px-4 py-3 text-left transition',
        selected
          ? 'bg-zinc-800/90 text-zinc-50 shadow-[0_16px_40px_rgba(0,0,0,0.18)]'
          : secondary
            ? 'text-zinc-400 hover:bg-zinc-900/35 hover:text-zinc-100'
            : 'bg-zinc-950/18 text-zinc-300 hover:bg-zinc-900/40 hover:text-zinc-50'
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            selected ? 'bg-zinc-100' : secondary ? 'bg-zinc-600' : 'bg-zinc-500'
          )}
        />
        <Text className="min-w-0 flex-1 truncate text-left text-[15px] font-medium text-current">
          {label}
        </Text>
        {badge ? (
          <Chip
            color="default"
            size="sm"
            variant="soft"
            className="shrink-0 rounded-full bg-zinc-900/85 px-2 text-[10px] uppercase tracking-[0.16em] text-zinc-100"
          >
            {badge}
          </Chip>
        ) : null}
      </div>
    </Button>
  );
}

export function WorkflowExplorer({
  onSelectWorkspace,
  onSelectWorktree,
  project,
  selectedExplorerTarget,
  worktrees
}: WorkflowExplorerProps) {
  return (
    <ScrollShadow className="flex-1 px-4 py-5" hideScrollBar>
      {project ? (
        <Surface
          variant="secondary"
          className="rounded-[2rem] border border-zinc-800/60 bg-zinc-950/20 px-4 py-5"
        >
          <div className="space-y-3">
            <TargetRow
              badge={project.kind === 'workspace' ? 'root' : undefined}
              label="Workspace"
              onPress={onSelectWorkspace}
              selected={selectedExplorerTarget.kind === 'workspace'}
            />

            {worktrees.length > 0 ? (
              <div className="ml-6 space-y-2 border-l border-zinc-800/70 pl-5 pt-1">
                {worktrees.map((worktree) => (
                  <div key={worktree.id} className="space-y-2">
                    <TargetRow
                      badge={
                        worktree.status === 'broken'
                          ? 'broken'
                          : worktree.isBase
                            ? 'base'
                            : undefined
                      }
                      label={worktree.name}
                      onPress={() => {
                        onSelectWorktree(worktree.id);
                      }}
                      secondary
                      selected={
                        selectedExplorerTarget.kind === 'worktree' &&
                        selectedExplorerTarget.worktreeId === worktree.id
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Surface>
      ) : (
        <Text className="px-3 py-2 text-sm text-zinc-500">
          No projects yet. Create one with the + button below.
        </Text>
      )}
    </ScrollShadow>
  );
}
