import { Button } from "@heroui/react";
import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  GitCompareArrows,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";

import { PageStatus, SectionHeading } from "./page-foundation";

export interface PrototypeBranch {
  commit: string;
  detail: string;
  health: "Behind" | "Current" | "Merged" | "Working";
  name: string;
  relation: string;
  updated: string;
}

const branchCommits = [
  { author: "Oli", message: "Restore full issue workflow", sha: "0248d9d", time: "now" },
  { author: "Oli", message: "Add issue board semantics and GitHub links", sha: "e7e769d", time: "18 min" },
  { author: "Oli", message: "Build responsive project pages", sha: "72c0f48", time: "42 min" },
];

export function BranchDetailView({ branch, onBack }: { branch: PrototypeBranch; onBack(): void }) {
  const branchUrl = `https://github.com/DotNaos/project-space/tree/${branch.name}`;
  const working = branch.health === "Working";

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-5 pb-6 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-3">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" /> Branches
          </Button>
          <a className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-current/50 hover:bg-current/[.05] hover:text-current" href={branchUrl} rel="noreferrer" target="_blank">
            Open on GitHub <ExternalLink className="size-3.5" />
          </a>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <PageStatus tone={working ? "info" : branch.health === "Current" ? "success" : "muted"}>{branch.health}</PageStatus>
          <span className="font-mono text-xs text-current/35">{branch.commit}</span>
        </div>
        <h1 className="mt-3 break-words text-2xl font-semibold leading-tight tracking-[-.03em] @md:text-[28px]">{branch.name}</h1>
        <p className="mt-2 text-xs text-current/35">{branch.detail} · updated {branch.updated}</p>
      </header>

      <div className="grid min-h-0 flex-1 gap-10 overflow-y-auto py-7 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.35fr)_minmax(17rem,.65fr)]">
        <main className="min-w-0">
          <SectionHeading>Compared with main</SectionHeading>
          <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
            {[
              { icon: ArrowUpRight, label: "Ahead", value: working ? "3" : "0" },
              { icon: ArrowDownLeft, label: "Behind", value: branch.health === "Behind" ? "3" : "0" },
              { icon: GitCommitHorizontal, label: "Commits", value: working ? "3" : "12" },
              { icon: GitCompareArrows, label: "Changed files", value: working ? "14" : "0" },
            ].map(({ icon: Icon, label, value }) => (
              <div className="rounded-xl bg-current/[.035] px-3 py-3" key={label}>
                <Icon className="size-3.5 text-current/35" />
                <span className="mt-3 block text-lg font-semibold tabular-nums">{value}</span>
                <span className="mt-0.5 block text-[11px] text-current/35">{label}</span>
              </div>
            ))}
          </div>

          <section className="mt-9">
            <SectionHeading meta={`${branchCommits.length} recent`}>Commits</SectionHeading>
            <div className="border-y border-current/[.08]">
              {branchCommits.map((commit) => (
                <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-current/[.06] py-3.5 text-left last:border-0 hover:bg-current/[.025]" key={commit.sha} type="button">
                  <span className="mt-0.5 grid size-7 place-items-center rounded-full bg-current/[.05] text-current/40"><GitCommitHorizontal className="size-3.5" /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{commit.message}</span>
                    <span className="mt-1 block text-[11px] text-current/35">{commit.author} · {commit.sha}</span>
                  </span>
                  <span className="text-[11px] text-current/25">{commit.time}</span>
                </button>
              ))}
            </div>
          </section>
        </main>

        <aside className="min-w-0">
          <SectionHeading>Development</SectionHeading>
          <div className="border-y border-current/[.08] py-2">
            {[
              ["Issue", branch.detail],
              ["Pull request", working ? "Not opened yet" : "Merged"],
              ["Worktree", working ? "Local workspace" : "No active worktree"],
            ].map(([label, value]) => (
              <div className="py-2.5" key={label}>
                <span className="block text-[11px] text-current/35">{label}</span>
                <span className="mt-1 block truncate text-xs font-medium text-current/65">{value}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-2">
            {working ? <Button variant="primary"><GitPullRequest className="size-4" /> Create pull request</Button> : null}
            <Button variant="secondary"><GitCompareArrows className="size-4" /> Compare with main</Button>
            {branch.health === "Behind" ? <Button variant="outline"><RefreshCw className="size-4" /> Update from main</Button> : null}
          </div>
          <div className="mt-8">
            <SectionHeading>Protection</SectionHeading>
            <div className="flex items-start gap-2.5 border-y border-current/[.08] py-4 text-xs leading-5 text-current/50">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
              Changes must pass local checks and pull-request review before they reach main.
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
