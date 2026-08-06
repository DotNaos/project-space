export type BranchHealth = "Behind" | "Current" | "Working";
export type PullRequestState = "Draft" | "Merged" | "Open";
export type WorkspaceHealth = "Clean" | "Modified" | "Read only";

export interface PrototypePullRequest {
  number: number;
  state: PullRequestState;
}

export interface PrototypeWorkspace {
  branch: string;
  health: WorkspaceHealth;
  machine: string;
  name: string;
  updated: string;
}

export interface PrototypeBranch {
  commit: string;
  detail: string;
  health: BranchHealth;
  name: string;
  pullRequest?: PrototypePullRequest;
  relation: string;
  updated: string;
  workspaces: PrototypeWorkspace[];
}

interface BranchSeed {
  commit: string;
  name: string;
  pullRequest?: PrototypePullRequest;
  workspaces?: Omit<PrototypeWorkspace, "branch">[];
}

const branchSeeds: BranchSeed[] = [
  {
    commit: "dc6bd8d0",
    name: "main",
    workspaces: [{ health: "Read only", machine: "Local", name: "Project Space", updated: "4h" }],
  },
  {
    commit: "ff4598c6",
    name: "issue-437-redesign-the-project-space-frontend",
    workspaces: [
      { health: "Modified", machine: "Local", name: "#437 · Frontend redesign", updated: "now" },
      { health: "Clean", machine: "os-pc", name: "#437 · Frontend redesign", updated: "12m" },
    ],
  },
  { commit: "49607e45", name: "agent/fix-preview-config-bootstrap", pullRequest: { number: 433, state: "Merged" } },
  { commit: "ffc3ad7e", name: "feat/project-chat-live-names", pullRequest: { number: 153, state: "Merged" } },
  { commit: "0f313205", name: "fix/explorer-breadcrumb-hit-area", pullRequest: { number: 115, state: "Merged" } },
  { commit: "2865bb4b", name: "fix/explorer-hidden-path-search" },
  { commit: "f5f317e9", name: "fix/preview-isolate-ui-tests", pullRequest: { number: 294, state: "Merged" } },
  { commit: "cedf6ca7", name: "fix/preview-proxy-compression" },
  { commit: "a3d69ac9", name: "fix/preview-validation-module-mocks" },
  { commit: "e32b53c3", name: "issue-73-issue-creation-more-options" },
  { commit: "b7d92b5d", name: "issue-74-show-branches-on-issues" },
  { commit: "56f8a60d", name: "issue-84-template-adherence-visualisation" },
  { commit: "e32b53c3", name: "issue-97-image-support-for-issues" },
  { commit: "4a52512e", name: "issue-105-add-a-read-only-explorer-tab-to-machine-pages" },
  { commit: "448fb971", name: "issue-105-explorer-navigation" },
  { commit: "74a05d55", name: "issue-105-git-project-breadcrumbs" },
  {
    commit: "11fc9f52",
    name: "issue-111-worktree-dev-servers",
    workspaces: [{ health: "Clean", machine: "os-yoga-unix", name: "#111 · Worktree servers", updated: "2d" }],
  },
  { commit: "7784657f", name: "issue-121-isolate-codex-worktrees" },
  { commit: "e80d4f7d", name: "issue-123-codex-owned-worktrees" },
  { commit: "925cae9f", name: "issue-125-integrate-kvm-over-ip-devices-into-machine-pages" },
  { commit: "e56ccbc7", name: "issue-126-add-authenticated-project-connect-and-cross-platform-mac" },
  { commit: "9720fd34", name: "issue-126-wsl-service-persistence" },
  { commit: "a190360d", name: "issue-128-add-project-chat-for-human-and-agent-coordination" },
  { commit: "5141e059", name: "issue-135-add-native-windows-winget" },
  { commit: "0743f70e", name: "issue-135-winget-schema-1.12" },
  {
    commit: "352deb76",
    name: "issue-149-integrate-local-codex-app-server-threads-into-project-sp",
    workspaces: [{ health: "Modified", machine: "os-pc", name: "#149 · Codex threads", updated: "3d" }],
  },
  { commit: "67bd5e04", name: "issue-155-add-cryptographic-human-approvals-to-the-project-cli" },
  { commit: "f3b56c78", name: "issue-167-fix-machine-checkout-identity" },
  { commit: "433c050f", name: "issue-169-show-deployment-urls-and-recent-deployment-status-across" },
  { commit: "ebbb55aa", name: "issue-174-proof-one" },
];

function issueDetail(name: string) {
  if (name === "main") return "Default branch · protected";
  const issue = name.match(/^issue-(\d+)-/u)?.[1];
  if (!issue) return "Repository branch";
  return `Issue #${issue}`;
}

export const prototypeBranches: PrototypeBranch[] = branchSeeds.map((seed, index) => ({
  commit: seed.commit,
  detail: issueDetail(seed.name),
  health: seed.name === "main" ? "Current" : index % 7 === 0 ? "Behind" : "Working",
  name: seed.name,
  pullRequest: seed.pullRequest,
  relation: seed.name === "main" ? "baseline" : index % 7 === 0 ? "3 behind · 2 ahead" : `${(index % 9) + 1} ahead`,
  updated: index < 2 ? (index === 0 ? "4h" : "now") : index < 8 ? `${index + 1}h` : `${Math.ceil(index / 4)}d`,
  workspaces: (seed.workspaces ?? []).map((workspace) => ({ ...workspace, branch: seed.name })),
}));
