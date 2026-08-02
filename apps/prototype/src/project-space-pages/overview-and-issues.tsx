import {
  ArrowRight,
  Bot,
  CircleDot,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Monitor,
  Plus,
  Rocket,
  Sparkles,
} from "lucide-react";

import type { ProjectPageId } from "../project-space-pages";
import {
  PagePrimaryAction,
  PageScaffold,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const priorityIssues = [
  { meta: "No pull request", number: 437, state: "In progress", title: "Redesign the Project Space frontend" },
  { meta: "Preview unavailable", number: 431, state: "Open", title: "Fix Preview runner configuration" },
  { meta: "2 checks failing", number: 436, state: "Open", title: "Fix Preview cleanup proof" },
];

const branchHealth = [
  { name: "issue-437-redesign-the-project-space-frontend", note: "24 commits ahead", status: "Active" },
  { name: "issue-431-preview-runner-config", note: "3 commits behind main", status: "Behind" },
  { name: "main", note: "dc6bd8d · production", status: "Protected" },
];

export function ProjectOverviewPage({
  onNavigate,
  onNewIssue,
  projectName,
}: {
  onNavigate?(page: ProjectPageId): void;
  onNewIssue?(): void;
  projectName: string;
}) {
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />} onPress={onNewIssue}>New issue</PagePrimaryAction>}
      description="The work that matters now, without turning the project into a dashboard."
      projectName={projectName}
      title="Overview"
    >
      <div className="grid gap-10 py-6 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)] @3xl:gap-12 @5xl:py-8">
        <main className="min-w-0 space-y-9">
          <section>
            <SectionHeading>Current focus</SectionHeading>
            <button
              className="group flex w-full items-start gap-4 rounded-2xl bg-blue-500/[.07] px-4 py-5 text-left transition-[background-color,scale] duration-150 hover:bg-blue-500/[.1] active:scale-[.99]"
              onClick={() => onNavigate?.("issues")}
              type="button"
            >
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-blue-500/12 text-blue-400">
                <Sparkles className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">#437 · Frontend redesign</span>
                  <PageStatus tone="info">In progress</PageStatus>
                </span>
                <span className="mt-1.5 block text-sm leading-5 text-current/50">
                  Rebuild every project workflow inside one calmer, guided interface.
                </span>
                <span className="mt-3 flex items-center gap-2 text-xs text-current/40">
                  issue-437-redesign-the-project-space-frontend
                  <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
            </button>
          </section>

          <section>
            <SectionHeading meta="3 items">Needs attention</SectionHeading>
            <div className="border-y border-current/[.08]">
              {priorityIssues.map((issue) => (
                <button
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-current/[.06] py-3.5 text-left transition hover:bg-current/[.025] last:border-0"
                  key={issue.number}
                  onClick={() => onNavigate?.("issues")}
                  type="button"
                >
                  <CircleDot className={`size-3.5 ${issue.state === "In progress" ? "text-blue-400" : "text-current/30"}`} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">#{issue.number} · {issue.title}</span>
                    <span className="mt-1 block text-xs text-current/35">{issue.meta}</span>
                  </span>
                  <ArrowRight className="size-3.5 text-current/25" />
                </button>
              ))}
            </div>
          </section>

          <section>
            <SectionHeading meta="16 total">Branch health</SectionHeading>
            <div className="border-y border-current/[.08]">
              {branchHealth.map((branch) => (
                <button
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-current/[.06] py-3.5 text-left transition hover:bg-current/[.025] last:border-0"
                  key={branch.name}
                  onClick={() => onNavigate?.("branches")}
                  type="button"
                >
                  <GitBranch className="size-3.5 text-current/35" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{branch.name}</span>
                    <span className="mt-1 block text-xs text-current/35">{branch.note}</span>
                  </span>
                  <PageStatus tone={branch.status === "Active" ? "success" : branch.status === "Behind" ? "warning" : "muted"}>{branch.status}</PageStatus>
                </button>
              ))}
            </div>
          </section>
        </main>

        <aside className="min-w-0 space-y-9">
          <section>
            <SectionHeading>Development session</SectionHeading>
            <div className="border-y border-current/[.08] py-3">
              {[
                { icon: Monitor, label: "Destination", value: "Local workspace" },
                { icon: FolderGit2, label: "Checkout", value: "issue-437-redesign…" },
                { icon: Bot, label: "Chat", value: "Frontend redesign" },
                { icon: GitPullRequest, label: "Pull request", value: "Not opened yet" },
              ].map(({ icon: Icon, label, value }) => (
                <div className="flex items-center gap-3 py-2.5" key={label}>
                  <Icon className="size-3.5 shrink-0 text-current/30" />
                  <span className="min-w-0 flex-1 text-xs text-current/40">{label}</span>
                  <span className="max-w-[55%] truncate text-xs font-medium text-current/65">{value}</span>
                </div>
              ))}
            </div>
          </section>

          <section>
            <SectionHeading>Production</SectionHeading>
            <button
              className="flex w-full items-center gap-3 border-y border-current/[.08] py-4 text-left transition hover:bg-current/[.025]"
              onClick={() => onNavigate?.("deployments")}
              type="button"
            >
              <span className="grid size-9 place-items-center rounded-full bg-emerald-500/10 text-emerald-400"><Rocket className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">v0.4.56</span>
                <span className="mt-1 block truncate text-xs text-current/35">dc6bd8d · projects.os-home.net</span>
              </span>
              <PageStatus tone="success">Healthy</PageStatus>
            </button>
          </section>

          <section>
            <SectionHeading>Project pulse</SectionHeading>
            <dl className="border-y border-current/[.08]">
              {[
                ["Open issues", "24", "6 active"],
                ["Branches", "16", "2 behind main"],
                ["Chats", "3", "1 working"],
                ["Checked out branches", "3", "2 modified"],
              ].map(([label, value, detail]) => (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-current/[.06] py-3 last:border-0" key={label}>
                  <dt className="text-xs text-current/40">{label}</dt>
                  <dd className="flex items-center gap-2 text-right text-xs font-medium tabular-nums">
                    {value}<span className="font-normal text-current/30">{detail}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </aside>
      </div>
    </PageScaffold>
  );
}
