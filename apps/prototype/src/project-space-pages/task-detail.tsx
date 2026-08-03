import { useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowLeft,
  Bot,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  MessageCircle,
  MonitorPlay,
  Rocket,
} from "lucide-react";

import { TaskComments } from "./task-comments";
import { TaskDeliveryPanel, TaskPrimaryAction } from "./task-lifecycle-panel";
import type { MockTask, MockTaskAction, MockTaskAgentThread } from "./task-model";
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
  portalContainer = null,
  task,
}: {
  onAction(action: MockTaskAction): void;
  onBack(): void;
  portalContainer?: HTMLElement | null;
  projectName: string;
  task: MockTask;
}) {
  const [reviewSurface, setReviewSurface] = useState<"development" | "preview" | "prototype" | "thread" | null>(null);
  const [selectedThread, setSelectedThread] = useState<MockTaskAgentThread | null>(null);
  const githubUrl = `https://github.com/DotNaos/project-space/issues/${task.number}`;

  return (
    <>
      <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-0 pt-2 @md:px-8 @3xl:px-10 @3xl:pb-6 @5xl:px-12 @5xl:pt-7">
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

          <h1 className="mt-4 flex max-w-4xl items-start gap-2.5 text-2xl font-semibold leading-tight tracking-[-.03em] @md:text-[30px]">
            <TaskStatusIcon className="mt-1 size-5 @md:mt-1.5 @md:size-6" task={task} />
            <span>{task.title}</span>
          </h1>
          <p className="mt-2 text-xs font-medium tabular-nums text-current/30">#{task.number}</p>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-current/60">{task.body}</p>
          {task.labels.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {task.labels.map((label) => <span className="rounded-full bg-current/[.05] px-2 py-1 text-[10px] text-current/40" key={label}>{label}</span>)}
            </div>
          ) : null}
        </header>

        <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto py-4 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,.55fr)] @3xl:gap-9 @3xl:py-6 @5xl:gap-14 @5xl:py-8">
          <main className="min-w-0">
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
            <TaskDeliveryPanel
              onAction={onAction}
              onContinueDevelopment={() => setReviewSurface("thread")}
              onOpenDevServer={() => setReviewSurface("development")}
              onOpenPreview={() => setReviewSurface("preview")}
              onOpenPrototype={() => setReviewSurface("prototype")}
              onOpenThread={(thread) => {
                setSelectedThread(thread);
                setReviewSurface("thread");
              }}
              portalContainer={portalContainer}
              task={task}
            />
          </div>
        </div>
        {task.pullRequest?.phase === "draft" || task.pullRequest?.preview === "ready" ? (
          <footer
            className="-mx-5 shrink-0 border-t border-current/[.08] bg-[var(--prototype-screen-background)] px-5 pb-4 pt-3 @md:-mx-8 @md:px-8 @3xl:hidden"
            data-testid="task-mobile-primary-action"
          >
            {task.pullRequest.preview === "ready" ? (
              <Button className="w-full" size="md" variant="primary" onPress={() => setReviewSurface("preview")}>
                <MonitorPlay className="size-4" /> Open Preview
              </Button>
            ) : (
              <TaskPrimaryAction className="w-full" onAction={onAction} task={task} />
            )}
          </footer>
        ) : null}
      </section>
      <TaskPreviewModal
        isOpen={reviewSurface !== null}
        surface={reviewSurface ?? "preview"}
        task={task}
        portalContainer={portalContainer}
        thread={selectedThread ?? task.agentThreads?.find((thread) => thread.status === "running") ?? task.agentThreads?.[0]}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setReviewSurface(null);
            setSelectedThread(null);
          }
        }}
      />
    </>
  );
}
