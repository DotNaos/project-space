import {
  Chip,
  ListBox,
  ListBoxItem,
  ScrollShadow,
  Surface,
  Text
} from '@/lib/heroui-compat';
import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

interface WorkflowExplorerProps {
  onSelectWorkspace(): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
  onSelectWorktree(worktreeId: string): void;
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
          ? 'bg-slate-700/70 text-slate-50'
          : tone === 'base'
            ? 'bg-emerald-500/6 text-emerald-100 hover:bg-emerald-500/10'
            : tone === 'broken'
              ? 'bg-amber-500/6 text-amber-100 hover:bg-amber-500/10'
              : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
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
          <Surface variant="transparent" className="px-3 py-2">
            <Text className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
              Project
            </Text>
            <Text className="mt-2 block text-sm font-semibold text-slate-100">
              {project.name}
            </Text>
          </Surface>

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
        </div>
      ) : (
        <Text className="px-3 py-2 text-sm text-slate-500">
          No projects yet. Create one with the + button below.
        </Text>
      )}
    </ScrollShadow>
  );
}
