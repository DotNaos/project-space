import { useMemo, useState } from 'react';
import { Button, Tooltip } from '@heroui/react';
import {
  ChevronRight,
  CircleDashed,
  CircleDot,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  List,
  ListFilter,
  Plus,
  Search,
  type LucideIcon
} from 'lucide-react';
import { buildProjectTaskTree, type ProjectTaskTreeNode } from './project-task-tree';
import type { ProjectTaskState, ProjectTaskViewModel } from './task-view-model';

type TaskFilter = 'all' | ProjectTaskState;

interface TaskFilterDefinition {
  activeClassName: string;
  icon: LucideIcon;
  iconClassName: string;
  id: TaskFilter;
  label: string;
}

const filters: TaskFilterDefinition[] = [
  {
    activeClassName: 'bg-neutral-400/15 text-neutral-100',
    icon: ListFilter,
    iconClassName: 'text-neutral-400',
    id: 'all',
    label: 'All'
  },
  {
    activeClassName: 'bg-neutral-500/15 text-neutral-200',
    icon: CircleDashed,
    iconClassName: 'text-neutral-500',
    id: 'backlog',
    label: 'Backlog'
  },
  {
    activeClassName: 'bg-blue-500/15 text-blue-200',
    icon: CircleDot,
    iconClassName: 'text-blue-400',
    id: 'active',
    label: 'Active'
  },
  {
    activeClassName: 'bg-emerald-500/15 text-emerald-200',
    icon: GitPullRequest,
    iconClassName: 'text-emerald-400',
    id: 'review',
    label: 'Review'
  },
  {
    activeClassName: 'bg-violet-500/15 text-violet-200',
    icon: GitMerge,
    iconClassName: 'text-violet-400',
    id: 'completed',
    label: 'Completed'
  }
];

const sections = filters.slice(1).map(({ id, label }) => ({
  id: id as ProjectTaskState,
  label
}));

function StatusIcon({ task }: { task: ProjectTaskViewModel }) {
  if (task.health === 'attention' || task.workflowMessage) {
    return <CircleX aria-label="Needs attention" className="size-4 shrink-0 text-red-400" />;
  }
  if (task.state === 'completed') {
    return <GitMerge aria-label="Completed" className="size-4 shrink-0 text-violet-400" />;
  }
  if (task.state === 'review') {
    return <CircleDot aria-label="Review" className="size-4 shrink-0 text-emerald-400" />;
  }
  if (task.state === 'active') {
    return <CircleDot aria-label="Active" className="size-4 shrink-0 text-blue-400" />;
  }
  return <CircleDashed aria-label="Backlog" className="size-4 shrink-0 text-neutral-600" />;
}

function TaskRow({ mode = 'list', onOpen, task }: { mode?: 'list' | 'tree'; onOpen(): void; task: ProjectTaskViewModel }) {
  const pullRequest = task.pullRequest;
  const merged = pullRequest?.state === 'merged';
  const PullRequestIcon = merged ? GitMerge : GitPullRequest;
  const subIssueProgress = task.issue.subIssueProgress;
  return (
    <button
      aria-label={`Open task #${task.issue.number}: ${task.issue.title}`}
      className={`group block min-h-11 w-full text-left transition-[background-color,scale] active:scale-[.99] ${mode === 'tree' ? 'rounded-lg px-2.5 py-2 hover:bg-current/[.045] @xl:px-3' : 'border-b border-current/[.07] px-1 py-2 hover:bg-current/[.018] @xl:px-3'}`}
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[11px] tabular-nums text-current/30">#{task.issue.number}</span>
        <StatusIcon task={task} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-current/85 group-hover:text-current">{task.issue.title}</span>
        </span>
        {subIssueProgress ? (
          <span
            aria-label={`Sub-issues ${subIssueProgress.completed} of ${subIssueProgress.total} complete`}
            className="hidden shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-current/45 sm:flex"
          >
            <span aria-hidden="true" className="h-1 w-12 overflow-hidden rounded-full bg-current/[.08]">
              <span
                className="block h-full rounded-full bg-current/45"
                style={{ width: `${subIssueProgress.percentCompleted}%` }}
              />
            </span>
            {subIssueProgress.completed}/{subIssueProgress.total}
          </span>
        ) : null}
        {pullRequest ? (
          <span className={`flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${merged ? 'bg-violet-500/[.12] text-violet-300' : pullRequest.isDraft ? 'bg-current/[.055] text-current/40' : 'bg-emerald-500/[.12] text-emerald-300'}`}>
            <PullRequestIcon className="size-3" />#{pullRequest.number}
          </span>
        ) : task.state === 'active' && task.branch ? (
          <Tooltip delay={300}>
            <Tooltip.Trigger>
              <span aria-label="Branch active" className="flex shrink-0 items-center text-blue-400">
                <GitBranch className="size-3.5" />
              </span>
            </Tooltip.Trigger>
            <Tooltip.Content placement="top">Branch active</Tooltip.Content>
          </Tooltip>
        ) : null}
      </span>
      {task.workflowMessage ? (
        <span className="mt-1.5 block ps-6 text-[11px] leading-4 text-amber-300/80">
          {task.workflowMessage}
        </span>
      ) : null}
    </button>
  );
}

