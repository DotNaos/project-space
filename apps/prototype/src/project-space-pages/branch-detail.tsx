import { useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Download,
  ExternalLink,
  FileDiff,
  FolderOpen,
  GitCommitHorizontal,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  Laptop,
  Monitor,
  RefreshCw,
} from "lucide-react";

import type { PrototypeBranch, PrototypeWorkspace } from "./branch-fixtures";
import { PageStatus, SectionHeading } from "./page-foundation";
import { WorkspaceDetailView, type WorkspaceView } from "./workspace-detail";

const machines = [
  { detail: "macOS · local development", icon: Laptop, name: "Local" },
  { detail: "Windows · stable", icon: Monitor, name: "os-pc" },
  { detail: "Linux · stable", icon: Monitor, name: "os-yoga-unix" },
];

function commitsFor(branch: PrototypeBranch) {
  return [
    { author: "Oli", message: branch.name === "main" ? "Release the current Project Space version" : "Continue branch implementation", sha: branch.commit.slice(0, 7), time: branch.updated },
    { author: "Oli", message: "Keep delivery evidence connected to project work", sha: "e7e769d", time: "18m" },
    { author: "Codex", message: "Align the prototype navigation and responsive shell", sha: "72c0f48", time: "42m" },
    { author: "Oli", message: "Merge the latest protected main revision", sha: "dc6bd8d", time: "4h" },
  ];
}

function PullRequestSummary({ branch }: { branch: PrototypeBranch }) {
  if (!branch.pullRequest) {
    return (
      <div className="flex items-center justify-between gap-4 border-y border-current/[.08] py-3">
        <span className="flex items-center gap-2 text-xs text-current/40"><GitPullRequest className="size-3.5" /> No pull request</span>
        <Button size="sm" variant="secondary"><GitPullRequest className="size-3.5" /> Create PR</Button>
      </div>
    );
  }
  const merged = branch.pullRequest.state === "Merged";
  const PullRequestIcon = merged ? GitMerge : GitPullRequest;
  return (
    <a
      className="flex items-center justify-between gap-4 border-y border-current/[.08] py-3 hover:bg-current/[.025]"
      href={`https://github.com/DotNaos/project-space/pull/${branch.pullRequest.number}`}
      rel="noreferrer"
      target="_blank"
    >
      <span className={`flex min-w-0 items-center gap-2 text-xs font-medium ${merged ? "text-violet-300" : "text-emerald-300"}`}>
        <PullRequestIcon className="size-3.5" /> #{branch.pullRequest.number}
      </span>
      <ExternalLink className="size-3.5 text-current/30" />
    </a>
  );
}

