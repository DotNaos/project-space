import { Button } from "@heroui/react";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  MessageCircle,
  MonitorPlay,
} from "lucide-react";

import { PageStatus, SectionHeading } from "./page-foundation";
import {
  prototypePullRequestLabel,
  type PrototypeIssue,
  type PrototypeIssueState,
} from "./issue-fixtures";

const detailTone: Record<PrototypeIssueState, "info" | "muted" | "success"> = {
  Done: "success",
  "In progress": "info",
  Open: "muted",
};

function DevelopmentRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof GitBranch;
  label: string;
  value?: string;
}) {
  return (
    <button
      className="grid w-full grid-cols-[auto_minmax(0,1fr)] gap-3 border-b border-current/[.06] py-3.5 text-left transition-[background-color,scale] last:border-0 hover:bg-current/[.02] active:scale-[.99]"
      type="button"
    >
      <span className="grid size-8 place-items-center rounded-full bg-current/[.05] text-current/45">
        <Icon className="size-4" strokeWidth={1.7} />
      </span>
      <span className="min-w-0">
        <span className="block text-[11px] text-current/35">{label}</span>
        <span className={`mt-1 block truncate text-sm ${value ? "font-medium" : "text-current/30"}`}>
          {value ?? "Not connected yet"}
        </span>
      </span>
    </button>
  );
}

export function ProjectIssueDetailPage({
  issue,
  onBack,
  projectName,
}: {
  issue: PrototypeIssue;
  onBack(): void;
  projectName: string;
}) {
  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col px-5 pb-6 pt-3 @md:px-8 @md:pb-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <div className="shrink-0 border-b border-current/[.08] pb-5">
        <div className="flex items-center justify-between gap-4">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}>
            <ArrowLeft className="size-4" />
            Issues
          </Button>
          <Button size="sm" style={{ color: "inherit" }} variant="ghost">
            <span className="hidden @md:inline">Open on GitHub</span>
            <ExternalLink className="size-3.5" />
          </Button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PageStatus tone={detailTone[issue.state]}>{issue.state}</PageStatus>
          {issue.labels.map((label) => (
            <span className="rounded-full bg-current/[.05] px-2.5 py-1 text-[10px] text-current/45" key={label}>{label}</span>
          ))}
        </div>
        <h1 className="mt-3 max-w-4xl text-2xl font-semibold leading-tight tracking-[-.03em] @md:text-[30px]">
          <span className="mr-2 font-medium text-current/30">#{issue.number}</span>
          {issue.title}
        </h1>
        <p className="mt-2 text-xs text-current/35">{projectName} · opened by {issue.author} · updated {issue.updated}</p>
      </div>

      <div className="grid min-h-0 flex-1 gap-8 overflow-y-auto py-6 [scrollbar-width:none] @3xl:grid-cols-[minmax(0,1.45fr)_minmax(17rem,.55fr)] @3xl:gap-12 @5xl:py-8">
        <div className="min-w-0">
          <section>
            <SectionHeading>Description</SectionHeading>
            <div className="border-y border-current/[.08] py-5">
              <p className="max-w-3xl text-sm leading-6 text-current/65">{issue.body}</p>
              {issue.number === 437 ? (
                <ul className="mt-5 space-y-2 text-sm leading-5 text-current/50">
                  <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> Project context stays visible while moving through work.</li>
                  <li className="flex gap-2"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" /> Issues support both board and list workflows.</li>
                  <li className="flex gap-2"><CircleDot className="mt-0.5 size-4 shrink-0 text-blue-400" /> Detail and delivery views remain in active design iteration.</li>
                </ul>
              ) : null}
            </div>
          </section>

          <section className="mt-8">
            <SectionHeading meta="3 events">Activity</SectionHeading>
            <div className="border-y border-current/[.08]">
              {[
                { icon: MessageCircle, meta: "now", text: "Requested the complete issue workflow in the new UI." },
                { icon: GitBranch, meta: "12 min", text: issue.branch ? `Connected branch ${issue.branch}.` : "Issue added to the project workflow." },
                { icon: Bot, meta: "today", text: issue.codexTask ? `Codex task ${issue.codexTask} is attached.` : "Ready for the next project task." },
              ].map(({ icon: Icon, meta, text }) => (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 border-b border-current/[.06] py-3.5 last:border-0" key={text}>
                  <span className="grid size-7 place-items-center rounded-full bg-current/[.05] text-current/40"><Icon className="size-3.5" /></span>
                  <span className="text-sm leading-5 text-current/55">{text}</span>
                  <span className="text-[11px] text-current/25">{meta}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="min-w-0">
          <SectionHeading>Development</SectionHeading>
          <div className="border-y border-current/[.08]">
            <DevelopmentRow icon={GitBranch} label="Branch" value={issue.branch} />
            <DevelopmentRow
              icon={GitPullRequest}
              label="Pull request"
              value={issue.pullRequest ? prototypePullRequestLabel(issue.pullRequest) : undefined}
            />
            <DevelopmentRow icon={Bot} label="Codex task" value={issue.codexTask} />
            <DevelopmentRow icon={MonitorPlay} label="Preview" value={issue.preview} />
          </div>

          <div className="mt-8">
            <SectionHeading>Delivery state</SectionHeading>
            <dl className="border-y border-current/[.08]">
              {[
                ["Local checks", issue.state === "Done" ? "Passed" : "In progress"],
                ["Review", issue.pullRequest ? "Available" : "Not requested"],
                ["Production", issue.state === "Done" ? "Delivered" : "Not deployed"],
              ].map(([label, value]) => (
                <div className="flex items-center justify-between gap-3 border-b border-current/[.06] py-3 last:border-0" key={label}>
                  <dt className="text-xs text-current/40">{label}</dt>
                  <dd className="text-xs font-medium text-current/65">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </aside>
      </div>
    </section>
  );
}
