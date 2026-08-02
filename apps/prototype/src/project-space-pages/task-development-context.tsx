import { Button } from "@heroui/react";
import { Bot, ChevronDown, Circle, Globe, Laptop, Play } from "lucide-react";
import { useState } from "react";

import type { MockTask } from "./task-model";

export function TaskDevelopmentContext({
  onContinueDevelopment,
  onOpenDevServer,
  task,
}: {
  onContinueDevelopment(): void;
  onOpenDevServer(): void;
  task: MockTask;
}) {
  const [threadsOpen, setThreadsOpen] = useState(false);
  const workspace = task.workspace;
  const threads = task.agentThreads ?? (task.agentRun ? [{ id: `task-${task.number}`, name: task.agentRun.name, status: task.agentRun.status === "running" ? "running" as const : "idle" as const }] : []);

  if (!workspace || task.pullRequest?.phase !== "ready" || ["merged", "deploying", "deployed"].includes(task.stage)) return null;

  return (
    <section className="mt-5 border-t border-current/[.08] pt-4">
      <h2 className="text-xs font-semibold text-current/55">Development</h2>

      <div className="mt-3 flex min-w-0 items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-current/[.055] text-current/40">
          <Laptop className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-current/70">{workspace.machine}</span>
          <span className="mt-0.5 block truncate text-[11px] text-current/35">
            {workspace.devServer?.transport ?? "Workspace"} · {workspace.status === "clean" ? "Clean" : `${workspace.changedFiles} files changed`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-emerald-300/80">
          <Circle className="size-2 fill-current" /> Connected
        </span>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Button className="min-w-0 px-2" size="sm" variant="secondary" onPress={onOpenDevServer}>
          <Globe className="size-3.5" /> <span className="truncate">Dev server</span>
        </Button>
        <Button className="min-w-0 px-2" size="sm" variant="secondary" onPress={() => setThreadsOpen((value) => !value)}>
          <Bot className="size-3.5" /> <span className="truncate">Threads {threads.length}</span>
          <ChevronDown className={`size-3 transition-transform ${threadsOpen ? "rotate-180" : ""}`} />
        </Button>
        <Button className="min-w-0 px-2" size="sm" variant="secondary" onPress={onContinueDevelopment}>
          <Play className="size-3.5" /> <span className="truncate">Continue</span>
        </Button>
      </div>

      {threadsOpen ? (
        <div className="mt-3 divide-y divide-current/[.07] border-y border-current/[.08]">
          {threads.map((thread) => (
            <button className="flex min-h-11 w-full items-center gap-2.5 py-2 text-left transition-colors hover:text-blue-300" key={thread.id} onClick={onContinueDevelopment} type="button">
              <Bot className="size-3.5 shrink-0 text-current/30" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/60">{thread.name}</span>
              <span className={`shrink-0 text-[10px] ${thread.status === "running" ? "text-emerald-300/75" : "text-current/30"}`}>{thread.status}</span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
