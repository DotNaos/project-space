import { useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  MessageCircle,
  Rocket,
} from "lucide-react";

import { TaskComments } from "./task-comments";
import { TaskDeliveryPanel } from "./task-lifecycle-panel";
import type { MockTask, MockTaskAction } from "./task-model";
import { mockTaskStageLabel } from "./task-model";
import { TaskPreviewModal } from "./task-preview-modal";
import { TaskStatusIcon } from "./task-status-icon";

const eventIcons = [MessageCircle, GitBranch, Bot, GitCommitHorizontal, Rocket];

function TaskEventTimeline({ task }: { task: MockTask }) {
  return (
    <div className="mt-4 border-l border-current/[.09] pl-5">
      {[...task.events].reverse().map((event, index) => {
        const Icon = eventIcons[index % eventIcons.length];
        return (
          <article className="relative border-b border-current/[.07] py-3.5 first:pt-0 last:border-0" key={event.id}>
            <span className="absolute -left-[1.9rem] top-0 grid size-6 place-items-center rounded-full bg-current/[.06] text-current/35 ring-4 ring-[var(--prototype-screen-background)]">
              <Icon className="size-3" />
            </span>
            <header className="flex items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-current/70">{event.title}</h3>
              <span className="text-[10px] text-current/25">{event.time}</span>
            </header>
            <p className="mt-1 text-xs leading-5 text-current/40">{event.detail}</p>
          </article>
        );
      })}
    </div>
  );
}

export function ProjectTaskDetailPage({
  onAction,
  onBack,
  task,
}: {
  onAction(action: MockTaskAction): void;
  onBack(): void;
  projectName: string;
  task: MockTask;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const githubUrl = `https://github.com/DotNaos/project-space/issues/${task.number}`;

  return (
    <>
      <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-6 pt-2 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
        <header className="shrink-0 border-b border-current/[.08] pb-5">
          <div className="flex items-center justify-between gap-4">
            <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}>
              <ArrowLeft className="size-4" /> Tasks
            </Button>
            {task.isMockOnly ? (
              <span className="inline-flex h-8 items-center gap-1.5 px-2.5 text-xs text-current/30">
                <span className="hidden @md:inline">GitHub issue · mock</span>
                <ExternalLink className="size-3.5" />
              </span>
            ) : (
              <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-current/45 transition-[background-color,color,scale] hover:bg-current/[.05] hover:text-current active:scale-[.96]" href={githubUrl} rel="noreferrer" target="_blank">
                <span className="hidden @md:inline">GitHub issue</span>
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-current/60">
              <TaskStatusIcon task={task} /> {mockTaskStageLabel(task)}
            </span>
            <span className="text-current/20">·</span>
            <span className="text-current/35">{task.type}</span>
          </div>
          <h1 className="mt-3 max-w-4xl text-2xl font-semibold leading-tight tracking-[-.03em] @md:text-[30px]">{task.title}</h1>
          <p className="mt-2 text-xs font-medium tabular-nums text-current/30">#{task.number}</p>
        </header>

        <div className="grid min-h-0 flex-1 gap-9 overflow-y-auto py-6 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,.55fr)] @5xl:gap-14 @5xl:py-8">
          <main className="min-w-0">
            <section>
              <h2 className="text-sm font-semibold text-current/75">Task</h2>
              <p className="mt-4 max-w-3xl text-sm leading-6 text-current/60">{task.body}</p>
              {task.labels.length ? (
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {task.labels.map((label) => <span className="rounded-full bg-current/[.05] px-2 py-1 text-[10px] text-current/40" key={label}>{label}</span>)}
                </div>
              ) : null}
            </section>
            <TaskComments comments={task.comments} onSubmit={(body) => onAction({ body, type: "add-comment" })} />
            <details className="group mt-10 border-t border-current/[.08] pt-1">
              <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-1 text-xs font-medium text-current/40 transition-colors hover:text-current/70 [&::-webkit-details-marker]:hidden">
                Activity history
                <span className="text-current/25">{task.events.length}</span>
              </summary>
              <TaskEventTimeline task={task} />
            </details>
          </main>
          <div className="order-first @3xl:order-none">
            <TaskDeliveryPanel onAction={onAction} onOpenPreview={() => setPreviewOpen(true)} task={task} />
          </div>
        </div>
      </section>
      <TaskPreviewModal isOpen={previewOpen} task={task} onOpenChange={setPreviewOpen} />
    </>
  );
}
