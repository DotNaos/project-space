import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { Check, FileCheck2, GitBranch, RefreshCw, TriangleAlert } from "lucide-react";

import { PageStatus, SectionHeading } from "./page-foundation";
import {
  projectTemplateCheckForBranch,
  projectTemplateCheckSummary,
} from "./template-contract";

export function ProjectTemplateCheck({
  branches,
  onBranchChange,
  selectedBranch,
}: {
  branches: string[];
  onBranchChange(branch: string): void;
  selectedBranch: string;
}) {
  const [checking, setChecking] = useState(false);
  const groups = useMemo(() => projectTemplateCheckForBranch(selectedBranch), [selectedBranch]);
  const summary = useMemo(() => projectTemplateCheckSummary(selectedBranch), [selectedBranch]);
  const complete = summary.valid === summary.total;

  function runMockCheck() {
    setChecking(true);
    window.setTimeout(() => setChecking(false), 650);
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-width:none]">
      <header className="flex flex-col gap-4 border-b border-current/[.08] py-5 @md:flex-row @md:items-end @md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileCheck2 className={`size-4 ${complete ? "text-emerald-400" : "text-amber-300"}`} />
            <h2 className="text-sm font-semibold">Project Template check</h2>
            <PageStatus tone={complete ? "success" : "warning"}>{complete ? "Valid" : "Needs attention"}</PageStatus>
          </div>
          <p className="mt-2 text-xs text-current/40">Mock validation · {summary.valid} of {summary.total} requirements match</p>
        </div>
        <div className="flex w-full items-center gap-2 @md:w-auto">
          <label className="relative min-w-0 flex-1 @md:w-72 @md:flex-none">
            <span className="sr-only">Select branch for Template check</span>
            <GitBranch className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-current/30" />
            <select
              aria-label="Select branch for Template check"
              className="h-9 w-full appearance-none rounded-xl bg-current/[.045] pl-9 pr-8 text-xs text-current/70 outline-none ring-1 ring-inset ring-current/[.08] focus:ring-current/[.18]"
              value={selectedBranch}
              onChange={(event) => onBranchChange(event.target.value)}
            >
              {branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
          <Button isIconOnly aria-label="Run mock Template check" isDisabled={checking} size="sm" style={{ color: "inherit" }} variant="secondary" onPress={runMockCheck}>
            <RefreshCw className={`size-3.5 ${checking ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>

      <div className="grid gap-x-10 gap-y-8 pt-6 @3xl:grid-cols-2">
        {groups.map((group) => {
          const attentionCount = group.requirements.filter((requirement) => requirement.state === "Attention").length;
          return (
            <section key={group.id}>
              <SectionHeading meta={attentionCount ? `${attentionCount} needs attention` : "Complete"}>{group.id}</SectionHeading>
              <div className="divide-y divide-current/[.065] border-y border-current/[.08]">
                {group.requirements.map((requirement) => (
                  <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-3" key={requirement.id}>
                    <span className={`grid size-7 place-items-center rounded-full ${requirement.state === "Valid" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-300"}`}>
                      {requirement.state === "Valid" ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-current/75">{requirement.label}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-current/35">{requirement.detail}</span>
                    </span>
                    {requirement.state === "Attention" ? <PageStatus tone="warning">Attention</PageStatus> : null}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