function TaskTreeNodeRow({ isNested = false, node, onOpen }: { isNested?: boolean; node: ProjectTaskTreeNode; onOpen(number: number): void }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <li
      aria-expanded={hasChildren ? expanded : undefined}
      className={isNested ? 'relative before:absolute before:left-[-1rem] before:top-1/2 before:h-px before:w-3 before:bg-current/[.1]' : undefined}
      role="treeitem"
    >
      <div className="flex min-w-0 items-start">
        {hasChildren ? (
          <button
            aria-label={`${expanded ? 'Collapse' : 'Expand'} sub-issues for #${node.task.issue.number}`}
            className="mt-2 flex size-7 shrink-0 items-center justify-center rounded-md text-current/35 transition hover:bg-current/[.05] hover:text-current/70"
            onClick={() => setExpanded((current) => !current)}
            type="button"
          >
            <ChevronRight aria-hidden="true" className={`size-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span aria-hidden="true" className="size-7 shrink-0" />
        )}
        <TaskRow mode="tree" onOpen={() => onOpen(node.task.issue.number)} task={node.task} />
      </div>
      {hasChildren && expanded ? (
        <ul className="relative ml-3 mt-1 space-y-1 border-l border-current/[.1] pl-3" role="group">
          {node.children.map((child) => (
            <TaskTreeNodeRow isNested key={child.task.issue.number} node={child} onOpen={onOpen} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function TaskTree({ nodes, onOpen }: { nodes: ProjectTaskTreeNode[]; onOpen(number: number): void }) {
  return (
    <ul aria-label="Task tree" className="space-y-0.5" role="tree">
      {nodes.map((node) => (
        <TaskTreeNodeRow key={node.task.issue.number} node={node} onOpen={onOpen} />
      ))}
    </ul>
  );
}

function TaskSearch({ onChange, value }: { onChange(value: string): void; value: string }) {
  return (
    <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-current/[.045] px-3 @lg:h-9">
      <Search className="size-4 shrink-0 text-current/30" />
      <input
        aria-label="Search tasks"
        className="h-full min-w-0 flex-1 bg-transparent py-0 text-sm leading-none outline-none placeholder:text-current/30"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search tasks"
        value={value}
      />
    </label>
  );
}

export function ProjectTasksPage({
  error,
  isLoading,
  onNewTask,
  onOpenTask,
  onRetry,
  projectName,
  tasks
}: {
  error?: string;
  isLoading: boolean;
  onNewTask(): void;
  onOpenTask(number: number): void;
  onRetry(): void;
  projectName: string;
  tasks: ProjectTaskViewModel[];
}) {
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [query, setQuery] = useState('');
  const [viewMode, setViewMode] = useState<'list' | 'tree'>('list');
  const visible = useMemo(() => tasks.filter((task) => {
    if (filter !== 'all' && task.state !== filter) return false;
    const haystack = `${task.issue.number} ${task.issue.title} ${task.issue.labels.join(' ')} ${task.branch?.name ?? ''} ${task.issue.parentIssue?.number ?? ''} ${task.issue.parentIssue?.title ?? ''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [filter, query, tasks]);
  const tree = useMemo(() => buildProjectTaskTree(visible), [visible]);

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-5 pt-2 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-current/[.08] pb-4">
        <h1 className="text-2xl font-semibold tracking-[-.03em]">Tasks</h1>
        <Button className="hidden @lg:inline-flex" size="sm" variant="primary" onPress={onNewTask}>
          <Plus className="size-4" /> New task
        </Button>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-current/[.08] py-3 @lg:py-4">
        <div className="hidden min-w-0 w-full @lg:block"><TaskSearch onChange={setQuery} value={query} /></div>
        <div className="flex w-full min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto pe-1 [scrollbar-width:none] @lg:gap-1">
            {filters.map((item) => {
              const Icon = item.icon;
              const selected = filter === item.id;

              return (
                <button
                  aria-pressed={selected}
                  className={`flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 text-[8px] font-medium transition-[background-color,color,scale] active:scale-[.96] @lg:h-9 @lg:gap-1.5 @lg:px-4 @lg:text-xs ${selected ? item.activeClassName : 'text-current/45 hover:bg-current/[.04] hover:text-current/75'}`}
                  key={item.id}
                  onClick={() => setFilter(item.id)}
                  type="button"
                >
                  <Icon aria-hidden="true" className={`size-3 shrink-0 @lg:size-3.5 ${item.iconClassName}`} />
                  {item.label}
                </button>
              );
            })}
          </div>
          <div aria-label="Task view" className="flex shrink-0 items-center rounded-lg bg-current/[.045] p-0.5">
            <button
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              className={`flex h-8 items-center gap-1 rounded-md px-2 text-[10px] transition-colors @lg:h-8 @lg:px-2.5 @lg:text-xs ${viewMode === 'list' ? 'bg-current/[.1] text-current/85' : 'text-current/40 hover:text-current/70'}`}
              onClick={() => setViewMode('list')}
              type="button"
            >
              <List aria-hidden="true" className="size-3.5" />
              <span className={viewMode === 'list' ? 'inline' : 'hidden @lg:inline'}>List</span>
            </button>
            <button
              aria-label="Tree view"
              aria-pressed={viewMode === 'tree'}
              className={`flex h-8 items-center gap-1 rounded-md px-2 text-[10px] transition-colors @lg:h-8 @lg:px-2.5 @lg:text-xs ${viewMode === 'tree' ? 'bg-current/[.1] text-current/85' : 'text-current/40 hover:text-current/70'}`}
              onClick={() => setViewMode('tree')}
              type="button"
            >
              <GitBranch aria-hidden="true" className="size-3.5" />
              <span className={viewMode === 'tree' ? 'inline' : 'hidden @lg:inline'}>Tree</span>
            </button>
          </div>
        </div>
      </div>

      <div aria-label={`Tasks in ${projectName}`} className="min-h-0 flex-1 overflow-y-auto pt-2 [scrollbar-width:none]">
        {isLoading && tasks.length === 0 ? <p className="px-1 py-8 text-sm text-current/35">Loading GitHub tasks…</p> : null}
        {error && tasks.length === 0 ? (
          <div className="grid min-h-40 place-items-center gap-3 text-center text-sm text-current/45">
            <p>{error}</p><Button size="sm" variant="ghost" onPress={onRetry}>Retry</Button>
          </div>
        ) : null}
        {viewMode === 'tree' ? (
          tree.length > 0 ? <TaskTree nodes={tree} onOpen={onOpenTask} /> : null
        ) : filter === 'all' ? sections.map((section) => {
          const rows = visible.filter((task) => task.state === section.id);
          if (rows.length === 0) return null;
          return (
            <section className="pt-3 first:pt-1" key={section.id}>
              <h2 className="px-1 pb-1 text-xs font-medium text-current/45">{section.label}</h2>
              {rows.map((task) => <TaskRow key={task.issue.number} onOpen={() => onOpenTask(task.issue.number)} task={task} />)}
            </section>
          );
        }) : visible.map((task) => <TaskRow key={task.issue.number} onOpen={() => onOpenTask(task.issue.number)} task={task} />)}
        {!isLoading && !error && visible.length === 0 ? <div className="grid min-h-40 place-items-center text-sm text-current/35">No matching tasks</div> : null}
      </div>

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-3 @lg:hidden">
        <TaskSearch onChange={setQuery} value={query} />
        <Button aria-label="New task" className="size-11 rounded-full" isIconOnly onPress={onNewTask} variant="primary">
          <Plus className="size-5" />
        </Button>
      </div>
    </section>
  );
}
