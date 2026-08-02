import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import {
  GitBranch,
  GitMerge,
  GitPullRequest,
  Plus,
  Search,
} from "lucide-react";

import {
  mockTaskWorkflowState,
  type MockTask,
} from "./task-model";
import { TaskStatusIcon } from "./task-status-icon";

type TaskFilter = "All" | "Backlog" | "Done" | "In progress" | "Started";

function TaskSearch({
  className = "",
  onChange,
  value,
}: {
  className?: string;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <label className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full bg-current/[.045] px-3 @lg:h-9 ${className}`}>
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

function TaskRow({ onOpen, task }: { onOpen(): void; task: MockTask }) {
  const state = mockTaskWorkflowState(task);
  const pullRequestState = state === "Done" ? "Merged" : task.pullRequest?.phase === "draft" ? "Draft" : "Open";
  const PullRequestIcon = state === "Done" ? GitMerge : GitPullRequest;
  return (
    <button
      aria-label={`Open task #${task.number}: ${task.title}`}
      className="group block w-full border-b border-current/[.07] px-1 py-4 text-left transition-[background-color,scale] hover:bg-current/[.018] active:scale-[.99] @xl:px-3"
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <TaskStatusIcon task={task} />
        <span className="shrink-0 text-xs tabular-nums text-current/30">#{task.number}</span>
        {task.pullRequest ? (
          <span
            aria-label={`${pullRequestState} pull request #${task.pullRequest.number}`}
            className={`ml-auto flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-medium ${state === "Done" ? "bg-violet-500/[.12] text-violet-300" : task.pullRequest.phase === "draft" ? "bg-current/[.055] text-current/40" : "bg-emerald-500/[.12] text-emerald-300"}`}
          >
            <PullRequestIcon className="size-3" />#{task.pullRequest.number}
          </span>
        ) : null}
      </span>
      <span className="mt-2 block truncate text-sm font-medium text-current/85 group-hover:text-current">{task.title}</span>
      {task.branch ? (
        <span className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-current/35">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{task.branch}</span>
        </span>
      ) : null}
    </button>
  );
}

function TaskStatusSection({
  onOpenTask,
  state,
  tasks,
}: {
  onOpenTask(number: number): void;
  state: Exclude<TaskFilter, "All">;
  tasks: MockTask[];
}) {
  if (tasks.length === 0) return null;
  const headingId = `task-section-${state.toLowerCase().replace(" ", "-")}`;
  return (
    <section aria-labelledby={headingId} className="pt-3 first:pt-1">
      <div className="flex items-center gap-2 px-1 pb-1 text-xs font-medium text-current/45">
        <h2 id={headingId}>{state}</h2>
        <span className="text-[10px] tabular-nums text-current/25">{tasks.length}</span>
      </div>
      {tasks.map((task) => <TaskRow key={task.number} onOpen={() => onOpenTask(task.number)} task={task} />)}
    </section>
  );
}

export function ProjectTasksPage({
  onNewTask,
  onOpenTask,
  projectName,
  tasks,
}: {
  onNewTask(): void;
  onOpenTask(number: number): void;
  projectName: string;
  tasks: MockTask[];
}) {
  const [filter, setFilter] = useState<TaskFilter>("All");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => tasks.filter((task) => {
    const state = mockTaskWorkflowState(task);
    const matchesFilter = filter === "All" || state === filter;
    const haystack = `${task.number} ${task.title} ${task.type} ${task.labels.join(" ")} ${task.branch ?? ""}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
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
        <TaskSearch className="hidden @lg:flex @lg:max-w-sm" onChange={setQuery} value={query} />

        <div className="flex w-full min-w-0 items-center gap-0.5 overflow-x-auto pe-1 [scrollbar-width:none] @lg:ml-auto @lg:w-auto @lg:gap-1">
          {(["All", "Backlog", "Started", "In progress", "Done"] as const).map((value) => (
            <button
              aria-pressed={filter === value}
              className={`flex h-7 shrink-0 items-center whitespace-nowrap rounded-full px-2.5 text-[8px] transition-[background-color,color,scale] active:scale-[.96] @lg:h-9 @lg:px-[18px] @lg:text-xs ${filter === value ? "bg-current/[.1] text-current" : "text-current/40 hover:text-current/70"}`}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value}
            </button>
          ))}
        </div>

      </div>

      <div aria-label={`Tasks in ${projectName}`} className="min-h-0 flex-1 overflow-y-auto pt-2 [scrollbar-width:none]">
        {filter === "All" ? (
          <>
            <TaskStatusSection onOpenTask={onOpenTask} state="Backlog" tasks={visible.filter((task) => mockTaskWorkflowState(task) === "Backlog")} />
            <TaskStatusSection onOpenTask={onOpenTask} state="Started" tasks={visible.filter((task) => mockTaskWorkflowState(task) === "Started")} />
            <TaskStatusSection onOpenTask={onOpenTask} state="In progress" tasks={visible.filter((task) => mockTaskWorkflowState(task) === "In progress")} />
            <TaskStatusSection onOpenTask={onOpenTask} state="Done" tasks={visible.filter((task) => mockTaskWorkflowState(task) === "Done")} />
          </>
        ) : visible.map((task) => <TaskRow key={task.number} onOpen={() => onOpenTask(task.number)} task={task} />)}
        {visible.length === 0 ? <div className="grid min-h-40 place-items-center text-sm text-current/35">No matching tasks</div> : null}
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
