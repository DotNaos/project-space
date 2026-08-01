import { ArrowRight, Plus, Sparkles } from "lucide-react";

import {
  PagePrimaryAction,
  PageScaffold,
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
