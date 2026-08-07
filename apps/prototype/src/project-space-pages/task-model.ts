export type MockTaskType = "Bug" | "Feature" | "Idea";
export type MockTaskStage =
  | "issue"
  | "branch"
  | "development"
  | "pull-request"
  | "checks"
  | "preview"
  | "review"
  | "merged"
  | "deploying"
  | "deployed";

export type MockCheckState = "failed" | "not-started" | "passed" | "running";
export type MockPreviewState = "not-started" | "ready" | "unavailable";
export type MockReviewState = "approved" | "not-requested" | "pending";
export type MockTaskWorkflowState = "Active" | "Backlog" | "Completed" | "Review";

export interface MockTaskComment {
  author: string;
  body: string;
  id: string;
  time: string;
}

export interface MockTaskEvent {
  detail: string;
  id: string;
  time: string;
  title: string;
}

export interface MockTaskAgentThread {
  id: string;
  machine?: string;
  name: string;
  status: "idle" | "running";
}

export interface MockTaskPullRequest {
  checks: MockCheckState;
  number: number;
  phase?: "draft" | "ready";
  preview: MockPreviewState;
  review: MockReviewState;
  revision: string;
}

export interface MockTaskCleanup {
  remoteBranch: "deleted" | "exists";
  worktrees: Array<{
    machine: string;
    safeToDelete: boolean;
    status: "clean" | "modified";
    uncommittedChanges: number;
    unstagedChanges: number;
  }>;
}

export interface MockTask {
  agentRun?: {
    machine: string;
    name: string;
    status: "complete" | "idle" | "running";
  };
  agentThreads?: MockTaskAgentThread[];
  author: string;
  body: string;
  branch?: string;
  branchRelation?: string;
  comments: MockTaskComment[];
  cleanup?: MockTaskCleanup;
  deployment?: {
    commit: string;
    status: "deployed" | "deploying";
    url: string;
  };
  events: MockTaskEvent[];
  isMockOnly?: boolean;
  labels: string[];
  number: number;
  pullRequest?: MockTaskPullRequest;
  stage: MockTaskStage;
  title: string;
  type: MockTaskType;
  updated: string;
  workspace?: {
    changedFiles: number;
    devServer?: {
      status: "running" | "stopped";
      transport: "Tailscale";
    };
    machine: string;
    status: "clean" | "modified";
  };
}

export type MockTaskAction =
  | { type: "add-comment"; body: string }
  | { type: "approve-and-merge" }
  | { type: "approve-revision" }
  | { type: "change-revision" }
  | { type: "complete-deployment" }
  | { type: "create-branch" }
  | { type: "delete-branch" }
  | { type: "delete-remote-branch" }
  | { type: "fail-checks" }
  | { type: "merge" }
  | { type: "mark-pull-request-ready" }
  | { type: "remove-worktree"; machine: string }
  | { type: "open-pull-request" }
  | { type: "pass-checks" }
  | { type: "request-review" }
  | { type: "retry-preview" }
  | { type: "run-checks" }
  | { type: "start-development" }
  | { type: "start-deployment" }
  | { type: "start-preview" };

const stageLabels: Record<MockTaskStage, string> = {
  branch: "Branch ready",
  checks: "Checks running",
  deployed: "Deployed",
  deploying: "Deploying",
  development: "In development",
  issue: "Task created",
  merged: "Merged",
  preview: "Preview ready",
  "pull-request": "Pull request open",
  review: "In review",
};

export function mockTaskStageLabel(task: MockTask) {
  if (!task.pullRequest) return "Planning";
  if (task.pullRequest.phase === "draft") return "Started";
  if (task.pullRequest?.checks === "failed") return "Checks failed";
  if (task.pullRequest?.preview === "unavailable") return "Preview unavailable";
  if (task.pullRequest?.review === "pending") return "Needs review";
  if (task.pullRequest.phase === "ready" && task.pullRequest.checks === "not-started") return "In progress";
  return stageLabels[task.stage];
}

