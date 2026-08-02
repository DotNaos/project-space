import { useMemo, useState } from "react";
import { GitBranch, GitCommitHorizontal, Laptop, Plus, RotateCcw } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { BranchDetailView, type PrototypeBranch } from "./branch-detail";
import {
  PageFilter,
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
} from "./page-foundation";
import { WorkspaceDetailView, type PrototypeWorkspace } from "./workspace-detail";

type BranchHealth = "Behind" | "Current" | "Merged" | "Working";

const branches: PrototypeBranch[] = [
  { commit: "dc6bd8d", detail: "Default branch · protected", health: "Current", name: "main", relation: "baseline", updated: "4h" },
  { commit: "72c0f48", detail: "#437 · Frontend redesign", health: "Working", name: "issue-437-redesign-the-project-space-frontend", relation: "1 ahead", updated: "now" },
  { commit: "2550cd7", detail: "#426 · Preview hub", health: "Behind", name: "issue-426-fix-preview-asset-activation", relation: "3 behind · 4 ahead", updated: "2h" },
  { commit: "419a88b", detail: "#434 · PR reliability", health: "Merged", name: "issue-434-make-agent-authored-pr-revisions-green-on-first-push", relation: "merged", updated: "6h" },
  { commit: "a69a9f5", detail: "#419 · CI/CD reliability", health: "Merged", name: "issue-419-improve-ci-cd-reliability-and-speed", relation: "merged", updated: "yesterday" },
];

const branchTone: Record<BranchHealth, "danger" | "info" | "muted" | "success"> = {
  Behind: "danger",
  Current: "success",
  Merged: "muted",
  Working: "info",
};

export function ProjectBranchesPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const [filter, setFilter] = useState<"Active" | "All" | "Attention">("Active");
  const [query, setQuery] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<PrototypeBranch | null>(null);
  const visible = useMemo(() => branches.filter((branch) => {
    const matchesFilter = filter === "All"
      || (filter === "Attention" ? branch.health === "Behind" : branch.health !== "Merged");
    return matchesFilter && `${branch.name} ${branch.detail}`.toLowerCase().includes(query.toLowerCase());
  }), [filter, query]);
  const unavailable = scenario === "empty" || scenario === "offline";

  if (selectedBranch) return <BranchDetailView branch={selectedBranch} onBack={() => setSelectedBranch(null)} />;

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New branch</PagePrimaryAction>}
      description="See which lines of work are current, merged, or need to catch up."
      projectName={projectName}
      title="Branches"
    >
      <div className="flex flex-col gap-3 border-b border-current/[.08] py-4 @md:flex-row @md:items-center @md:justify-between">
        <PageSearch onChange={setQuery} placeholder="Search branches" value={query} />
        <div className="flex items-center gap-1">
          {(["Active", "Attention", "All"] as const).map((value) => (
            <PageFilter active={filter === value} key={value} onPress={() => setFilter(value)}>{value}</PageFilter>
          ))}
        </div>
      </div>
      {unavailable ? <PageState emptyCopy="Branches will appear when work begins." scenario={scenario} /> : (
        <div className="divide-y divide-current/[.07]">
          {visible.map((branch) => (
            <button
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4"
              key={branch.name}
              onClick={() => setSelectedBranch(branch)}
              type="button"
            >
              <span className="mt-0.5 grid size-8 place-items-center rounded-full bg-current/[.05] text-current/45">
                <GitBranch className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{branch.name}</span>
                <span className="mt-1 block truncate text-xs text-current/40">{branch.detail}</span>
                <span className="mt-2 flex items-center gap-2 text-[11px] text-current/30">
                  <GitCommitHorizontal className="size-3.5" /> {branch.commit} · {branch.relation} · {branch.updated}
                </span>
              </span>
              <PageStatus tone={branchTone[branch.health]}>{branch.health}</PageStatus>
            </button>
          ))}
        </div>
      )}
    </PageScaffold>
  );
}

type WorkspaceHealth = "Clean" | "Modified" | "Read only";

const workspaces: PrototypeWorkspace[] = [
  { branch: "issue-437-redesign-the-project-space-frontend", health: "Modified", machine: "Local", name: "#437 · Frontend redesign", updated: "now" },
  { branch: "main", health: "Read only", machine: "Local", name: "Project Space", updated: "4h" },
  { branch: "issue-426-fix-preview-asset-activation", health: "Clean", machine: "os-pc", name: "#426 · Preview hub", updated: "2h" },
  { branch: "issue-408-release-v0.4.45", health: "Clean", machine: "os-yoga-unix", name: "#408 · Branch head graph", updated: "yesterday" },
];

const workspaceTone: Record<WorkspaceHealth, "info" | "muted" | "success"> = {
  Clean: "success",
  Modified: "info",
  "Read only": "muted",
};

export function ProjectWorkspacesPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const [query, setQuery] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState<PrototypeWorkspace | null>(null);
  const visible = workspaces.filter((workspace) =>
    `${workspace.name} ${workspace.branch} ${workspace.machine}`.toLowerCase().includes(query.toLowerCase()),
  );
  const unavailable = scenario === "empty" || scenario === "offline";

  if (selectedWorkspace) return <WorkspaceDetailView onBack={() => setSelectedWorkspace(null)} workspace={selectedWorkspace} />;

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<RotateCcw className="size-4" />}>Refresh</PagePrimaryAction>}
      description="The working copies where issues become code, grouped by destination."
      projectName={projectName}
      title="Workspaces"
    >
      <div className="border-b border-current/[.08] py-4">
        <PageSearch onChange={setQuery} placeholder="Search workspaces" value={query} />
      </div>
      {unavailable ? <PageState emptyCopy="Create an issue worktree to begin working." scenario={scenario} /> : (
        <div className="divide-y divide-current/[.07]">
          {visible.map((workspace) => (
            <button
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4"
              key={workspace.branch}
              onClick={() => setSelectedWorkspace(workspace)}
              type="button"
            >
              <span className="mt-0.5 grid size-8 place-items-center rounded-full bg-current/[.05] text-current/45">
                <Laptop className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{workspace.name}</span>
                <span className="mt-1 block truncate text-xs text-current/40">{workspace.branch}</span>
                <span className="mt-2 block text-[11px] text-current/30">{workspace.machine} · updated {workspace.updated}</span>
              </span>
              <PageStatus tone={workspaceTone[workspace.health]}>{workspace.health}</PageStatus>
            </button>
          ))}
        </div>
      )}
    </PageScaffold>
  );
}
