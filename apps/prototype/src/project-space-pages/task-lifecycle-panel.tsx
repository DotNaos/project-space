import { Button } from "@heroui/react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
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

function nextAction(task: MockTask): { action: MockTaskAction; icon: typeof Sparkles; label: string } | null {
  if (!task.branch) return { action: { type: "create-branch" }, icon: GitBranch, label: "Create branch" };
  if (task.stage === "branch") return { action: { type: "start-development" }, icon: Bot, label: "Start development" };
  if (task.stage === "development") return { action: { type: "open-pull-request" }, icon: GitPullRequest, label: "Open pull request" };
  if (!task.pullRequest) return null;
  if (task.pullRequest.checks === "not-started") return { action: { type: "run-checks" }, icon: Play, label: "Run checks" };
  if (task.pullRequest.checks === "running") return { action: { type: "pass-checks" }, icon: Check, label: "Pass checks" };
  if (task.pullRequest.checks === "failed") return { action: { type: "run-checks" }, icon: RefreshCw, label: "Retry checks" };
  if (task.pullRequest.preview === "not-started") return { action: { type: "start-preview" }, icon: Rocket, label: "Start Preview" };
  if (task.pullRequest.preview === "unavailable") return { action: { type: "retry-preview" }, icon: RefreshCw, label: "Retry Preview" };
  if (task.pullRequest.review === "not-requested") return { action: { type: "request-review" }, icon: ShieldCheck, label: "Request review" };
  if (task.pullRequest.review === "pending") return { action: { type: "approve-revision" }, icon: Check, label: "Approve revision" };
  if (task.stage === "review") return { action: { type: "merge" }, icon: GitMerge, label: "Merge pull request" };
  if (task.stage === "merged") return { action: { type: "start-deployment" }, icon: Rocket, label: "Start deployment" };
  if (task.stage === "deploying") return { action: { type: "complete-deployment" }, icon: Check, label: "Verify deployment" };
  return null;
}

export function TaskLifecyclePanel({
  onAction,
  onOpenPreview,
  task,
}: {
  onAction(action: MockTaskAction): void;
  onOpenPreview(): void;
  task: MockTask;
}) {
  const primary = nextAction(task);
  const latestEvent = task.events[task.events.length - 1];
  return (
    <aside className="min-w-0">
      <div className="pb-5">
        {latestEvent ? <p className="max-w-xl text-sm leading-6 text-current/55">{latestEvent.detail}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {primary ? (
            <Button className="min-w-0 flex-1 @md:flex-none" size="sm" variant="primary" onPress={() => onAction(primary.action)}>
              <primary.icon className="size-4" /> {primary.label}
            </Button>
          ) : null}
          {task.pullRequest?.preview === "ready" ? (
            <Button className="min-w-0 flex-1 @md:flex-none" size="sm" style={{ color: "inherit" }} variant="secondary" onPress={onOpenPreview}>
              <MonitorPlay className="size-4" /> Open Preview
            </Button>
          ) : null}
          {task.deployment?.status === "deployed" ? (
            <a className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 text-xs font-medium text-emerald-300 transition-[filter,scale] hover:brightness-125 active:scale-[.96] @md:flex-none" href={task.deployment.url} rel="noreferrer" target="_blank">
              Open production <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
      </div>

      <details className="group border-t border-current/[.08] pt-1">
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
      </details>
    </aside>
  );
}
