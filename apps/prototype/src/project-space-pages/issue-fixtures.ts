export type PrototypeIssueState = "Done" | "In progress" | "Open";
export type PrototypeIssueColumn = "Backlog" | "Done" | "In progress";

export interface PrototypePullRequest {
  number: number;
  state: "Merged" | "Open";
  url: string;
}

export interface PrototypeIssue {
  author: string;
  body: string;
  branch?: string;
  codexTask?: string;
  column: PrototypeIssueColumn;
  labels: string[];
  number: number;
  preview?: string;
  pullRequest?: PrototypePullRequest;
  state: PrototypeIssueState;
  title: string;
  updated: string;
}

export const prototypeIssues: PrototypeIssue[] = [
  {
    author: "Oli",
    body: "Rebuild Project Space around one guided workflow: choose the project, start from an issue, and keep branches, Codex tasks, Previews, and delivery evidence connected to that work.",
    branch: "issue-437-redesign-the-project-space-frontend",
    codexTask: "#437 · Frontend redesign",
    column: "Backlog",
    labels: ["frontend", "design"],
    number: 437,
    preview: "Local prototype · Running",
    state: "Open",
    title: "Redesign the Project Space frontend",
    updated: "now",
  },
  {
    author: "Oli",
    body: "Add one trusted place to start, inspect, replace, and stop pull-request Previews without exposing machine controls to PR code.",
    branch: "issue-426-add-an-on-demand-pr-preview-hub-and-storage-backed-offli",
    codexTask: "#426 · Preview hub",
    column: "Done",
    labels: ["preview", "infrastructure"],
    number: 426,
    preview: "Preview #426 · Offline",
    pullRequest: {
      number: 427,
      state: "Merged",
      url: "https://github.com/DotNaos/project-space/pull/427",
    },
    state: "Done",
    title: "Add an on-demand PR Preview hub",
    updated: "2h",
  },
  {
    author: "Aurora",
    body: "Make each agent-authored pull request arrive as one coherent revision with deterministic checks already completed locally.",
    branch: "issue-434-make-agent-authored-pr-revisions-green-on-first-push",
    column: "Done",
    labels: ["ci", "reliability"],
    number: 434,
    pullRequest: {
      number: 435,
      state: "Merged",
      url: "https://github.com/DotNaos/project-space/pull/435",
    },
    state: "Done",
    title: "Make agent-authored PR revisions green",
    updated: "4h",
  },
  {
    author: "Juno",
    body: "Reduce CI noise and keep protected release, signing, rollback, and health gates fail-closed.",
    branch: "issue-419-improve-ci-cd-reliability-and-speed",
    column: "Done",
    labels: ["ci", "performance"],
    number: 419,
    pullRequest: {
      number: 425,
      state: "Merged",
      url: "https://github.com/DotNaos/project-space/pull/425",
    },
    state: "Done",
    title: "Improve CI/CD reliability and speed",
    updated: "yesterday",
  },
  {
    author: "Oli",
    body: "Show a focused Git graph around a branch head so behind and diverged work immediately reads as action required.",
    branch: "issue-408-release-v0.4.45",
    column: "Backlog",
    labels: ["git", "history"],
    number: 408,
    state: "Open",
    title: "Show a focused Git graph around the branch head",
    updated: "yesterday",
  },
  {
    author: "Oli",
    body: "Keep the issue board truthful by deriving active work from open pull requests and completed work from merged pull requests.",
    branch: "issue-398-require-agents-to-keep-issue-board-status-current",
    column: "In progress",
    labels: ["enhancement", "workflow"],
    number: 398,
    pullRequest: {
      number: 420,
      state: "Open",
      url: "https://github.com/DotNaos/project-space/pull/420",
    },
    state: "In progress",
    title: "Require agents to keep issue board status current",
    updated: "Jul 31",
  },
  {
    author: "Oli",
    body: "Require verified, exact-identity live iteration for prototypes while preserving the trusted server boundary.",
    column: "Done",
    labels: ["prototype", "security"],
    number: 395,
    pullRequest: {
      number: 404,
      state: "Merged",
      url: "https://github.com/DotNaos/project-space/pull/404",
    },
    state: "Done",
    title: "Require verified live iteration for prototypes",
    updated: "Jul 30",
  },
];

export const prototypeIssueColumns: Array<{
  hint: string;
  id: PrototypeIssueColumn;
  tone: string;
}> = [
  { hint: "No pull request yet", id: "Backlog", tone: "bg-zinc-500" },
  { hint: "Open pull requests", id: "In progress", tone: "bg-blue-400" },
  { hint: "Merged pull requests", id: "Done", tone: "bg-violet-400" },
];

export function prototypePullRequestLabel(pullRequest: PrototypePullRequest) {
  return `#${pullRequest.number}`;
}

export function prototypeIssueByNumber(number: number) {
  return prototypeIssues.find((issue) => issue.number === number);
}