export function mockTaskWorkflowState(task: MockTask): MockTaskWorkflowState {
  if (["merged", "deploying", "deployed"].includes(task.stage)) return "Completed";
  if (!task.pullRequest) return "Backlog";
  if (task.pullRequest.phase === "draft") return "Active";
  return "Review";
}

export function mockTaskNeedsAttention(task: MockTask) {
  return task.pullRequest?.checks === "failed"
    || task.pullRequest?.preview === "unavailable";
}

export function mockTaskGroup(task: MockTask): "Active" | "Done" | "Needs you" {
  if (mockTaskWorkflowState(task) === "Completed") return "Done";
  if (mockTaskNeedsAttention(task)) return "Needs you";
  return "Active";
}

function nextRevision(revision: string) {
  const current = Number.parseInt(revision.slice(-2), 16);
  return `dc6bd${((Number.isNaN(current) ? 0x80 : current) + 1).toString(16).slice(-2)}`;
}

function event(task: MockTask, title: string, detail: string): MockTaskEvent {
  return {
    detail,
    id: `${task.number}-${task.events.length + 1}`,
    time: "now",
    title,
  };
}

function withEvent(task: MockTask, next: Partial<MockTask>, title: string, detail: string): MockTask {
  return {
    ...task,
    ...next,
    events: [...task.events, event(task, title, detail)],
    updated: "now",
  };
}

