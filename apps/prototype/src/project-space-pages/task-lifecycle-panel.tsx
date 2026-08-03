import { Button } from "@heroui/react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  ExternalLink,
  Files,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestDraft,
  Laptop,
  MonitorPlay,
  Play,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import {
  type MockTask,
  type MockTaskAction,
} from "./task-model";
import { TaskDevelopmentContext } from "./task-development-context";

function WorkflowFact({ children, icon: Icon, label }: { children: React.ReactNode; icon: typeof GitBranch; label: string }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2.5 py-2.5">
      <Icon className="mt-0.5 size-4 text-current/30" />
      <span className="min-w-0">
        <span className="block text-[10px] text-current/30">{label}</span>
        <span className="mt-0.5 block truncate text-xs font-medium text-current/65">{children}</span>
      </span>
    </div>
  );
}

function DeliveryFact({ children, icon: Icon, label }: { children: React.ReactNode; icon: typeof GitBranch; label: string }) {
  return (
    <div className="min-w-0 py-3">
      <span className="flex items-center gap-1.5 text-[10px] text-current/30">
        <Icon className="size-3.5" /> {label}
      </span>
      <span className="mt-1.5 block truncate text-sm font-medium text-current/70">{children}</span>
    </div>
  );
}

function nextAction(task: MockTask): { action: MockTaskAction; icon: typeof Sparkles; label: string } | null {
  if (!task.branch) return { action: { type: "create-branch" }, icon: GitBranch, label: "Create branch" };
  if (task.stage === "branch") return { action: { type: "start-development" }, icon: Bot, label: "Start development" };
  if (task.stage === "development") return { action: { type: "open-pull-request" }, icon: GitPullRequest, label: "Create draft PR" };
  if (!task.pullRequest) return null;
  if (task.pullRequest.phase === "draft") return { action: { type: "mark-pull-request-ready" }, icon: Bot, label: "Start development" };
  if (task.pullRequest.checks === "not-started") return { action: { type: "run-checks" }, icon: Play, label: "Run checks" };
  if (task.pullRequest.checks === "running") return { action: { type: "pass-checks" }, icon: Check, label: "Pass checks" };
  if (task.pullRequest.checks === "failed") return { action: { type: "run-checks" }, icon: RefreshCw, label: "Retry checks" };
  if (task.pullRequest.preview === "not-started") return { action: { type: "start-preview" }, icon: Rocket, label: "Start Preview" };
  if (task.pullRequest.preview === "unavailable") return { action: { type: "retry-preview" }, icon: RefreshCw, label: "Retry Preview" };
  if (task.pullRequest.review === "pending") return { action: { type: "approve-revision" }, icon: Check, label: "Approve revision" };
  if (task.stage === "review") return { action: { type: "merge" }, icon: GitMerge, label: "Merge pull request" };
  if (task.stage === "merged") return { action: { type: "start-deployment" }, icon: Rocket, label: "Start deployment" };
  if (task.stage === "deploying") return { action: { type: "complete-deployment" }, icon: Check, label: "Verify deployment" };
  return null;
}

export function TaskPrimaryAction({
  className = "",
  onAction,
  task,
}: {
  className?: string;
  onAction(action: MockTaskAction): void;
  task: MockTask;
}) {
  const primary = nextAction(task);

  if (!primary) return null;

  const previewReady = task.pullRequest?.preview === "ready";

  return (
    <Button
      className={className}
      size="sm"
      variant={previewReady ? "secondary" : "primary"}
      onPress={() => onAction(primary.action)}
    >
      <primary.icon className="size-4" /> {primary.label}
    </Button>
  );
}

