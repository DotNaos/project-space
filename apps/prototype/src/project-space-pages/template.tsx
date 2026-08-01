import { Check, FileCheck2, RefreshCw, TriangleAlert } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  PagePrimaryAction,
  PageScaffold,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const templateGroups = [
  {
    checks: [
      { detail: "Repository identity and default branch", label: "project.yaml", status: "Complete" as const },
      { detail: "Template version is pinned", label: "template.lock", status: "Complete" as const },
      { detail: "Supported local commands are available", label: "Project CLI", status: "Complete" as const },
    ],
    title: "Project contract",
  },
  {
    checks: [
      { detail: "Web application follows the expected layout", label: "Application", status: "Complete" as const },
      { detail: "Release entry exists for the current pull request", label: "Release documentation", status: "Attention" as const },
      { detail: "Production rollback contract is configured", label: "Deployment", status: "Complete" as const },
    ],
    title: "Fullstack template",
  },
];

export function ProjectTemplatePage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<RefreshCw className="size-4" />}>Run checks</PagePrimaryAction>}
      description="Project conventions are visible as a short contract, not a wall of configuration."
      projectName={projectName}
      title="Template"
    >
      {unavailable ? <PageState emptyCopy="Initialize the project template to begin tracking adherence." scenario={scenario} /> : (
        <div className="py-6 @5xl:py-8">
          <div className="flex flex-col gap-5 border-b border-current/[.08] pb-6 @md:flex-row @md:items-end @md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <FileCheck2 className="size-4 text-emerald-400" />
                <span className="text-sm font-medium">Template adherence</span>
              </div>
              <p className="mt-2 text-xs text-current/40">12 of 13 checks match the fullstack project contract.</p>
            </div>
            <div className="w-full @md:w-64">
              <div className="flex items-center justify-between text-[11px] text-current/35"><span>Progress</span><span>92%</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-current/[.07]"><div className="h-full w-[92%] rounded-full bg-emerald-400" /></div>
            </div>
          </div>

          <div className="space-y-8 pt-7">
            {templateGroups.map((group) => (
              <section key={group.title}>
                <SectionHeading>{group.title}</SectionHeading>
                <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
                  {group.checks.map((check) => (
                    <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4" key={check.label} type="button">
                      <span className={`grid size-8 place-items-center rounded-full ${check.status === "Complete" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}`}>
                        {check.status === "Complete" ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{check.label}</span>
                        <span className="mt-1 block truncate text-xs text-current/40">{check.detail}</span>
                      </span>
                      <PageStatus tone={check.status === "Complete" ? "success" : "warning"}>{check.status}</PageStatus>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </PageScaffold>
  );
}
