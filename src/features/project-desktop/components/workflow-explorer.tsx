import { cn } from '@/lib/utils';
import type { ProjectSpaceRecord } from '../hooks/use-project-desktop';

interface WorkflowExplorerProps {
  project?: ProjectSpaceRecord;
}

interface TreeNodeProps {
  label: string;
  level: number;
  selected: boolean;
  onClick(): void;
}

function TreeNode({
  label,
  level,
  selected,
  onClick
}: TreeNodeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ paddingLeft: `${level * 16 + 14}px` }}
      className={cn(
        'group relative flex w-full items-center rounded-lg py-2 pr-3 text-left transition',
        selected
          ? 'bg-slate-700/70 text-slate-50'
          : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100'
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
    </button>
  );
}

export function WorkflowExplorer({
  project
}: WorkflowExplorerProps) {
  return (
    <section className="flex-1 overflow-y-auto px-3 py-4">
      {project ? (
        <TreeNode label={project.name} level={0} selected onClick={() => undefined} />
      ) : (
        <p className="px-3 py-2 text-sm text-slate-500">
          No projects yet. Create one with the + button below.
        </p>
      )}
    </section>
  );
}
