import { Button } from "@heroui/react";
import {
  AlertTriangle,
  Bot,
  Check,
  CircleDot,
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
  mockTaskStageLabel,
  type MockTask,
  type MockTaskAction,
  type MockTaskStage,
} from "./task-model";

const stages: Array<{ id: MockTaskStage; label: string }> = [
  { id: "issue", label: "Task" },
  { id: "branch", label: "Branch" },
  { id: "development", label: "Build" },
  { id: "pull-request", label: "Pull request" },
  { id: "checks", label: "Checks" },
  { id: "preview", label: "Preview" },
  { id: "review", label: "Review" },
  { id: "merged", label: "Merge" },
  { id: "deploying", label: "Deploy" },
  { id: "deployed", label: "Live" },
];

function TaskStageRail({ task }: { task: MockTask }) {
  const current = stages.findIndex((stage) => stage.id === task.stage);
  return (
    <ol aria-label="Task lifecycle" className="grid grid-cols-5 gap-x-1 gap-y-3">
      {stages.map((stage, index) => {
        const complete = index < current || task.stage === "deployed";
        const active = index === current && task.stage !== "deployed";
        return (
          <li className="min-w-0" key={stage.id}>
            <span className={`block h-1 rounded-full ${complete ? "bg-emerald-400/70" : active ? "bg-blue-400" : "bg-current/[.08]"}`} />
            <span className={`mt-1.5 block truncate text-[9px] ${active ? "text-current/65" : "text-current/25"}`}>{stage.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

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
  const attention = task.pullRequest?.checks === "failed" || task.pullRequest?.preview === "unavailable";
  return (
    <aside className="min-w-0">
      <div className="border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-current/75">Lifecycle</h2>
          <span className={`flex items-center gap-1.5 text-xs font-medium ${attention ? "text-red-300" : task.stage === "deployed" ? "text-emerald-300" : "text-current/50"}`}>
            {attention ? <AlertTriangle className="size-3.5" /> : task.stage === "deployed" ? <Check className="size-3.5" /> : <CircleDot className="size-3.5" />}
            {mockTaskStageLabel(task)}
          </span>
        </div>
        <div className="mt-4"><TaskStageRail task={task} /></div>
      </div>

      <div className="border-b border-current/[.08] py-4">
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

      {task.pullRequest?.preview === "ready" ? (
        <Button className="mt-4 w-full" size="sm" style={{ color: "inherit" }} variant="secondary" onPress={onOpenPreview}>
          <MonitorPlay className="size-4" /> Open Preview
        </Button>
      ) : null}

      {primary ? (
        <Button className="mt-3 w-full" size="sm" variant="primary" onPress={() => onAction(primary.action)}>
          <primary.icon className="size-4" /> {primary.label}
        </Button>
      ) : null}

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

      {task.deployment?.status === "deployed" ? (
        <a className="mt-4 flex h-9 items-center justify-center gap-1.5 rounded-xl bg-emerald-500/10 text-xs font-medium text-emerald-300 transition-[filter,scale] hover:brightness-125 active:scale-[.96]" href={task.deployment.url} rel="noreferrer" target="_blank">
          Open production <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </aside>
  );
}
