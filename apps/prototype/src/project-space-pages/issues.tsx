import { useMemo, useState } from "react";
import { CircleDot, Columns3, GitBranch, GitPullRequest, List, Plus } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  PageFilter,
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
} from "./page-foundation";
import {
  prototypeIssueColumns,
  prototypeIssues,
  type PrototypeIssue,
  type PrototypeIssueState,
} from "./issue-fixtures";

export type PrototypeIssueViewMode = "board" | "list";

const issueTone: Record<PrototypeIssueState, "danger" | "info" | "muted" | "success"> = {
  Blocked: "danger",
  Done: "success",
  "In progress": "info",
  Open: "muted",
};

function IssueViewSwitch({
  onChange,
  value,
}: {
  onChange(value: PrototypeIssueViewMode): void;
  value: PrototypeIssueViewMode;
}) {
  return (
    <div aria-label="Issue view" className="flex h-9 shrink-0 items-center rounded-xl bg-current/[.05] p-1" role="group">
      {([
        ["board", Columns3, "Board"],
        ["list", List, "List"],
      ] as const).map(([id, Icon, label]) => (
        <button
          aria-pressed={value === id}
          className={`flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-[background-color,color,scale] active:scale-[.96] ${
            value === id ? "bg-current/[.1] text-current" : "text-current/40 hover:text-current/70"
          }`}
          key={id}
          onClick={() => onChange(id)}
          type="button"
        >
          <Icon className="size-3.5" strokeWidth={value === id ? 2 : 1.7} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function IssueLabels({ issue }: { issue: PrototypeIssue }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {issue.labels.map((label) => (
        <span className="rounded-full bg-current/[.05] px-2 py-0.5 text-[10px] text-current/45" key={label}>
          {label}
        </span>
      ))}
    </span>
  );
}

function IssueList({
  issues,
  onOpenIssue,
}: {
  issues: PrototypeIssue[];
  onOpenIssue(number: number): void;
}) {
  return (
    <div className="divide-y divide-current/[.07]">
      {issues.map((issue) => (
        <button
          aria-label={`Open issue #${issue.number}: ${issue.title}`}
          className="group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 py-4 text-left transition-[background-color,scale] hover:bg-current/[.02] active:scale-[.99] @md:grid-cols-[auto_minmax(0,1fr)_auto] @md:gap-4"
          key={issue.number}
          onClick={() => onOpenIssue(issue.number)}
          type="button"
        >
          <CircleDot
            aria-hidden
            className={`mt-0.5 size-4 ${issue.state === "Done" ? "text-emerald-400" : issue.state === "Blocked" ? "text-red-400" : "text-current/40"}`}
            strokeWidth={1.8}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium leading-5">
              <span className="mr-2 text-current/35">#{issue.number}</span>{issue.title}
            </span>
            <span className="mt-2 flex flex-wrap items-center gap-2">
              <IssueLabels issue={issue} />
              <span className="text-[11px] text-current/30">Updated {issue.updated}</span>
            </span>
          </span>
          <span className="col-start-2 row-start-2 mt-1 flex items-center gap-2 @md:col-start-3 @md:row-start-1 @md:mt-0">
            {issue.pullRequest ? <GitPullRequest className="size-3.5 text-current/30" /> : issue.branch ? <GitBranch className="size-3.5 text-current/30" /> : null}
            <PageStatus tone={issueTone[issue.state]}>{issue.state}</PageStatus>
          </span>
        </button>
      ))}
    </div>
  );
}

function IssueBoard({
  issues,
  onOpenIssue,
}: {
  issues: PrototypeIssue[];
  onOpenIssue(number: number): void;
}) {
  return (
    <div
      aria-label="Issue board"
      className="grid min-h-0 flex-1 auto-cols-[minmax(12.5rem,1fr)] grid-flow-col gap-2.5 overflow-x-auto overscroll-x-contain py-4 [scrollbar-width:none]"
    >
      {prototypeIssueColumns.map((column) => {
        const columnIssues = issues.filter((issue) => issue.column === column.id);
        return (
          <section className="flex min-h-72 min-w-0 flex-col rounded-2xl bg-current/[.022] p-2" key={column.id}>
            <header className="flex h-10 shrink-0 items-center gap-2 px-2">
              <span className={`size-1.5 rounded-full ${column.tone}`} />
              <h2 className="text-xs font-medium text-current/65">{column.id}</h2>
              <span className="ml-auto rounded-full bg-current/[.055] px-2 py-0.5 text-[11px] tabular-nums text-current/40">
                {columnIssues.length}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {columnIssues.map((issue) => (
                <button
                  aria-label={`Open issue #${issue.number}: ${issue.title}`}
                  className="group rounded-xl bg-current/[.04] p-3 text-left ring-1 ring-inset ring-current/[.06] transition-[background-color,scale] hover:bg-current/[.065] active:scale-[.96]"
                  key={issue.number}
                  onClick={() => onOpenIssue(issue.number)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-3 text-[11px] text-current/35">
                    <span>#{issue.number}</span>
                    <span className="truncate">Updated {issue.updated}</span>
                  </span>
                  <span className="mt-2 block text-sm font-medium leading-5 text-wrap-pretty">{issue.title}</span>
                  <span className="mt-3 block"><IssueLabels issue={issue} /></span>
                  {issue.branch || issue.pullRequest ? (
                    <span className="mt-3 flex items-center gap-1.5 border-t border-current/[.06] pt-2.5 text-[10px] text-current/35">
                      {issue.pullRequest ? <GitPullRequest className="size-3" /> : <GitBranch className="size-3" />}
                      <span className="truncate">{issue.pullRequest ?? issue.branch}</span>
                    </span>
                  ) : null}
                </button>
              ))}
              {columnIssues.length === 0 ? (
                <div className="grid min-h-24 flex-1 place-items-center px-4 text-center text-xs text-current/25">{column.hint}</div>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export function ProjectIssuesPage({
  onOpenIssue,
  onViewModeChange,
  projectName,
  scenario,
  viewMode,
}: {
  onOpenIssue(number: number): void;
  onViewModeChange(viewMode: PrototypeIssueViewMode): void;
  projectName: string;
  scenario: PrototypeScenarioKind;
  viewMode: PrototypeIssueViewMode;
}) {
  const [filter, setFilter] = useState<"All" | PrototypeIssueState>("All");
  const [query, setQuery] = useState("");
  const visible = useMemo(() => prototypeIssues.filter((issue) => {
    const matchesState = filter === "All" || issue.state === filter;
    const haystack = `${issue.number} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
    return matchesState && haystack.includes(query.toLowerCase());
  }), [filter, query]);
  const unavailable = scenario === "empty" || scenario === "offline";

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New issue</PagePrimaryAction>}
      description="Plan, track, and finish work without losing its delivery context."
      projectName={projectName}
      title="Issues"
    >
      <div className="flex flex-col gap-3 border-b border-current/[.08] py-4 @xl:flex-row @xl:items-center">
        <PageSearch onChange={setQuery} placeholder="Search issues" value={query} />
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] @xl:ml-auto">
          {(["All", "Open", "In progress", "Blocked", "Done"] as const).map((value) => (
            <PageFilter active={filter === value} key={value} onPress={() => setFilter(value)}>
              <span>{value}</span>
              <span className="text-[10px] tabular-nums text-current/35">
                {value === "All" ? prototypeIssues.length : prototypeIssues.filter((issue) => issue.state === value).length}
              </span>
            </PageFilter>
          ))}
        </div>
        <IssueViewSwitch onChange={onViewModeChange} value={viewMode} />
      </div>

      {unavailable ? (
        <PageState emptyCopy="Create the first issue to start this project's workflow." scenario={scenario} />
      ) : visible.length === 0 ? (
        <div className="grid min-h-40 place-items-center text-sm text-current/40">No matching issues</div>
      ) : viewMode === "board" ? (
        <IssueBoard issues={visible} onOpenIssue={onOpenIssue} />
      ) : (
        <IssueList issues={visible} onOpenIssue={onOpenIssue} />
      )}
    </PageScaffold>
  );
}
