import {
  Boxes,
  Braces,
  Check,
  FileCode2,
  Library,
  Route,
  Settings2,
  ShieldCheck,
} from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { PageScaffold, PageState, PageStatus, SectionHeading } from "./page-foundation";
import {
  projectTemplateGroups,
  type ProjectTemplateGroupId,
} from "./template-contract";

const groupIcons: Record<ProjectTemplateGroupId, typeof Boxes> = {
  Configuration: Settings2,
  Libraries: Library,
  Modules: Boxes,
  Pipelines: Route,
};

const groupCopy: Record<ProjectTemplateGroupId, string> = {
  Configuration: "Required runtime and operational behavior",
  Libraries: "Shared foundations expected in the project",
  Modules: "Product surfaces the repository must provide",
  Pipelines: "Delivery gates every change must pass",
};

export function ProjectTemplatePage({
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";

  return (
    <PageScaffold
      action={<PageStatus tone="info">Project Template · v1</PageStatus>}
      description="The desired contract inherited by Project Space repositories."
      projectName="Global"
      title="Project Template"
    >
      {unavailable ? <PageState emptyCopy="Define the Project Template before validating repositories against it." scenario={scenario} /> : (
        <div className="py-6 @5xl:py-8">
          <section className="border-b border-current/[.08] pb-7">
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blue-500/10 text-blue-300">
                <FileCode2 className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Default contract for every project</h2>
                <p className="mt-1.5 max-w-2xl text-xs leading-5 text-current/40">
                  Repositories inherit these product modules, libraries, configurations, and delivery gates. Each project checks a selected branch against this contract inside Repository.
                </p>
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-current/[.07] ring-1 ring-current/[.07] @md:grid-cols-4">
              {projectTemplateGroups.map((group) => {
                const Icon = groupIcons[group.id];
                return (
                  <div className="bg-[var(--prototype-main-surface)] px-4 py-3" key={group.id}>
                    <span className="flex items-center gap-1.5 text-[11px] text-current/35"><Icon className="size-3.5" /> {group.id === "Pipelines" ? "Required pipelines" : group.id}</span>
                    <span className="mt-1 block text-lg font-semibold tabular-nums">{group.requirements.length}</span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="grid gap-x-12 gap-y-10 pt-8 @3xl:grid-cols-2">
            {projectTemplateGroups.map((group) => {
              const Icon = groupIcons[group.id];
              return (
                <section key={group.id}>
                  <SectionHeading meta={`${group.requirements.length} required`}>
                    <span className="inline-flex items-center gap-1.5"><Icon className="size-3.5" /> {group.id === "Pipelines" ? "Required pipelines" : group.id}</span>
                  </SectionHeading>
                  <p className="mb-3 text-[11px] text-current/30">{groupCopy[group.id]}</p>
                  <div className="divide-y divide-current/[.065] border-y border-current/[.08]">
                    {group.requirements.map((requirement) => (
                      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 py-3.5" key={requirement.id}>
                        <span className="grid size-7 place-items-center rounded-full bg-current/[.045] text-current/35">
                          {group.id === "Configuration" ? <Braces className="size-3.5" /> : group.id === "Pipelines" ? <ShieldCheck className="size-3.5" /> : <Check className="size-3.5" />}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-medium text-current/75">{requirement.label}</span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-current/35">{requirement.detail}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </PageScaffold>
  );
}
