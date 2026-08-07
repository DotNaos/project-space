import { AlertDialog, Button } from "@heroui/react";
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
import { TaskCleanup } from "./task-cleanup";

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

export function nextTaskAction(task: MockTask): { action: MockTaskAction; icon: typeof Sparkles; label: string } | null {
  if (task.stage === "deployed" && task.cleanup?.remoteBranch === "exists") {
    return { action: { type: "delete-branch" }, icon: GitBranch, label: "Delete branch" };
  }
  if (!task.branch) return { action: { type: "create-branch" }, icon: GitBranch, label: "Start development" };
  if (task.stage === "branch") return { action: { type: "start-development" }, icon: Bot, label: "Start Codex" };
  if (!task.pullRequest) return { action: { type: "open-pull-request" }, icon: GitPullRequestDraft, label: "Open Draft PR" };
  if (task.pullRequest.phase === "draft") return { action: { type: "mark-pull-request-ready" }, icon: GitPullRequest, label: "First version ready" };
  if (task.pullRequest.checks === "not-started") return { action: { type: "run-checks" }, icon: Play, label: "Run checks" };
  if (task.pullRequest.checks === "running") return { action: { type: "pass-checks" }, icon: Check, label: "Pass checks" };
  if (task.pullRequest.checks === "failed") return { action: { type: "run-checks" }, icon: RefreshCw, label: "Retry checks" };
  if (task.pullRequest.preview === "not-started") return { action: { type: "start-preview" }, icon: Rocket, label: "Start Preview" };
  if (task.pullRequest.preview === "unavailable") return { action: { type: "retry-preview" }, icon: RefreshCw, label: "Retry Preview" };
  if (task.pullRequest.review !== "approved") return { action: { type: "approve-revision" }, icon: ShieldCheck, label: "Approve PR" };
  if (task.stage === "review") return { action: { type: "merge" }, icon: GitMerge, label: "Merge pull request" };
  if (task.stage === "merged") return { action: { type: "start-deployment" }, icon: Rocket, label: "Start deployment" };
  if (task.stage === "deploying") return { action: { type: "complete-deployment" }, icon: Check, label: "Verify deployment" };
  return null;
}

