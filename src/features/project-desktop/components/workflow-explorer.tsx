import type { Project } from '@/domain';
import { cn } from '@/lib/utils';

type SelectionType = 'project' | 'sprint' | 'feature' | 'task';

interface WorkflowExplorerProps {
  project: Project;
  selection: {
    type: SelectionType;
    id: string;
  };
  onSelect(type: SelectionType, id: string): void;
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
  project,
  selection,
  onSelect
}: WorkflowExplorerProps) {
  return (
    <section className="flex-1 overflow-y-auto px-3 py-4">
        <TreeNode
          label={project.name}
          level={0}
          selected={selection.type === 'project' && selection.id === project.id}
          onClick={() => onSelect('project', project.id)}
        />

        {project.sprints.map((sprint) => (
          <div key={sprint.id}>
            <TreeNode
              label={sprint.name}
              level={1}
              selected={selection.type === 'sprint' && selection.id === sprint.id}
              onClick={() => onSelect('sprint', sprint.id)}
            />

            {sprint.features.map((feature) => (
              <div key={feature.id}>
                <TreeNode
                  label={feature.name}
                  level={2}
                  selected={selection.type === 'feature' && selection.id === feature.id}
                  onClick={() => onSelect('feature', feature.id)}
                />

                {feature.tasks.map((task) => (
                  <TreeNode
                    key={task.id}
                    label={task.name}
                    level={3}
                    selected={selection.type === 'task' && selection.id === task.id}
                    onClick={() => onSelect('task', task.id)}
                  />
                ))}
              </div>
            ))}
          </div>
        ))}
    </section>
  );
}
