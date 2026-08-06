import { useMemo, useState } from 'react';
import { Button } from '@heroui/react';
import {
  CircleDashed,
  CircleDot,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  Plus,
  Search
} from 'lucide-react';
import type { ProjectTaskState, ProjectTaskViewModel } from './task-view-model';

type TaskFilter = 'all' | ProjectTaskState;

const filters: Array<{ id: TaskFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'backlog', label: 'Backlog' },
  { id: 'started', label: 'Started' },
  { id: 'in-progress', label: 'In progress' },
  { id: 'done', label: 'Done' }
];

const sections = filters.slice(1) as Array<{ id: ProjectTaskState; label: string }>;

function StatusIcon({ task }: { task: ProjectTaskViewModel }) {
  if (task.health === 'attention') {
    return <CircleX aria-label="Needs attention" className="size-4 shrink-0 text-red-400" />;
  }
  if (task.state === 'done') {
    return <GitMerge aria-label="Done" className="size-4 shrink-0 text-violet-400" />;
  }
  if (task.state === 'in-progress') {
    return <CircleDot aria-label="In progress" className="size-4 shrink-0 text-emerald-400" />;
  }
  if (task.state === 'started') {
    return <CircleDot aria-label="Started" className="size-4 shrink-0 text-blue-400" />;
  }
  return <CircleDashed aria-label="Backlog" className="size-4 shrink-0 text-neutral-600" />;
}

function TaskRow({ onOpen, task }: { onOpen(): void; task: ProjectTaskViewModel }) {
  const pullRequest = task.pullRequest;
  const merged = task.state === 'done' && pullRequest?.state === 'merged';
  const PullRequestIcon = merged ? GitMerge : GitPullRequest;
  return (
    <button
      aria-label={`Open task #${task.issue.number}: ${task.issue.title}`}
      className="group block w-full border-b border-current/[.07] px-1 py-4 text-left transition-[background-color,scale] hover:bg-current/[.018] active:scale-[.99] @xl:px-3"
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-xs tabular-nums text-current/30">#{task.issue.number}</span>
        {pullRequest ? (
          <span className={`ml-auto flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${merged ? 'bg-violet-500/[.12] text-violet-300' : pullRequest.isDraft ? 'bg-current/[.055] text-current/40' : 'bg-emerald-500/[.12] text-emerald-300'}`}>
            <PullRequestIcon className="size-3" />#{pullRequest.number}
          </span>
        ) : null}
      </span>
      <span className="mt-2 flex min-w-0 items-center gap-2 text-sm font-medium text-current/85 group-hover:text-current">
        <StatusIcon task={task} />
        <span className="truncate">{task.issue.title}</span>
      </span>
      {task.branch?.name ?? pullRequest?.headBranch ? (
        <span className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-current/35">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{task.branch?.name ?? pullRequest?.headBranch}</span>
        </span>
      ) : null}
    </button>
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
  const visible = useMemo(() => tasks.filter((task) => {
    if (filter !== 'all' && task.state !== filter) return false;
    const haystack = `${task.issue.number} ${task.issue.title} ${task.issue.labels.join(' ')} ${task.branch?.name ?? ''}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [filter, query, tasks]);

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-5 pt-2 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-current/[.08] pb-4">
        <h1 className="text-2xl font-semibold tracking-[-.03em]">Tasks</h1>
        <Button className="hidden @lg:inline-flex" size="sm" variant="primary" onPress={onNewTask}>
          <Plus className="size-4" /> New task
        </Button>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-current/[.08] py-3 @lg:flex-row @lg:items-center @lg:py-4">
        <div className="hidden min-w-0 flex-1 @lg:block @lg:max-w-sm"><TaskSearch onChange={setQuery} value={query} /></div>
        <div className="flex w-full min-w-0 items-center gap-px overflow-x-auto pe-1 [scrollbar-width:none] @lg:ml-auto @lg:w-auto @lg:gap-1">
          {filters.map((item) => (
            <button
              aria-pressed={filter === item.id}
              className={`flex h-7 shrink-0 items-center whitespace-nowrap rounded-full px-1.5 text-[9px] font-medium transition-[background-color,color,scale] active:scale-[.96] @lg:h-9 @lg:px-[18px] @lg:text-xs ${filter === item.id ? 'bg-current/[.1] text-current' : 'text-current/40 hover:text-current/70'}`}
              key={item.id}
              onClick={() => setFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div aria-label={`Tasks in ${projectName}`} className="min-h-0 flex-1 overflow-y-auto pt-2 [scrollbar-width:none]">
        {isLoading && tasks.length === 0 ? <p className="px-1 py-8 text-sm text-current/35">Loading GitHub tasks…</p> : null}
        {error && tasks.length === 0 ? (
          <div className="grid min-h-40 place-items-center gap-3 text-center text-sm text-current/45">
            <p>{error}</p><Button size="sm" variant="ghost" onPress={onRetry}>Retry</Button>
          </div>
        ) : null}
        {filter === 'all' ? sections.map((section) => {
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

      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-current/[.08] py-3 @lg:hidden">
        <TaskSearch onChange={setQuery} value={query} />
        <Button aria-label="New task" className="size-11 rounded-full" isIconOnly onPress={onNewTask} variant="primary">
          <Plus className="size-5" />
        </Button>
      </div>
    </section>
  );
}
