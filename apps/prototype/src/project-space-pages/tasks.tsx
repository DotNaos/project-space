import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowRight,
  Bot,
  GitBranch,
  GitPullRequest,
  History,
  ListTodo,
  Plus,
  Search,
} from "lucide-react";

import {
  mockTaskGroup,
  mockTaskStageLabel,
  type MockTask,
  type MockTaskStage,
} from "./task-model";

type TaskFilter = "Active" | "All" | "Done" | "Needs you";
type TaskView = "history" | "tasks";

const stageOrder: MockTaskStage[] = [
  "issue",
  "branch",
  "development",
  "pull-request",
  "checks",
  "preview",
  "review",
  "merged",
  "deploying",
  "deployed",
];

function TaskProgress({ task }: { task: MockTask }) {
  const current = stageOrder.indexOf(task.stage);
  const attention = mockTaskGroup(task) === "Needs you";
  return (
    <span aria-label={`Progress: ${mockTaskStageLabel(task)}`} className="flex items-center gap-1">
      {stageOrder.slice(0, 6).map((stage, index) => (
        <span
          className={`h-1.5 rounded-full transition-[width,background-color] ${
            index <= Math.min(current, 5)
              ? attention && index === Math.min(current, 5)
                ? "w-4 bg-red-400"
                : "w-4 bg-blue-400"
              : "w-2 bg-current/[.1]"
          }`}
          key={stage}
        />
      ))}
    </span>
  );
}

function TaskRow({ onOpen, task }: { onOpen(): void; task: MockTask }) {
  const group = mockTaskGroup(task);
  return (
    <button
      aria-label={`Open task #${task.number}: ${task.title}`}
      className="group grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-current/[.07] px-1 py-4 text-left transition-[background-color,scale] hover:bg-current/[.018] active:scale-[.99] @xl:grid-cols-[minmax(0,1.45fr)_minmax(10rem,.55fr)_auto] @xl:items-center @xl:px-3"
      onClick={onOpen}
      type="button"
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs tabular-nums text-current/30">#{task.number}</span>
          <span className="truncate text-sm font-medium text-current/85 group-hover:text-current">{task.title}</span>
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-current/35">
          <span>{task.type}</span>
          {task.branch ? <span className="flex min-w-0 items-center gap-1"><GitBranch className="size-3" /><span className="max-w-52 truncate">{task.branch}</span></span> : null}
          {task.pullRequest ? <span className="flex items-center gap-1"><GitPullRequest className="size-3" />#{task.pullRequest.number}</span> : null}
          {task.agentRun ? <span className="flex items-center gap-1"><Bot className="size-3" />{task.agentRun.machine}</span> : null}
        </span>
      </span>

      <span className="hidden min-w-0 @xl:block">
        <span className={`text-xs font-medium ${group === "Needs you" ? "text-red-300" : group === "Done" ? "text-emerald-300" : "text-current/55"}`}>
          {mockTaskStageLabel(task)}
        </span>
        <span className="mt-2 block"><TaskProgress task={task} /></span>
      </span>

      <span className="flex items-center gap-2 self-center">
        <span className={`size-2 rounded-full @xl:hidden ${group === "Needs you" ? "bg-red-400" : group === "Done" ? "bg-emerald-400" : "bg-blue-400"}`} />
        <ArrowRight className="size-4 text-current/25 transition-transform group-hover:translate-x-0.5 group-hover:text-current/55" />
      </span>
    </button>
  );
}

function TaskHistoryView({ tasks }: { tasks: MockTask[] }) {
  const events = tasks.flatMap((task) => task.events.map((event) => ({ event, task }))).reverse();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
      {events.map(({ event, task }) => (
        <button
          className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-current/[.07] py-4 text-left transition-colors hover:bg-current/[.018] @md:px-3"
          key={`${task.number}-${event.id}`}
          type="button"
        >
          <span className="mt-0.5 grid size-7 place-items-center rounded-full bg-current/[.05] text-current/40">
            <History className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-current/75">{event.title}</span>
            <span className="mt-1 block text-xs leading-5 text-current/40">{event.detail}</span>
            <span className="mt-1 block truncate text-[11px] text-current/28">#{task.number} · {task.title}</span>
          </span>
          <span className="text-[11px] text-current/25">{event.time}</span>
        </button>
      ))}
    </div>
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
  const [view, setView] = useState<TaskView>("tasks");
  const visible = useMemo(() => tasks.filter((task) => {
    const group = mockTaskGroup(task);
    const matchesFilter = filter === "All" || group === filter;
    const haystack = `${task.number} ${task.title} ${task.type} ${task.labels.join(" ")} ${task.branch ?? ""}`.toLowerCase();
    return matchesFilter && haystack.includes(query.toLowerCase());
  }), [filter, query, tasks]);

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-5 pt-2 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-current/[.08] pb-4">
        <h1 className="text-2xl font-semibold tracking-[-.03em]">Tasks</h1>
        <Button size="sm" variant="primary" onPress={onNewTask}>
          <Plus className="size-4" /> New task
        </Button>
      </header>

      <div className="flex shrink-0 flex-col gap-3 border-b border-current/[.08] py-4 @lg:flex-row @lg:items-center">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-current/[.045] px-3 @lg:max-w-sm">
          <Search className="size-4 shrink-0 text-current/30" />
          <input
            aria-label="Search tasks"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-current/30"
            placeholder="Search tasks"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] @lg:ml-auto">
          {(["All", "Needs you", "Active", "Done"] as const).map((value) => (
            <button
              aria-pressed={filter === value}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-xs transition-[background-color,color,scale] active:scale-[.96] ${filter === value ? "bg-current/[.1] text-current" : "text-current/40 hover:text-current/70"}`}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {value}
              <span className="text-[10px] tabular-nums text-current/35">{value === "All" ? tasks.length : tasks.filter((task) => mockTaskGroup(task) === value).length}</span>
            </button>
          ))}
        </div>

        <div aria-label="Task view" className="flex h-9 shrink-0 items-center rounded-xl bg-current/[.05] p-1" role="group">
          {([
            ["tasks", ListTodo, "Tasks"],
            ["history", History, "History"],
          ] as const).map(([id, Icon, label]) => (
            <button
              aria-pressed={view === id}
              className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-[background-color,color,scale] active:scale-[.96] ${view === id ? "bg-current/[.1] text-current" : "text-current/40 hover:text-current/70"}`}
              key={id}
              onClick={() => setView(id)}
              type="button"
            >
              <Icon className="size-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      <p className="shrink-0 py-3 text-xs text-current/30">{projectName} · {visible.length} visible</p>
      {view === "history" ? (
        <TaskHistoryView tasks={tasks} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
          {visible.map((task) => <TaskRow key={task.number} onOpen={() => onOpenTask(task.number)} task={task} />)}
          {visible.length === 0 ? <div className="grid min-h-40 place-items-center text-sm text-current/35">No matching Tasks</div> : null}
        </div>
      )}
    </section>
  );
}
