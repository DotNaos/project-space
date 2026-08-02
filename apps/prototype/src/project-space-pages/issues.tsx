import type { SortDescriptor } from "@heroui/react";
import { Label, ListBox, Select, Table } from "@heroui/react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3, GitBranch, GitPullRequest, List, Plus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

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
export type PrototypeIssueDevelopmentFilter = "All" | "Branch" | "Pull request" | "Unlinked";

const issueUpdatedOrder = new Map(prototypeIssues.map((issue, index) => [issue.number, index]));

function issueDevelopmentLabel(issue: PrototypeIssue) {
  return issue.pullRequest ?? issue.branch ?? "Unlinked";
}

export function filterAndSortPrototypeIssues({
  development,
  issues,
  label,
  sortDescriptor,
}: {
  development: PrototypeIssueDevelopmentFilter;
  issues: PrototypeIssue[];
  label: "All" | string;
  sortDescriptor: SortDescriptor;
}) {
  const filtered = issues.filter((issue) => {
    const matchesLabel = label === "All" || issue.labels.includes(label);
    const matchesDevelopment = development === "All"
      || (development === "Branch" && Boolean(issue.branch))
      || (development === "Pull request" && Boolean(issue.pullRequest))
      || (development === "Unlinked" && !issue.branch && !issue.pullRequest);
    return matchesLabel && matchesDevelopment;
  });

  return filtered.sort((first, second) => {
    let comparison = 0;
    switch (sortDescriptor.column) {
      case "issue":
        comparison = first.number - second.number;
        break;
      case "status":
        comparison = first.state.localeCompare(second.state);
        break;
      case "development":
        comparison = issueDevelopmentLabel(first).localeCompare(issueDevelopmentLabel(second));
        break;
      case "updated":
      default:
        comparison = (issueUpdatedOrder.get(second.number) ?? 0) - (issueUpdatedOrder.get(first.number) ?? 0);
        break;
    }
    return sortDescriptor.direction === "descending" ? -comparison : comparison;
  });
}

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

function SortableColumnLabel({
  children,
  sortDirection,
}: {
  children: string;
  sortDirection?: "ascending" | "descending";
}) {
  const Icon = sortDirection === "ascending"
    ? ArrowUp
    : sortDirection === "descending"
      ? ArrowDown
      : ChevronsUpDown;
  return (
    <span className="flex items-center gap-1.5">
      {children}
      <Icon className={`size-3 ${sortDirection ? "text-current/65" : "text-current/25"}`} />
    </span>
  );
}