export function updateMockTask(task: MockTask, action: MockTaskAction): MockTask {
  switch (action.type) {
    case "add-comment": {
      const body = action.body.trim();
      if (!body) return task;
      return withEvent({
        ...task,
        comments: [...task.comments, {
          author: "Oli",
          body,
          id: `${task.number}-comment-${task.comments.length + 1}`,
          time: "now",
        }],
      }, {}, "Comment added", "The discussion was updated.");
    }
    case "create-branch": {
      const branch = `task-${task.number}-${task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 42)}`;
      return withEvent(task, {
        branch,
        branchRelation: "1 ahead · 0 behind main",
        pullRequest: {
          checks: "not-started",
          number: task.number + 1,
          phase: "draft",
          preview: "not-started",
          review: "not-requested",
          revision: "dc6bd80",
        },
        stage: "branch",
      }, "Development setup ready", `${branch} and draft pull request #${task.number + 1} were prepared from main.`);
    }
    case "start-development":
      return withEvent(task, {
        agentRun: { machine: "Local", name: `#${task.number} · Build task`, status: "running" },
        agentThreads: [{ id: `${task.number}-build`, name: `#${task.number} · Build task`, status: "running" }],
        stage: "development",
        workspace: {
          changedFiles: 0,
          devServer: { status: "running", transport: "Tailscale" },
          machine: "Local",
          status: "clean",
        },
      }, "Development started", "Codex is working in the task branch on Local.");
    case "open-pull-request":
      return withEvent(task, {
        pullRequest: {
          checks: "not-started",
          number: task.number + 1,
          phase: "draft",
          preview: "not-started",
          review: "not-requested",
          revision: "dc6bd80",
        },
        stage: task.agentRun ? "development" : "branch",
      }, "Draft pull request opened", `Draft pull request #${task.number + 1} keeps the implementation connected while work continues.`);
    case "mark-pull-request-ready":
      if (!task.pullRequest || task.pullRequest.phase !== "draft") return task;
      return withEvent(task, {
        agentRun: task.agentRun ? { ...task.agentRun, status: "idle" } : undefined,
        agentThreads: task.agentThreads?.map((thread) => ({ ...thread, status: "idle" })),
        pullRequest: { ...task.pullRequest, checks: "running", phase: "ready" },
        stage: "checks",
      }, "First version ready", `Codex finished the first version of pull request #${task.pullRequest.number}; its delivery pipeline started.`);
    case "run-checks":
      if (!task.pullRequest || task.pullRequest.phase !== "ready") return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, checks: "running" },
        stage: "checks",
      }, "Checks running", `Required checks started for ${task.pullRequest.revision}.`);
    case "fail-checks":
      if (!task.pullRequest || task.pullRequest.phase !== "ready" || task.pullRequest.checks !== "running") return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, checks: "failed" },
        stage: "checks",
      }, "Checks failed", "The frontend verification needs attention before review.");
    case "pass-checks":
      if (!task.pullRequest || task.pullRequest.phase !== "ready" || task.pullRequest.checks !== "running") return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, checks: "passed", preview: "ready" },
        stage: "preview",
      }, "Pipeline passed", `All required checks passed for ${task.pullRequest.revision}; Preview and Prototype are ready.`);
    case "start-preview":
    case "retry-preview":
      if (!task.pullRequest || task.pullRequest.phase !== "ready" || task.pullRequest.checks !== "passed") return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, preview: "ready" },
        stage: "preview",
      }, "Preview ready", `Revision ${task.pullRequest.revision} is ready for visual review.`);
    case "request-review":
      if (!task.pullRequest) return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, review: "pending" },
        stage: "review",
      }, "Review requested", `Revision ${task.pullRequest.revision} needs your approval.`);
    case "approve-revision":
      if (!task.pullRequest) return task;
      return withEvent(task, {
        pullRequest: { ...task.pullRequest, review: "approved" },
        stage: "review",
      }, "Revision approved", `${task.pullRequest.revision} was approved for merge.`);
    case "approve-and-merge":
      if (!task.pullRequest || task.pullRequest.checks !== "passed") return task;
      return withEvent(task, {
        cleanup: {
          remoteBranch: "exists",
          worktrees: task.workspace ? [{
            machine: task.workspace.machine,
            safeToDelete: task.workspace.status === "clean",
            status: task.workspace.status,
            uncommittedChanges: task.workspace.changedFiles,
            unstagedChanges: task.workspace.changedFiles,
          }] : [],
        },
        pullRequest: { ...task.pullRequest, review: "approved" },
        stage: "merged",
      }, "Pull request approved and merged", `#${task.pullRequest.number} was approved and merged into main.`);
    case "change-revision":
      if (!task.pullRequest) return task;
      return withEvent(task, {
        pullRequest: {
          ...task.pullRequest,
          checks: "not-started",
          preview: "not-started",
          review: "not-requested",
          revision: nextRevision(task.pullRequest.revision),
        },
        stage: "pull-request",
      }, "Revision changed", "Previous approval was cleared because the pull request changed.");
    case "merge":
      if (!task.pullRequest || task.pullRequest.checks !== "passed" || task.pullRequest.review !== "approved") return task;
      return withEvent(task, {
        cleanup: {
          remoteBranch: "exists",
          worktrees: task.workspace ? [{
            machine: task.workspace.machine,
            safeToDelete: task.workspace.status === "clean",
            status: task.workspace.status,
            uncommittedChanges: task.workspace.changedFiles,
            unstagedChanges: task.workspace.changedFiles,
          }] : [],
        },
        stage: "merged",
      }, "Pull request merged", `#${task.pullRequest.number} was merged into main.`);
    case "start-deployment":
      if (task.stage !== "merged" || !task.pullRequest) return task;
      return withEvent(task, {
        deployment: {
          commit: task.pullRequest.revision,
          status: "deploying",
          url: "https://projects.os-home.net",
        },
        stage: "deploying",
      }, "Deployment started", `${task.pullRequest.revision} is deploying to production.`);
    case "complete-deployment":
      if (!task.deployment) return task;
      return withEvent(task, {
        deployment: { ...task.deployment, status: "deployed" },
        stage: "deployed",
      }, "Deployment verified", `${task.deployment.commit} is live and healthy in production.`);
    case "delete-remote-branch":
      if (!task.cleanup || task.cleanup.remoteBranch === "deleted") return task;
      return withEvent(task, {
        cleanup: { ...task.cleanup, remoteBranch: "deleted" },
      }, "Remote branch deleted", `${task.branch ?? "The merged branch"} was removed from GitHub.`);
    case "delete-branch": {
      if (!task.cleanup || task.cleanup.remoteBranch === "deleted") return task;
      const preservedWorktrees = task.cleanup.worktrees.filter((worktree) => !worktree.safeToDelete);
      const removedWorktreeCount = task.cleanup.worktrees.length - preservedWorktrees.length;
      return withEvent(task, {
        cleanup: {
          remoteBranch: "deleted",
          worktrees: preservedWorktrees,
        },
      }, "Branch deleted", `${task.branch ?? "The merged branch"} was removed from GitHub${removedWorktreeCount ? ` and ${removedWorktreeCount} clean local checkout${removedWorktreeCount === 1 ? "" : "s"} were removed` : ""}. Checkouts with local changes were preserved.`);
    }
    case "remove-worktree": {
      if (!task.cleanup) return task;
      const worktree = task.cleanup.worktrees.find((candidate) => candidate.machine === action.machine);
      if (!worktree?.safeToDelete) return task;
      return withEvent(task, {
        cleanup: {
          ...task.cleanup,
          worktrees: task.cleanup.worktrees.filter((candidate) => candidate.machine !== action.machine),
        },
      }, "Local worktree removed", `The clean worktree on ${action.machine} was removed.`);
    }
  }
}

