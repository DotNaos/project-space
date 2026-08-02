import { useMemo, useState } from "react";
import {
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Laptop,
  Plus,
} from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { BranchDetailView } from "./branch-detail";
import {
  prototypeBranches,
  type PrototypeBranch,
} from "./branch-fixtures";
import {
  PageFilter,
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
} from "./page-foundation";

export type BranchFilter = "All" | "Checked out" | "Needs attention" | "Pull request";

export function filterPrototypeBranches({
  branches,
  filter,
  query,
}: {
  branches: PrototypeBranch[];
  filter: BranchFilter;
  query: string;
}) {
  const normalizedQuery = query.trim().toLowerCase();
  return branches.filter((branch) => {
    const matchesFilter = filter === "All"
      || (filter === "Checked out" && branch.workspaces.length > 0)
      || (filter === "Pull request" && Boolean(branch.pullRequest))
      || (filter === "Needs attention" && (branch.health === "Behind" || branch.pullRequest?.state === "Draft"));
    const searchable = [
      branch.name,
      branch.detail,
      branch.pullRequest ? `#${branch.pullRequest.number} ${branch.pullRequest.state}` : "no pull request",
      ...branch.workspaces.map((workspace) => workspace.machine),
    ].join(" ").toLowerCase();
    return matchesFilter && searchable.includes(normalizedQuery);
  });
}

function PullRequestStatus({ branch }: { branch: PrototypeBranch }) {
  if (!branch.pullRequest) return <span className="text-[11px] text-current/25">No PR</span>;
  const tone = branch.pullRequest.state === "Open"
    ? "success"
    : branch.pullRequest.state === "Draft"
      ? "warning"
      : "info";
  return (
    <PageStatus tone={tone}>
      <GitPullRequest className="size-3" /> #{branch.pullRequest.number} · {branch.pullRequest.state}
    </PageStatus>
  );
}

function CheckoutStatus({ branch }: { branch: PrototypeBranch }) {
  if (branch.workspaces.length === 0) return <span className="text-[11px] text-current/25">Not checked out</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {branch.workspaces.map((workspace) => (
        <span className="inline-flex h-6 min-w-0 items-center gap-1 rounded-full bg-current/[.055] px-2 text-[11px] text-current/55" key={workspace.machine}>
          <Laptop className="size-3 shrink-0" />
          <span className="truncate">{workspace.machine}</span>
        </span>
      ))}
    </span>
  );
}

export function ProjectBranchesPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const [filter, setFilter] = useState<BranchFilter>("All");
  const [query, setQuery] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<PrototypeBranch | null>(null);
  const visible = useMemo(() => filterPrototypeBranches({
    branches: prototypeBranches,
    filter,
    query,
  }), [filter, query]);
  const unavailable = scenario === "empty" || scenario === "offline";

  if (selectedBranch) {
    return <BranchDetailView branch={selectedBranch} onBack={() => setSelectedBranch(null)} />;
  }

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New branch</PagePrimaryAction>}
      contentClassName="flex flex-col overflow-hidden"
      description="Browse repository work and continue into its history and machine checkouts."
      projectName={projectName}
      title="Branches"
    >
      <div className="flex shrink-0 flex-col gap-3 border-b border-current/[.08] py-4 @3xl:flex-row @3xl:items-center @3xl:justify-between">
        <PageSearch onChange={setQuery} placeholder="Search branches, PRs, or machines" value={query} />
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {(["All", "Pull request", "Checked out", "Needs attention"] as const).map((value) => (
            <PageFilter active={filter === value} key={value} onPress={() => setFilter(value)}>{value}</PageFilter>
          ))}
        </div>
      </div>

      {unavailable ? <PageState emptyCopy="Branches will appear when work begins." scenario={scenario} /> : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="hidden h-9 shrink-0 grid-cols-[minmax(0,1.5fr)_11rem_13rem_5rem] items-center gap-4 border-b border-current/[.06] px-2 text-[11px] text-current/30 @3xl:grid">
            <span>Branch</span><span>Pull request</span><span>Checked out</span><span>Updated</span>
          </div>
          <div className="min-h-0 flex-1 divide-y divide-current/[.065] overflow-y-auto overscroll-y-contain [scrollbar-color:color-mix(in_srgb,currentColor_16%,transparent)_transparent] [scrollbar-width:thin]" data-scroll-region="branch-list">
            {visible.map((branch) => (
              <button
                aria-label={`Open branch ${branch.name}`}
                className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-2 py-3 text-left transition-[background-color,scale] duration-150 hover:bg-current/[.025] active:scale-[.995] @3xl:grid-cols-[minmax(0,1.5fr)_11rem_13rem_5rem] @3xl:gap-4"
                key={branch.name}
                onClick={() => setSelectedBranch(branch)}
                type="button"
              >
                <span className="flex min-w-0 items-start gap-3">
                  <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-current/[.045] text-current/35">
                    <GitBranch className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-current/85">{branch.name}</span>
                    <span className="mt-1 flex items-center gap-1.5 truncate text-[11px] text-current/35">
                      <GitCommitHorizontal className="size-3 shrink-0" /> {branch.commit} · {branch.relation}
                    </span>
                    <span className="mt-2 flex flex-wrap items-center gap-1.5 @3xl:hidden">
                      <PullRequestStatus branch={branch} />
                      <CheckoutStatus branch={branch} />
                    </span>
                  </span>
                </span>
                <ChevronRight className="size-4 text-current/20 transition-transform group-hover:translate-x-0.5 @3xl:hidden" />
                <span className="hidden @3xl:block"><PullRequestStatus branch={branch} /></span>
                <span className="hidden min-w-0 @3xl:block"><CheckoutStatus branch={branch} /></span>
                <span className="hidden items-center justify-between gap-2 text-[11px] text-current/30 @3xl:flex">
                  {branch.updated}<ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            ))}
            {visible.length === 0 ? (
              <div className="grid min-h-44 place-items-center px-6 text-center">
                <p className="text-sm text-current/40">No branches match this search and filter.</p>
              </div>
            ) : null}
          </div>
          <div className="flex h-9 shrink-0 items-center justify-between border-t border-current/[.06] px-2 text-[11px] text-current/30">
            <span>{visible.length} of {prototypeBranches.length} branches</span>
            <span>Live prototype fixtures from GitHub</span>
          </div>
        </div>
      )}
    </PageScaffold>
  );
}
