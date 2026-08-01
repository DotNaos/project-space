export type PrototypeIssueState = "Blocked" | "Done" | "In progress" | "Open";
export type PrototypeIssueColumn = "Backlog" | "Blocked" | "Done" | "In progress" | "Ready";

export interface PrototypeIssue {
  author: string;
  body: string;
  branch?: string;
  codexTask?: string;
  column: PrototypeIssueColumn;
  labels: string[];
  number: number;
  preview?: string;
  pullRequest?: string;
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
    column: "In progress",
    labels: ["frontend", "design"],
    number: 437,
    preview: "Local prototype · Running",
    pullRequest: "Not opened yet",
    state: "In progress",
    title: "Redesign the Project Space frontend",
    updated: "now",
  },
  {
    author: "Oli",
    body: "Add one trusted place to start, inspect, replace, and stop pull-request Previews without exposing machine controls to PR code.",
    branch: "issue-426-fix-preview-asset-activation",
    codexTask: "#426 · Preview hub",
    column: "Ready",
    labels: ["preview", "infrastructure"],
    number: 426,
    preview: "Preview #426 · Offline",
    state: "Open",
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
    pullRequest: "#435 · Merged",
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
    pullRequest: "#425 · Merged",
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
    author: "Calypso",
    body: "Repair the Preview runner configuration so exact pull-request heads can be activated again.",
    branch: "issue-431-preview-runner-config",
    column: "Blocked",
    labels: ["preview", "blocked"],
    number: 431,
    preview: "Preview #431 · Failed",
    state: "Blocked",
    title: "Fix Preview runner configuration",
    updated: "Jul 31",
  },
  {
    author: "Oli",
    body: "Require verified, exact-identity live iteration for prototypes while preserving the trusted server boundary.",
    column: "Done",
    labels: ["prototype", "security"],
    number: 395,
    pullRequest: "#404 · Merged",
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
  { hint: "Not scheduled yet", id: "Backlog", tone: "bg-zinc-500" },
  { hint: "Cleared to pick up", id: "Ready", tone: "bg-emerald-400" },
  { hint: "Being worked on", id: "In progress", tone: "bg-blue-400" },
  { hint: "Waiting on something", id: "Blocked", tone: "bg-red-400" },
  { hint: "Completed work", id: "Done", tone: "bg-violet-400" },
];

export function prototypeIssueByNumber(number: number) {
  return prototypeIssues.find((issue) => issue.number === number);
}
