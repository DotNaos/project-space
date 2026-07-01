import { ChevronRight, Files, GitBranchPlus } from 'lucide-react';
import {
  Chip,
  ListBox,
  ListBoxItem,
  ScrollShadow,
  Text
} from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

interface WorkflowExplorerProps {
  onOpenFiles(): void;
  onOpenNewWorktree(): void;
  onSelectWorkspace(): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
  onSelectWorktree(worktreeId: string): void;
}

interface TreeActionRowProps {
  icon: typeof ChevronRight;
  label: string;
  onPress(): void;
  trailingIcon?: typeof ChevronRight;
}

function TreeActionRow({ icon: LeadingIcon, label, onPress, trailingIcon: TrailingIcon }: TreeActionRowProps) {
  return (
    <button
      type="button"
      onClick={onPress}
      className="flex min-h-8 w-full items-center gap-2 rounded-xl py-2 pr-3 text-left text-sm font-medium text-neutral-400 transition hover:bg-neutral-800/70 hover:text-neutral-100"
      style={{ paddingLeft: '30px' }}
    >
      <LeadingIcon className="size-4 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {TrailingIcon ? <TrailingIcon className="size-4 shrink-0 text-neutral-600" /> : null}
    </button>
  );
}

interface TreeNodeProps {
  id: string;
  label: string;
  level: number;
  selected: boolean;
  badge?: string;
  tone?: 'default' | 'base' | 'broken';
}

function TreeNode({
  id,
  label,
  level,
  selected,
  badge,
  tone = 'default'
}: TreeNodeProps) {
  return (
    <ListBoxItem
      id={id}
      textValue={label}
      className={cn(
        'rounded-xl transition',
        selected
          ? 'bg-neutral-700/70 text-neutral-50'
          : tone === 'base'
            ? 'bg-emerald-500/6 text-emerald-100 hover:bg-emerald-500/10'
            : tone === 'broken'
              ? 'bg-amber-500/6 text-amber-100 hover:bg-amber-500/10'
              : 'text-neutral-400 hover:bg-neutral-800/70 hover:text-neutral-100'
      )}
    >
      <div
        className="flex w-full items-center gap-2 py-2 pr-3 text-left"
        style={{ paddingLeft: `${level * 16 + 14}px` }}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <Chip
          color={
            tone === 'base' ? 'success' : tone === 'broken' ? 'warning' : 'default'
          }
          size="sm"
          variant="soft"
          className="shrink-0 uppercase tracking-[0.16em]"
        >
          {badge}
        </Chip>
      ) : null}
      </div>
    </ListBoxItem>
  );
}

export function WorkflowExplorer({
  onOpenFiles,
  onOpenNewWorktree,
  onSelectWorkspace,
  project,
  selectedExplorerTarget,
  worktrees,
  onSelectWorktree
}: WorkflowExplorerProps) {
  const activeItemId =
    selectedExplorerTarget.kind === 'workspace'
      ? 'workspace'
      : `worktree:${selectedExplorerTarget.worktreeId}`;

  return (
    <ScrollShadow className="flex-1 px-3 py-4" hideScrollBar>
      {project ? (
        <div className="space-y-3">
          <ListBox
            aria-label={`${project.name} targets`}
            disallowEmptySelection
            selectedKeys={new Set([activeItemId])}
            selectionMode="single"
            onAction={(key) => {
              const value = String(key);

              if (value === 'workspace') {
                onSelectWorkspace();
                return;
              }

              if (value.startsWith('worktree:')) {
                onSelectWorktree(value.slice('worktree:'.length));
              }
            }}
            className="space-y-1"
          >
            <TreeNode
              id="workspace"
              label="Workspace"
              level={1}
              selected={selectedExplorerTarget.kind === 'workspace'}
              badge={project.kind === 'workspace' ? 'root' : undefined}
            />
            {worktrees.map((worktree) => (
            <TreeNode
              key={`worktree:${worktree.id}`}
              id={`worktree:${worktree.id}`}
              label={worktree.name}
              level={1}
              selected={
                selectedExplorerTarget.kind === 'worktree' &&
                selectedExplorerTarget.worktreeId === worktree.id
              }
              badge={
                worktree.status === 'broken'
                  ? 'broken'
                  : worktree.isBase
                    ? 'base'
                    : undefined
              }
              tone={
                worktree.status === 'broken'
                  ? 'broken'
                  : worktree.isBase
                    ? 'base'
                    : 'default'
              }
            />
          ))}
          </ListBox>

          <div className="space-y-1">
            <TreeActionRow icon={Files} label="Files" trailingIcon={ChevronRight} onPress={onOpenFiles} />
            <TreeActionRow icon={GitBranchPlus} label="New worktree" onPress={onOpenNewWorktree} />
          </div>
        </div>
      ) : (
        <Text className="px-3 py-2 text-sm text-neutral-500">
          No projects yet. Create one with the + button below.
        </Text>
      )}
    </ScrollShadow>
  );
}