export function TaskPrimaryAction({
  className = "",
  onAction,
  portalContainer = null,
  task,
}: {
  className?: string;
  onAction(action: MockTaskAction): void;
  portalContainer?: HTMLElement | null;
  task: MockTask;
}) {
  const primary = nextTaskAction(task);

  if (!primary) return null;

  const needsConfirmation = primary.action.type === "delete-branch";
  const deletingBranch = primary.action.type === "delete-branch";
  const trigger = (
    <Button
      className={`${className} ${deletingBranch ? "bg-violet-400 text-neutral-950 hover:bg-violet-300" : ""}`}
      size="sm"
      variant={deletingBranch ? "secondary" : "primary"}
      onPress={needsConfirmation ? undefined : () => onAction(primary.action)}
    >
      <primary.icon className="size-4" /> {primary.label}
    </Button>
  );

  if (!needsConfirmation) return trigger;

  const dirtyCheckoutCount = task.cleanup?.worktrees.filter((worktree) => !worktree.safeToDelete).length ?? 0;

  return (
    <AlertDialog>
      {trigger}
      <AlertDialog.Backdrop
        UNSTABLE_portalContainer={portalContainer ?? undefined}
        className="z-[96] bg-black/75"
        style={portalContainer ? {
          height: "var(--device-content-height)",
          overflow: "hidden",
          position: "absolute",
          width: "var(--device-content-width)",
        } : undefined}
        variant="blur"
      >
        <AlertDialog.Container className="p-4" placement="center" size="sm">
          <AlertDialog.Dialog className="bg-[#111] text-neutral-100 ring-1 ring-inset ring-white/10">
            <AlertDialog.Header className="px-5 pb-2 pt-5">
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading className="text-base font-semibold">
                Delete merged branch?
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body className="px-5 py-2">
              <p className="text-sm leading-6 text-neutral-400">
                {`The remote branch and clean local checkouts will be removed.${dirtyCheckoutCount ? ` ${dirtyCheckoutCount} checkout${dirtyCheckoutCount === 1 ? "" : "s"} with local changes will be kept.` : ""}`}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer className="gap-2 px-5 pb-5 pt-3">
              <Button slot="close" variant="tertiary">Cancel</Button>
              <Button slot="close" variant="danger" onPress={() => onAction(primary.action)}>
                <GitBranch className="size-4" /> Delete branch
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
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
  const mergedPullRequest = ["merged", "deploying", "deployed"].includes(task.stage);
  const pipelineLabel = task.pullRequest?.checks === "failed"
    ? "Checks failed"
    : task.pullRequest?.checks === "running"
      ? "Checks running"
      : task.pullRequest?.checks === "passed"
        ? "Checks passed"
        : "Not started";
  const previewStatus = previewReady
    ? { color: "bg-emerald-400", label: "Online" }
    : task.pullRequest?.preview === "unavailable"
      ? { color: "bg-red-400", label: "Offline" }
      : { color: "bg-current/20", label: "Not ready" };
  return (
    <aside className="min-w-0">
      {draftPullRequest && task.pullRequest ? (
        <div className="flex items-center justify-between gap-3">
          <a
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-current/[.045] px-3 text-xs font-medium text-current/50 transition-[background-color,color,scale] hover:bg-current/[.075] hover:text-current/75 active:scale-[.96]"
            href={`https://github.com/DotNaos/project-space/pull/${task.pullRequest.number}`}
            rel="noreferrer"
            target="_blank"
          >
            <GitPullRequestDraft className="size-3.5" /> Draft #{task.pullRequest.number}
          </a>
          <span className="ml-auto text-xs text-current/35">Active · Draft PR</span>
          <Button size="sm" variant="secondary" onPress={onContinueDevelopment}>
            <Bot className="size-3.5" /> Continue development
          </Button>
        </div>
      ) : task.pullRequest ? (
        <>
          <div className="pb-4">
            <div>
              <Button
                aria-label={`PR deployment · ${previewStatus.label}`}
                className="w-full justify-between rounded-lg px-3 text-current/55 hover:bg-current/[.025]"
                data-testid="pr-deployment-surface"
                isDisabled={!previewReady}
                size="sm"
                style={{ fontSize: 11 }}
                variant="ghost"
                onPress={onOpenPreview}
              >
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${previewStatus.color}`} />
                  <span>PR deployment</span>
                </span>
                <span className="flex items-center gap-1 text-blue-300">
                  <span>{previewReady ? "Open" : previewStatus.label}</span>
                  {previewReady ? <ExternalLink aria-hidden="true" className="size-3" /> : null}
                </span>
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-5 border-y border-current/[.08]">
            <DeliveryFact icon={GitPullRequest} label="Pull request">
              <a
                className={mergedPullRequest
                  ? "inline-flex h-7 items-center gap-1.5 rounded-full bg-violet-500/15 px-2.5 text-xs font-semibold text-violet-300 transition-[filter,scale] hover:brightness-125 active:scale-[.96]"
                  : "inline-flex items-center gap-1 text-current/70 transition-colors hover:text-blue-300"}
                href={`https://github.com/DotNaos/project-space/pull/${task.pullRequest.number}`}
                rel="noreferrer"
                target="_blank"
              >
                {mergedPullRequest ? <GitMerge className="size-3.5" /> : null}
                {mergedPullRequest ? "Merged " : task.pullRequest.phase === "draft" ? "Draft " : ""}#{task.pullRequest.number}<ExternalLink className="size-3" />
              </a>
            </DeliveryFact>
            <DeliveryFact icon={task.pullRequest.checks === "failed" ? AlertTriangle : task.pullRequest.checks === "passed" ? Check : CircleDot} label="Pipeline">
              <span className={task.pullRequest.checks === "failed" ? "text-red-300" : task.pullRequest.checks === "passed" ? "text-emerald-300" : "text-current/70"}>{pipelineLabel}</span>
            </DeliveryFact>
          </div>
        </>
      ) : (
        <div className="border-b border-current/[.08] pb-5">
          <span className="text-[10px] text-blue-300/70">{task.branch ? "Active · Branch" : "Planning"}</span>
          <p className="mt-1 max-w-xl text-sm leading-6 text-current/55">
            {task.branch
              ? "The linked branch is ready for coding. Open a Draft PR after the first real commit."
              : "Shape the task and conversation before development starts."}
          </p>
        </div>
      )}

      <TaskDevelopmentContext
        onOpenDevServer={onOpenDevServer}
        onOpenPrototype={onOpenPrototype}
        onOpenThread={onOpenThread}
        portalContainer={portalContainer}
        task={task}
      />

      <TaskCleanup task={task} />

      {latestEvent && (attention || !task.pullRequest) ? <p className="mt-4 max-w-xl text-sm leading-6 text-current/55">{latestEvent.detail}</p> : null}

      <div className="mt-4 hidden flex-wrap gap-2 @3xl:flex" data-testid="task-panel-primary-action">
        <TaskPrimaryAction className="min-w-0 flex-1 @md:flex-none" onAction={onAction} portalContainer={portalContainer} task={task} />
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
