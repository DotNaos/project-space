import { useMemo, useState } from "react";
import { ArrowRight, CircleDot, GitPullRequest, Plus, Sparkles } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  PageFilter,
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const overviewActivity = [
  { meta: "Now", text: "Responsive grid and iPhone safe areas verified", title: "#437" },
  { meta: "12 min", text: "Prototype baseline pushed to the issue branch", title: "72c0f48" },
  { meta: "4 h", text: "Production deployment verified", title: "v0.4.56" },
];

export function ProjectOverviewPage({ projectName }: { projectName: string }) {
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New issue</PagePrimaryAction>}
      description="The work that matters now, without turning the project into a dashboard."
      projectName={projectName}
      title="Overview"
    >
      <div className="grid gap-8 py-6 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(16rem,.65fr)] @3xl:gap-12 @5xl:py-8">
        <div className="min-w-0">
          <SectionHeading>Current focus</SectionHeading>
          <button
            className="group flex w-full items-start gap-4 border-y border-current/[.08] py-5 text-left active:scale-[.99]"
            type="button"
          >
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-blue-500/10 text-blue-400">
              <Sparkles className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">#437 · Frontend redesign</span>
                <PageStatus tone="info">In progress</PageStatus>
              </span>
              <span className="mt-1.5 block text-sm leading-5 text-current/45">
                Build a calmer, guided Project Space experience around issues and active work.
              </span>
              <span className="mt-3 flex items-center gap-2 text-xs text-current/40">
                issue-437-redesign-the-project-space-frontend
                <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </span>
          </button>

          <div className="mt-8">
            <SectionHeading meta="Today">Recent activity</SectionHeading>
            <div className="border-y border-current/[.08]">
              {overviewActivity.map((item) => (
                <button
                  className="flex w-full items-center gap-4 border-b border-current/[.06] py-3.5 text-left last:border-0 hover:bg-current/[.025]"
                  key={item.title}
                  type="button"
                >
                  <span className="w-14 shrink-0 text-xs font-medium text-current/65">{item.title}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-current/55">{item.text}</span>
                  <span className="shrink-0 text-xs text-current/30">{item.meta}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <SectionHeading>Project pulse</SectionHeading>
          <dl className="border-y border-current/[.08]">
            {[
              ["Open issues", "24", "6 active"],
              ["Branches", "16", "2 behind main"],
              ["Codex tasks", "3", "1 working"],
              ["Production", "Healthy", "v0.4.56"],
            ].map(([label, value, detail]) => (
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-current/[.06] py-3.5 last:border-0" key={label}>
                <dt className="text-sm text-current/45">{label}</dt>
                <dd className="text-right">
                  <span className="block text-sm font-medium tabular-nums">{value}</span>
                  <span className="mt-0.5 block text-[11px] text-current/30">{detail}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </PageScaffold>
  );
}

type IssueState = "Done" | "In progress" | "Open";

const issues: Array<{
  labels: string[];
  number: number;
  state: IssueState;
  title: string;
  updated: string;
}> = [
  { labels: ["frontend", "design"], number: 437, state: "In progress", title: "Redesign the Project Space frontend", updated: "now" },
  { labels: ["preview", "infrastructure"], number: 426, state: "Open", title: "Add an on-demand PR Preview hub", updated: "2h" },
  { labels: ["ci", "reliability"], number: 434, state: "Done", title: "Make agent-authored PR revisions green", updated: "4h" },
  { labels: ["ci", "performance"], number: 419, state: "Done", title: "Improve CI/CD reliability and speed", updated: "yesterday" },
  { labels: ["git", "history"], number: 408, state: "Open", title: "Show a focused Git graph around the branch head", updated: "yesterday" },
  { labels: ["prototype", "security"], number: 395, state: "Done", title: "Require verified live iteration for prototypes", updated: "Jul 30" },
];

const issueTone: Record<IssueState, "info" | "muted" | "success"> = {
  Done: "success",
  "In progress": "info",
  Open: "muted",
};

export function ProjectIssuesPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const [filter, setFilter] = useState<"All" | IssueState>("All");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => issues.filter((issue) => {
    const matchesState = filter === "All" || issue.state === filter;
    const haystack = `${issue.number} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
    return matchesState && haystack.includes(query.toLowerCase());
  }), [filter, query]);
  const unavailable = scenario === "empty" || scenario === "offline";

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New issue</PagePrimaryAction>}
      description="Start with the next useful piece of work, then follow it through delivery."
      projectName={projectName}
      title="Issues"
    >
      <div className="flex flex-col gap-3 border-b border-current/[.08] py-4 @md:flex-row @md:items-center @md:justify-between">
        <PageSearch onChange={setQuery} placeholder="Search issues" value={query} />
        <div className="flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {(["All", "Open", "In progress", "Done"] as const).map((value) => (
            <PageFilter active={filter === value} key={value} onPress={() => setFilter(value)}>
              {value}
            </PageFilter>
          ))}
        </div>
      </div>

      {unavailable ? <PageState emptyCopy="Create the first issue to start this project's workflow." scenario={scenario} /> : (
        <div className="divide-y divide-current/[.07]">
          {visible.map((issue) => (
            <button
              className="group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 py-4 text-left hover:bg-current/[.02] @md:grid-cols-[auto_minmax(0,1fr)_auto] @md:gap-4"
              key={issue.number}
              type="button"
            >
              <CircleDot aria-hidden className={`mt-0.5 size-4 ${issue.state === "Done" ? "text-emerald-400" : "text-current/40"}`} strokeWidth={1.8} />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-5">
                  <span className="mr-2 text-current/35">#{issue.number}</span>{issue.title}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5">
                  {issue.labels.map((label) => (
                    <span className="rounded-full bg-current/[.05] px-2 py-0.5 text-[10px] text-current/45" key={label}>{label}</span>
                  ))}
                  <span className="ml-1 text-[10px] text-current/25">updated {issue.updated}</span>
                </span>
              </span>
              <span className="col-start-2 row-start-2 mt-1 flex items-center gap-2 @md:col-start-3 @md:row-start-1 @md:mt-0">
                {issue.number === 437 ? <GitPullRequest className="size-3.5 text-current/30" /> : null}
                <PageStatus tone={issueTone[issue.state]}>{issue.state}</PageStatus>
              </span>
            </button>
          ))}
          {visible.length === 0 ? (
            <div className="grid min-h-40 place-items-center text-sm text-current/40">No matching issues</div>
          ) : null}
        </div>
      )}
    </PageScaffold>
  );
}