function IssueTableFilter({
  ariaLabel,
  items,
  onChange,
  value,
}: {
  ariaLabel: string;
  items: Array<{ id: string; label: string }>;
  onChange(value: string): void;
  value: string;
}) {
  return (
    <Select
      className="w-full @md:w-44"
      fullWidth
      value={value}
      variant="secondary"
      onChange={(next) => next && onChange(String(next))}
    >
      <Label className="sr-only">{ariaLabel}</Label>
      <Select.Trigger
        aria-label={ariaLabel}
        className="h-9 rounded-xl border border-current/[.08] bg-current/[.035] px-3 text-xs shadow-none"
      >
        <Select.Value>{items.find((item) => item.id === value)?.label}</Select.Value>
        <Select.Indicator className="size-3.5 text-current/35" />
      </Select.Trigger>
      <Select.Popover className="min-w-48 rounded-xl border border-current/[.1] bg-neutral-950 p-1 shadow-xl shadow-black/30">
        <ListBox>
          {items.map((item) => (
            <ListBox.Item
              className="rounded-lg px-3 py-2 text-xs text-neutral-300 data-[focused=true]:bg-white/[.07] data-[selected=true]:text-white"
              id={item.id}
              key={item.id}
              textValue={item.label}
            >
              {item.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

function IssueTable({
  development,
  issues,
  label,
  labels,
  onDevelopmentChange,
  onLabelChange,
  onOpenIssue,
  onResetFilters,
  onSortChange,
  sortDescriptor,
}: {
  development: PrototypeIssueDevelopmentFilter;
  issues: PrototypeIssue[];
  label: string;
  labels: string[];
  onDevelopmentChange(value: PrototypeIssueDevelopmentFilter): void;
  onLabelChange(value: string): void;
  onOpenIssue(number: number): void;
  onResetFilters(): void;
  onSortChange(value: SortDescriptor): void;
  sortDescriptor: SortDescriptor;
}) {
  const hasTableFilters = label !== "All" || development !== "All";

  return (
    <div className="pb-4 pt-3">
      <div aria-label="Issue table filters" className="flex flex-col gap-2 @md:flex-row @md:items-end">
        <IssueTableFilter
          ariaLabel="Filter by label"
          items={[{ id: "All", label: "All labels" }, ...labels.map((item) => ({ id: item, label: item }))]}
          onChange={onLabelChange}
          value={label}
        />
        <IssueTableFilter
          ariaLabel="Filter by development"
          items={[
            { id: "All", label: "Any development" },
            { id: "Branch", label: "Has branch" },
            { id: "Pull request", label: "Has pull request" },
            { id: "Unlinked", label: "Not linked" },
          ]}
          onChange={(value) => onDevelopmentChange(value as PrototypeIssueDevelopmentFilter)}
          value={development}
        />
        {hasTableFilters ? (
          <button
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3 text-xs font-medium text-current/45 transition-[background-color,color,scale] hover:bg-current/[.05] hover:text-current/70 active:scale-[.96] @md:ml-1"
            onClick={onResetFilters}
            type="button"
          >
            <RotateCcw className="size-3.5" />
            Clear filters
          </button>
        ) : null}
        <span className="text-xs tabular-nums text-current/35 @md:ml-auto @md:pb-2">
          {issues.length} {issues.length === 1 ? "issue" : "issues"}
        </span>
      </div>

      <Table className="mt-3 overflow-hidden rounded-2xl border border-current/[.08]" variant="secondary">
        <Table.ScrollContainer className="overflow-x-auto [scrollbar-width:thin]">
          <Table.Content
            aria-label="Issue table"
            className="min-w-[760px]"
            sortDescriptor={sortDescriptor}
            onSortChange={onSortChange}
          >
            <Table.Header className="border-b border-current/[.08] bg-current/[.025]">
              <Table.Column allowsSorting isRowHeader className="w-[35%]" id="issue">
                {({ sortDirection }) => (
                  <SortableColumnLabel sortDirection={sortDirection}>Issue</SortableColumnLabel>
                )}
              </Table.Column>
              <Table.Column allowsSorting id="status">
                {({ sortDirection }) => (
                  <SortableColumnLabel sortDirection={sortDirection}>Status</SortableColumnLabel>
                )}
              </Table.Column>
              <Table.Column>Labels</Table.Column>
              <Table.Column allowsSorting id="updated">
                {({ sortDirection }) => (
                  <SortableColumnLabel sortDirection={sortDirection}>Updated</SortableColumnLabel>
                )}
              </Table.Column>
              <Table.Column allowsSorting className="w-[22%]" id="development">
                {({ sortDirection }) => (
                  <SortableColumnLabel sortDirection={sortDirection}>Development</SortableColumnLabel>
                )}
              </Table.Column>
            </Table.Header>
            <Table.Body>
              {issues.map((issue) => (
                <Table.Row className="border-b border-current/[.06] last:border-b-0 hover:bg-current/[.025]" id={issue.number} key={issue.number}>
                  <Table.Cell>
                    <button
                      aria-label={`Open issue #${issue.number}: ${issue.title}`}
                      className="group flex min-w-0 items-start gap-2.5 py-1 text-left active:scale-[.98]"
                      onClick={() => onOpenIssue(issue.number)}
                      type="button"
                    >
                      <span className="mt-0.5 shrink-0 text-xs tabular-nums text-current/35">#{issue.number}</span>
                      <span className="min-w-0 text-sm font-medium leading-5 text-current/85 group-hover:text-current">
                        {issue.title}
                      </span>
                    </button>
                  </Table.Cell>
                  <Table.Cell><PageStatus tone={issueTone[issue.state]}>{issue.state}</PageStatus></Table.Cell>
                  <Table.Cell><IssueLabels issue={issue} /></Table.Cell>
                  <Table.Cell><span className="whitespace-nowrap text-xs text-current/40">{issue.updated}</span></Table.Cell>
                  <Table.Cell>
                    <span className="flex max-w-52 items-center gap-1.5 text-xs text-current/40">
                      {issue.pullRequest ? <GitPullRequest className="size-3.5 shrink-0" /> : issue.branch ? <GitBranch className="size-3.5 shrink-0" /> : null}
                      <span className="truncate">{issueDevelopmentLabel(issue)}</span>
                    </span>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
      {issues.length === 0 ? (
        <div className="grid min-h-36 place-items-center border-x border-b border-current/[.08] text-sm text-current/40">
          No issues match these filters
        </div>
      ) : null}
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
  const [developmentFilter, setDevelopmentFilter] = useState<PrototypeIssueDevelopmentFilter>("All");
  const [labelFilter, setLabelFilter] = useState("All");
  const [query, setQuery] = useState("");
  const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
    column: "updated",
    direction: "descending",
  });
  const labels = useMemo(() => Array.from(new Set(prototypeIssues.flatMap((issue) => issue.labels))).sort(), []);
  const visible = useMemo(() => prototypeIssues.filter((issue) => {
    const matchesState = filter === "All" || issue.state === filter;
    const haystack = `${issue.number} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase();
    return matchesState && haystack.includes(query.toLowerCase());
  }), [filter, query]);
  const tableIssues = useMemo(() => filterAndSortPrototypeIssues({
    development: developmentFilter,
    issues: visible,
    label: labelFilter,
    sortDescriptor,
  }), [developmentFilter, labelFilter, sortDescriptor, visible]);
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
      ) : viewMode === "board" && visible.length === 0 ? (
        <div className="grid min-h-40 place-items-center text-sm text-current/40">No matching issues</div>
      ) : viewMode === "board" ? (
        <IssueBoard issues={visible} onOpenIssue={onOpenIssue} />
      ) : (
        <IssueTable
          development={developmentFilter}
          issues={tableIssues}
          label={labelFilter}
          labels={labels}
          onDevelopmentChange={setDevelopmentFilter}
          onLabelChange={setLabelFilter}
          onOpenIssue={onOpenIssue}
          onResetFilters={() => {
            setDevelopmentFilter("All");
            setLabelFilter("All");
          }}
          onSortChange={setSortDescriptor}
          sortDescriptor={sortDescriptor}
        />
      )}
    </PageScaffold>
  );
}
