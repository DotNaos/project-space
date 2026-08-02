import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowRight,
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  GitBranch,
  GitPullRequest,
  Plus,
  Search,
} from "lucide-react";

import {
  mockTaskNeedsAttention,
  mockTaskWorkflowState,
  type MockTask,
} from "./task-model";

type TaskFilter = "Backlog" | "In progress" | "Open";

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
    <label className={`flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-current/[.045] px-3 py-2.5 @lg:h-9 @lg:py-0 ${className}`}>
      <Search className="size-4 shrink-0 text-current/30" />
      <input
        aria-label="Search tasks"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-current/30"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search tasks"
        value={value}
      />
    </label>
  );
}

function TaskRow({ onOpen, task }: { onOpen(): void; task: MockTask }) {
  const state = mockTaskWorkflowState(task);
  const needsAttention = mockTaskNeedsAttention(task);
  const StatusIcon = needsAttention
    ? CircleAlert
    : state === "Backlog"
      ? CircleDashed
      : state === "Done"
        ? CircleCheck
        : CircleDot;
  const statusLabel = needsAttention ? "Needs attention" : state;
  const pullRequestState = state === "Done" ? "Merged" : task.pullRequest?.phase === "draft" ? "Draft" : "Open";
  return (
    <button
      aria-label={`Open task #${task.number}: ${task.title}`}
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-current/[.07] px-1 py-4 text-left transition-[background-color,scale] hover:bg-current/[.018] active:scale-[.99] @xl:px-3"
      onClick={onOpen}
      type="button"
    >
      <StatusIcon
        aria-label={statusLabel}
        className={`mt-0.5 size-4 shrink-0 ${needsAttention ? "text-red-400" : state === "Backlog" ? "text-current/30" : state === "Done" ? "text-violet-400" : "text-blue-400"}`}
      />

      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs tabular-nums text-current/30">#{task.number}</span>
          <span className="truncate text-sm font-medium text-current/85 group-hover:text-current">{task.title}</span>
        </span>
        {task.branch || task.pullRequest || task.agentRun ? (
          <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-current/35">
          {task.branch ? <span className="flex min-w-0 items-center gap-1"><GitBranch className="size-3" /><span className="max-w-52 truncate">{task.branch}</span></span> : null}
          {task.pullRequest ? (
            <span
              aria-label={`${pullRequestState} pull request #${task.pullRequest.number}`}
              className={`flex items-center gap-1 rounded-full px-2 py-1 font-medium ${state === "Done" ? "bg-violet-500/[.12] text-violet-300" : task.pullRequest.phase === "draft" ? "bg-current/[.055] text-current/40" : "bg-blue-500/[.12] text-blue-300"}`}
            >
              <GitPullRequest className="size-3" />#{task.pullRequest.number}
            </span>
          ) : null}
          {task.agentRun ? <span className="flex items-center gap-1"><Bot className="size-3" />{task.agentRun.machine}</span> : null}
          </span>
        ) : null}
      </span>

      <ArrowRight className="mt-0.5 size-4 text-current/25 transition-transform group-hover:translate-x-0.5 group-hover:text-current/55" />
    </button>
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
  const [filter, setFilter] = useState<TaskFilter>("Open");
  const [query, setQuery] = useState("");
  const openTasks = useMemo(() => tasks.filter((task) => mockTaskWorkflowState(task) !== "Done"), [tasks]);
  const visible = useMemo(() => openTasks.filter((task) => {
    const state = mockTaskWorkflowState(task);
    const matchesFilter = filter === "Open" || state === filter;
    const haystack = `${task.number} ${task.title} ${task.type} ${task.labels.join(" ")} ${task.branch ?? ""}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  }), [filter, openTasks, query]);

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

        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] @lg:ml-auto">
          {(["Open", "Backlog", "In progress"] as const).map((value) => (
            <button
              aria-pressed={filter === value}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs transition-[background-color,color,scale] active:scale-[.96] ${filter === value ? "bg-current/[.1] text-current" : "text-current/40 hover:text-current/70"}`}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value}
              <span className="text-[10px] tabular-nums text-current/35">{value === "Open" ? openTasks.length : openTasks.filter((task) => mockTaskWorkflowState(task) === value).length}</span>
            </button>
          ))}
        </div>

      </div>

      <div aria-label={`Open tasks in ${projectName}`} className="min-h-0 flex-1 overflow-y-auto pt-2 [scrollbar-width:none]">
        {visible.map((task) => <TaskRow key={task.number} onOpen={() => onOpenTask(task.number)} task={task} />)}
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