export function createMockTask({
  body,
  labels,
  number,
  title,
  type,
}: {
  body: string;
  labels: string[];
  number: number;
  title: string;
  type: MockTaskType;
}): MockTask {
  return {
    author: "Oli",
    body,
    comments: [],
    events: [{
      detail: "The task is ready for a branch and development plan.",
      id: `${number}-1`,
      time: "now",
      title: "Task created",
    }],
    isMockOnly: true,
    labels,
    number,
    stage: "issue",
    title,
    type,
    updated: "now",
  };
}

export const initialMockTasks: MockTask[] = [
  {
    agentRun: { machine: "Local", name: "#437 · Frontend redesign", status: "running" },
    author: "Oli",
    body: "Rebuild Project Space around one guided workflow where a Task keeps intent, development, review, Preview, and delivery evidence together.",
    branch: "issue-437-redesign-the-project-space-frontend",
    branchRelation: "7 ahead · 0 behind main",
    comments: [
      { author: "Oli", body: "Keep the project calm and make the complete workflow usable before connecting real infrastructure.", id: "437-comment-1", time: "yesterday" },
      { author: "Codex", body: "The sidebar is complete. The mocked Task lifecycle is the current milestone.", id: "437-comment-2", time: "now" },
    ],
    events: [
      { detail: "The product workflow was captured in the roadmap.", id: "437-1", time: "yesterday", title: "Task created" },
      { detail: "issue-437-redesign-the-project-space-frontend was prepared on Local.", id: "437-2", time: "today", title: "Branch ready" },
      { detail: "Codex is implementing the selected prototype direction.", id: "437-3", time: "now", title: "Development running" },
    ],
    labels: ["frontend", "design"],
    number: 437,
    stage: "development",
    title: "Redesign the Project Space frontend",
    type: "Feature",
    updated: "now",
    workspace: { changedFiles: 12, machine: "Local", status: "modified" },
  },
  {
    agentRun: { machine: "os-pc", name: "#398 · Verify delivery evidence", status: "running" },
    author: "Oli",
    body: "Require the issue board to derive state from pull-request evidence and recover clearly when a required check fails.",
    branch: "issue-398-require-agents-to-keep-issue-board-status-current",
    branchRelation: "3 ahead · 0 behind main",
    comments: [],
    events: [
      { detail: "The task is connected to pull request #420.", id: "398-1", time: "Jul 31", title: "Pull request opened" },
      { detail: "Frontend verification needs attention.", id: "398-2", time: "now", title: "Checks failed" },
    ],
    labels: ["workflow", "reliability"],
    number: 398,
    pullRequest: { checks: "failed", number: 420, phase: "ready", preview: "not-started", review: "not-requested", revision: "e29c7a1" },
    stage: "checks",
    title: "Keep Task status aligned with delivery evidence",
    type: "Bug",
    updated: "now",
    workspace: { changedFiles: 3, machine: "os-pc", status: "modified" },
  },
  {
    author: "Mira",
    body: "Add an on-demand pull request Preview hub while keeping capacity and replacement choices explicit.",
    branch: "issue-426-fix-preview-asset-activation",
    branchRelation: "2 ahead · 0 behind main",
    comments: [],
    events: [
      { detail: "Draft pull request #427 keeps the implementation connected while work continues.", id: "426-1", time: "2h", title: "Draft pull request opened" },
    ],
    labels: ["preview", "infrastructure"],
    number: 426,
    pullRequest: { checks: "not-started", number: 427, phase: "draft", preview: "not-started", review: "not-requested", revision: "8f2d4a1" },
    stage: "pull-request",
    title: "Add an on-demand PR Preview hub",
    type: "Feature",
    updated: "2h",
    workspace: { changedFiles: 0, machine: "Local", status: "clean" },
  },
  {
    agentThreads: [
      { id: "395-build", machine: "os-pc", name: "#395 · Secure prototype", status: "running" },
      { id: "395-verify", machine: "os-pc", name: "Verify authenticated review", status: "idle" },
      { id: "395-mobile", machine: "os-macbook", name: "Verify mobile Preview", status: "idle" },
    ],
    author: "Oli",
    body: "Require verified live iteration for prototypes while preserving a trusted, exact-revision review boundary.",
    branch: "issue-395-secure-authenticated-prototype-iteration",
    branchRelation: "1 ahead · 0 behind main",
    comments: [],
    events: [
      { detail: "Pull request #404 passed its required checks.", id: "395-1", time: "Jul 30", title: "Checks passed" },
      { detail: "The exact pull request revision is ready to inspect.", id: "395-2", time: "now", title: "Preview ready" },
    ],
    labels: ["prototype", "security"],
    number: 395,
    pullRequest: { checks: "passed", number: 404, phase: "ready", preview: "ready", review: "not-requested", revision: "31f5a90" },
    stage: "preview",
    title: "Secure authenticated prototype iteration",
    type: "Feature",
    updated: "Jul 30",
    workspace: {
      changedFiles: 0,
      devServer: { status: "running", transport: "Tailscale" },
      machine: "os-pc",
      status: "clean",
    },
  },
  {
    author: "Aurora",
    body: "Make every agent-authored pull request arrive as one coherent revision with local checks already completed.",
    branch: "issue-434-make-agent-authored-pr-revisions-green-on-first-push",
    branchRelation: "merged into main",
    comments: [],
    cleanup: {
      remoteBranch: "exists",
      worktrees: [
        { machine: "os-pc", safeToDelete: true, status: "clean", uncommittedChanges: 0, unstagedChanges: 0 },
        { machine: "os-macbook", safeToDelete: false, status: "modified", uncommittedChanges: 3, unstagedChanges: 2 },
        { machine: "os-yoga-unix", safeToDelete: false, status: "modified", uncommittedChanges: 1, unstagedChanges: 0 },
      ],
    },
    deployment: { commit: "7317597", status: "deployed", url: "https://projects.os-home.net" },
    events: [
      { detail: "Pull request #435 was approved and merged.", id: "434-1", time: "4h", title: "Pull request merged" },
      { detail: "7317597 is live and healthy in production.", id: "434-2", time: "4h", title: "Deployment verified" },
    ],
    labels: ["ci", "reliability"],
    number: 434,
    pullRequest: { checks: "passed", number: 435, phase: "ready", preview: "ready", review: "approved", revision: "7317597" },
    stage: "deployed",
    title: "Make agent-authored revisions green",
    type: "Feature",
    updated: "4h",
  },
];
