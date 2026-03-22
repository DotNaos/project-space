import { cn } from '@/lib/utils';
import type {
  ExplorerTarget,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/electron-api';

interface WorkflowExplorerProps {
  onSelectWorkspace(): void;
  project?: ProjectSpaceRecord;
  selectedExplorerTarget: ExplorerTarget;
  worktrees: ProjectWorktreeRecord[];
  onSelectWorktree(worktreeId: string): void;
}

interface TreeNodeProps {
  label: string;
  level: number;
  selected: boolean;
  badge?: string;
  tone?: 'default' | 'base' | 'broken';
  onClick(): void;
}

function TreeNode({
  label,
  level,
  selected,
  badge,
  tone = 'default',
  onClick
}: TreeNodeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${level * 16 + 14}px` }}
      className={cn(
        'group relative flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left transition',
        selected
          ? 'bg-slate-700/70 text-slate-50'
          : tone === 'base'
            ? 'bg-emerald-500/6 text-emerald-100 hover:bg-emerald-500/10'
            : tone === 'broken'
              ? 'bg-amber-500/6 text-amber-100 hover:bg-amber-500/10'
            : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
      {badge ? (
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
            tone === 'base'
              ? 'bg-emerald-500/12 text-emerald-200'
              : tone === 'broken'
                ? 'bg-amber-500/12 text-amber-200'
              : 'bg-slate-800 text-slate-400'
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function WorkflowExplorer({
  onSelectWorkspace,
  project,
  selectedExplorerTarget,
  worktrees,
  onSelectWorktree
}: WorkflowExplorerProps) {
  return (
    <section className="flex-1 overflow-y-auto px-3 py-4">
      {project ? (
        <div className="space-y-1">
          <TreeNode label={project.name} level={0} selected={false} onClick={() => undefined} />
          <TreeNode
            label="Workspace"
            level={1}
            selected={selectedExplorerTarget.kind === 'workspace'}
            badge={project.kind === 'workspace' ? 'root' : undefined}
            onClick={onSelectWorkspace}
          />
          {worktrees.map((worktree) => (
            <TreeNode
              key={worktree.id}
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
              onClick={() => onSelectWorktree(worktree.id)}
            />
          ))}
        </div>
      ) : (
        <p className="px-3 py-2 text-sm text-slate-500">
          No projects yet. Create one with the + button below.
        </p>
      )}
    </section>
  );
}