export function TaskDeliveryPanel({
  onAction,
  onContinueDevelopment,
  onOpenDevServer,
  onOpenPreview,
  onOpenPrototype,
  onOpenThread,
  portalContainer,
  task,
}: {
  onAction(action: MockTaskAction): void;
  onContinueDevelopment(): void;
  onOpenDevServer(): void;
  onOpenPreview(): void;
  onOpenPrototype(): void;
  onOpenThread(thread: NonNullable<MockTask["agentThreads"]>[number]): void;
  portalContainer: HTMLElement | null;
  task: MockTask;
}) {
  const latestEvent = task.events[task.events.length - 1];
  const attention = task.pullRequest?.checks === "failed" || task.pullRequest?.preview === "unavailable";
  const draftPullRequest = task.pullRequest?.phase === "draft";
  const previewReady = task.pullRequest?.preview === "ready";
  const pipelineLabel = task.pullRequest?.checks === "failed"
    ? "Checks failed"
    : task.pullRequest?.checks === "running"
      ? "Checks running"
      : task.pullRequest?.checks === "passed"
        ? "Checks passed"
        : "Not started";
  const previewLabel = previewReady
    ? "Ready to view"
    : task.pullRequest?.preview === "unavailable"
      ? "Unavailable"
      : task.pullRequest?.checks === "passed"
        ? "Ready to start"
        : "Waiting for checks";
  return (
    <aside className="min-w-0">
      {draftPullRequest && task.pullRequest ? (
        <a
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-current/[.045] px-3 text-xs font-medium text-current/50 transition-[background-color,color,scale] hover:bg-current/[.075] hover:text-current/75 active:scale-[.96]"
          href={`https://github.com/DotNaos/project-space/pull/${task.pullRequest.number}`}
          rel="noreferrer"
          target="_blank"
        >
          <GitPullRequestDraft className="size-3.5" /> Draft #{task.pullRequest.number}
        </a>
      ) : task.pullRequest ? (
        <>
          <div className="pb-4">
            {!previewReady ? (
              <>
                <span className="text-[10px] text-current/30">Preview</span>
                <p className={`mt-1 text-sm font-medium ${task.pullRequest.preview === "unavailable" ? "text-red-300" : "text-current/55"}`}>{previewLabel}</p>
              </>
            ) : null}
            {previewReady ? (
              <div>
                <Button className="hidden w-full @3xl:flex" size="md" variant="primary" onPress={onOpenPreview}>
                  <MonitorPlay className="size-4" /> Open Preview
                </Button>
              </div>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-x-5 border-y border-current/[.08]">
            <DeliveryFact icon={GitPullRequest} label="Pull request">
              <a className="inline-flex items-center gap-1 text-current/70 transition-colors hover:text-blue-300" href={`https://github.com/DotNaos/project-space/pull/${task.pullRequest.number}`} rel="noreferrer" target="_blank">
                {task.pullRequest.phase === "draft" ? "Draft " : ""}#{task.pullRequest.number}<ExternalLink className="size-3" />
              </a>
            </DeliveryFact>
            <DeliveryFact icon={task.pullRequest.checks === "failed" ? AlertTriangle : task.pullRequest.checks === "passed" ? Check : CircleDot} label="Pipeline">
              <span className={task.pullRequest.checks === "failed" ? "text-red-300" : task.pullRequest.checks === "passed" ? "text-emerald-300" : "text-current/70"}>{pipelineLabel}</span>
            </DeliveryFact>
          </div>
        </>
      ) : (
        <div className="border-b border-current/[.08] pb-5">
          <span className="text-[10px] text-current/30">Planning</span>
          <p className="mt-1 max-w-xl text-sm leading-6 text-current/55">Shape the task and conversation before development starts.</p>
        </div>
      )}

      <TaskDevelopmentContext
        onContinueDevelopment={onContinueDevelopment}
        onOpenDevServer={onOpenDevServer}
        onOpenPrototype={onOpenPrototype}
        onOpenThread={onOpenThread}
        portalContainer={portalContainer}
        task={task}
      />

      {latestEvent && (attention || !task.pullRequest) ? <p className="mt-4 max-w-xl text-sm leading-6 text-current/55">{latestEvent.detail}</p> : null}

      <div className={`mt-4 flex flex-wrap gap-2 ${draftPullRequest ? "hidden @3xl:flex" : ""}`} data-testid="task-panel-primary-action">
        <TaskPrimaryAction className="min-w-0 flex-1 @md:flex-none" onAction={onAction} task={task} />
        {task.deployment?.status === "deployed" ? (
          <a className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 text-xs font-medium text-emerald-300 transition-[filter,scale] hover:brightness-125 active:scale-[.96] @md:flex-none" href={task.deployment.url} rel="noreferrer" target="_blank">
            Open production <ExternalLink className="size-3.5" />
          </a>
        ) : null}
      </div>

      {(attention || !task.pullRequest) && (task.workspace || task.agentRun) ? (
        <section className="mt-6 border-t border-current/[.08] pt-5">
          <h2 className="text-xs font-semibold text-current/55">Working context</h2>
          <div className="mt-2 grid gap-x-5 @md:grid-cols-3">
            {task.workspace ? <WorkflowFact icon={Laptop} label="Machine">{task.workspace.machine}</WorkflowFact> : null}
            {task.agentRun ? <WorkflowFact icon={Bot} label="Codex thread">{task.agentRun.name} · {task.agentRun.status}</WorkflowFact> : null}
            {task.workspace ? <WorkflowFact icon={Files} label="Git status">{task.workspace.status === "clean" ? "Clean" : `${task.workspace.changedFiles} files changed`}</WorkflowFact> : null}
          </div>
        </section>
      ) : null}

      {/*
       * TODO(#437): Completed Tasks need branch and worktree cleanup evidence.
       * Show whether the merged branch still exists on GitHub and on each local
       * machine. A merged remote branch may be deleted. A local branch and its
       * worktree are safe to delete only after the checkout is clean and has no
       * unpublished work; otherwise escalate it for inspection instead of
       * offering automatic cleanup. Status filters and navigation to the full
       * Repository management view are intentionally deferred.
       */}
      {!draftPullRequest ? <details className="group mt-4 border-t border-current/[.08] pt-1">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-1 text-xs font-medium text-current/40 transition-colors hover:text-current/70 [&::-webkit-details-marker]:hidden">
          Development details
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-b border-current/[.08] pb-3">
          {task.branch ? <WorkflowFact icon={GitBranch} label={`Branch · ${task.branchRelation ?? "compared with main"}`}>{task.branch}</WorkflowFact> : null}
          {task.agentRun ? <WorkflowFact icon={Bot} label={`Agent run · ${task.agentRun.machine}`}>{task.agentRun.name} · {task.agentRun.status}</WorkflowFact> : null}
          {task.pullRequest ? (
            <>
              <WorkflowFact icon={GitPullRequest} label="Pull request">#{task.pullRequest.number}</WorkflowFact>
              <WorkflowFact icon={GitCommitHorizontal} label="Revision">{task.pullRequest.revision}</WorkflowFact>
              <WorkflowFact icon={ShieldCheck} label="Review">{task.pullRequest.review.replace("-", " ")}</WorkflowFact>
            </>
          ) : null}
          {task.deployment ? <WorkflowFact icon={Rocket} label="Production">{task.deployment.status} · {task.deployment.commit}</WorkflowFact> : null}
        </div>

        {task.pullRequest?.checks === "running" ? (
          <button className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs text-red-300/70 transition-colors hover:bg-red-500/10 hover:text-red-300" onClick={() => onAction({ type: "fail-checks" })} type="button">
            <AlertTriangle className="size-3.5" /> Simulate failed check
          </button>
        ) : null}

        {task.pullRequest?.review === "approved" && task.stage === "review" ? (
          <button className="mt-2 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs text-current/35 transition-colors hover:bg-current/[.04] hover:text-current/65" onClick={() => onAction({ type: "change-revision" })} type="button">
            <GitCommitHorizontal className="size-3.5" /> Simulate new revision
          </button>
        ) : null}
      </details> : null}
    </aside>
  );
}
