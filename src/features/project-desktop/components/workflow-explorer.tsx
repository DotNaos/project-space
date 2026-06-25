import type { Project } from '@/domain';
import { cn } from '@/lib/utils';
import { ListBox, ScrollShadow } from '@heroui/react';

type SelectionType = 'project' | 'sprint' | 'feature' | 'task';

interface WorkflowExplorerProps {
  project: Project;
  selection: {
    type: SelectionType;
    id: string;
  };
  onSelect(type: SelectionType, id: string): void;
}

interface WorkflowItem {
  type: SelectionType;
  id: string;
  label: string;
  level: number;
}

function createItemKey(type: SelectionType, id: string) {
  return `${type}:${id}`;
}

function readItemKey(key: string) {
  const [type, ...rest] = key.split(':');

  if (
    type !== 'project' &&
    type !== 'sprint' &&
    type !== 'feature' &&
    type !== 'task'
  ) {
    return null;
  }

  return {
    type,
    id: rest.join(':')
  } as const;
}

function getWorkflowItems(project: Project) {
  const items: WorkflowItem[] = [
    {
      type: 'project',
      id: project.id,
      label: project.name,
      level: 0
    }
  ];

  for (const sprint of project.sprints) {
    items.push({
      type: 'sprint',
      id: sprint.id,
      label: sprint.name,
      level: 1
    });

    for (const feature of sprint.features) {
      items.push({
        type: 'feature',
        id: feature.id,
        label: feature.name,
        level: 2
      });

      for (const task of feature.tasks) {
        items.push({
          type: 'task',
          id: task.id,
          label: task.name,
          level: 3
        });
      }
    }
  }

  return items;
}

function getSelectedKey(selection: WorkflowExplorerProps['selection']) {
  return createItemKey(selection.type, selection.id);
}

function TreeNode({ item }: { item: WorkflowItem }) {
  return (
    <ListBox.Item
      id={createItemKey(item.type, item.id)}
      textValue={item.label}
      className={cn(
        'group flex items-center rounded-lg py-2 pr-3 text-slate-400 transition',
        'hover:bg-slate-800/70 hover:text-slate-100',
        'data-[selected=true]:bg-slate-700/70 data-[selected=true]:text-slate-50',
        'data-[focus-visible=true]:ring-1 data-[focus-visible=true]:ring-slate-500/50'
      )}
      style={{ paddingInlineStart: `${item.level * 16 + 14}px` }}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {item.label}
      </span>

      <ListBox.ItemIndicator className="ml-3 flex h-3 w-3 items-center justify-center">
        {({ isSelected }) =>
          isSelected ? (
            <span className="h-1.5 w-1.5 rounded-full bg-teal-300 shadow-[0_0_0_3px_rgba(45,212,191,0.1)]" />
          ) : null
        }
      </ListBox.ItemIndicator>
    </ListBox.Item>
  );
}

export function WorkflowExplorer({
  project,
  selection,
  onSelect
}: WorkflowExplorerProps) {
  const selectedKey = getSelectedKey(selection);
  const items = getWorkflowItems(project);

  return (
    <section className="flex-1 min-h-0">
      <ScrollShadow className="h-full px-3 py-4">
        <ListBox
          aria-label="Workflow explorer"
          selectionMode="single"
          selectedKeys={new Set([selectedKey])}
          onAction={(key) => {
            const next = readItemKey(String(key));

            if (next) {
              onSelect(next.type, next.id);
            }
          }}
          className="min-w-0 bg-transparent p-0"
        >
          {items.map((item) => (
            <TreeNode key={createItemKey(item.type, item.id)} item={item} />
          ))}
        </ListBox>
      </ScrollShadow>
    </section>
  );
}