export function BranchDetailView({ branch, onBack }: { branch: PrototypeBranch; onBack(): void }) {
  const branchUrl = `https://github.com/DotNaos/project-space/tree/${branch.name}`;
  const [workspaces, setWorkspaces] = useState(branch.workspaces);
  const [selectedWorkspace, setSelectedWorkspace] = useState<{
    initialView: WorkspaceView;
    workspace: PrototypeWorkspace;
  } | null>(null);
  const branchCommits = commitsFor(branch);

  if (selectedWorkspace) {
    return (
      <WorkspaceDetailView
        initialView={selectedWorkspace.initialView}
        onBack={() => setSelectedWorkspace(null)}
        workspace={selectedWorkspace.workspace}
      />
    );
  }

  const checkout = (machine: string) => {
    setWorkspaces((current) => [...current, {
      branch: branch.name,
      health: "Clean",
      machine,
      name: branch.detail,
      updated: "now",
    }]);
  };

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-6 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-4">
        <div className="flex items-center justify-between gap-3">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" /> Branches
          </Button>
          <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-current/50 hover:bg-current/[.05] hover:text-current" href={branchUrl} rel="noreferrer" target="_blank">
            GitHub <ExternalLink className="size-3.5" />
          </a>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PageStatus tone={branch.health === "Current" ? "success" : branch.health === "Behind" ? "danger" : "info"}>{branch.health}</PageStatus>
          <span className="font-mono text-xs text-current/35">{branch.commit}</span>
          <span className="text-xs text-current/30">{branch.relation}</span>
        </div>
        <h1 className="mt-2 break-words text-xl font-semibold leading-tight tracking-[-.03em] @md:text-2xl">{branch.name}</h1>
      </header>

      <div className="grid min-h-0 flex-1 gap-10 overflow-y-auto py-6 [scrollbar-width:none] @5xl:grid-cols-[minmax(0,1.25fr)_minmax(20rem,.75fr)] @5xl:gap-12">
        <main className="min-w-0">
          <SectionHeading meta={`${branchCommits.length} recent commits`}>History</SectionHeading>
          <div className="grid grid-cols-3 border-y border-current/[.08] py-3">
            {[
              { icon: ArrowUpRight, label: "Ahead", value: branch.name === "main" ? "0" : branch.relation.match(/\d+/u)?.[0] ?? "1" },
              { icon: ArrowDownLeft, label: "Behind", value: branch.health === "Behind" ? "3" : "0" },
              { icon: FileDiff, label: "Changed files", value: branch.name.includes("437") ? "18" : "6" },
            ].map(({ icon: Icon, label, value }) => (
              <div className="border-r border-current/[.07] px-3 last:border-0" key={label}>
                <span className="flex items-center gap-1.5 text-[11px] text-current/35"><Icon className="size-3.5" /> {label}</span>
                <span className="mt-1 block text-lg font-semibold tabular-nums">{value}</span>
              </div>
            ))}
          </div>

          <div className="relative mt-5 pl-7 before:absolute before:bottom-5 before:left-[7px] before:top-5 before:w-px before:bg-current/[.12]">
            {branchCommits.map((commit, index) => (
              <button className="relative grid w-full grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-current/[.065] py-3.5 text-left hover:bg-current/[.025]" key={`${commit.sha}-${index}`} type="button">
                <span className={`absolute -left-7 top-[18px] grid size-3.5 place-items-center rounded-full ring-4 ring-[var(--prototype-main-surface)] ${index === 0 ? "bg-blue-400" : "bg-current/25"}`}>
                  {index === 0 ? <span className="size-1 rounded-full bg-neutral-950" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{commit.message}</span>
                  <span className="mt-1 block font-mono text-[11px] text-current/35">{commit.sha} · {commit.author}</span>
                </span>
                <span className="text-[11px] text-current/25">{commit.time}</span>
              </button>
            ))}
          </div>

          <div className="mt-8">
            <SectionHeading>Pull request</SectionHeading>
            <PullRequestSummary branch={branch} />
          </div>
        </main>

        <aside className="min-w-0">
          <SectionHeading meta={`${workspaces.length} checked out`}>Machine workspaces</SectionHeading>
          <div className="border-y border-current/[.08]">
            {machines.map(({ detail, icon: Icon, name }) => {
              const workspace = workspaces.find((candidate) => candidate.machine === name);
              return (
                <section className="border-b border-current/[.07] py-2 last:border-0" key={name}>
                  <div className="flex min-h-8 items-center gap-2">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-current/[.045] text-current/35"><Icon className="size-3.5" /></span>
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {name}
                      <span className="ml-2 hidden text-[10px] font-normal text-current/25 @4xl:inline">{detail}</span>
                    </span>
                    {workspace ? (
                      <span className="flex shrink-0 items-center gap-1">
                        <button
                          aria-label={`Open changes on ${name}`}
                          className="rounded-full transition-[filter,scale] duration-150 hover:brightness-125 active:scale-[.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
                          onClick={() => setSelectedWorkspace({ initialView: "Changes", workspace })}
                          type="button"
                        >
                          <PageStatus tone={workspace.health === "Modified" ? "warning" : workspace.health === "Clean" ? "success" : "muted"}>{workspace.health}</PageStatus>
                        </button>
                        <Button
                          isIconOnly
                          aria-label={`Open workspace on ${name}`}
                          className="size-8 min-w-8 text-current/40"
                          size="sm"
                          variant="ghost"
                          onPress={() => setSelectedWorkspace({ initialView: "Files", workspace })}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                      </span>
                    ) : (
                      <Button
                        isIconOnly
                        aria-label={`Check out branch on ${name}`}
                        className="size-8 min-w-8 text-current/35"
                        size="sm"
                        variant="ghost"
                        onPress={() => checkout(name)}
                      >
                        <Download className="size-3.5" />
                      </Button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          <div className="mt-5 grid w-full grid-cols-2 gap-2">
            <Button className="w-full" variant="secondary"><GitCompareArrows className="size-4" /> Compare</Button>
            <Button className="w-full" variant="outline"><RefreshCw className="size-4" /> Refresh</Button>
          </div>
        </aside>
      </div>
    </section>
  );
}
