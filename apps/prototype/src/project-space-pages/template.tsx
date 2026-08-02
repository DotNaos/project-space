import { useState } from "react";
import { Button } from "@heroui/react";
import {
  Check,
  Clipboard,
  FileCheck2,
  FileJson,
  FolderGit2,
  Monitor,
  RefreshCw,
  TerminalSquare,
  TriangleAlert,
  Wrench,
} from "lucide-react";

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
      { detail: "Release entry is missing for the current pull request", label: "Release documentation", status: "Attention" as const },
      { detail: "Production rollback contract is configured", label: "Deployment", status: "Complete" as const },
    ],
    title: "Fullstack template",
  },
];

const manifest = `project: project-space
template: fullstack@3
runtime: bun
commands:
  dev: bun run dev
  check: bun run check
  test: bun test`;

export function ProjectTemplatePage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  const [checksRunning, setChecksRunning] = useState(false);
  const [copied, setCopied] = useState(false);

  function runChecks() {
    setChecksRunning(true);
    window.setTimeout(() => setChecksRunning(false), 700);
  }

  function copySetupCommand() {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<RefreshCw className={`size-4 ${checksRunning ? "animate-spin" : ""}`} />} onPress={runChecks}>{checksRunning ? "Checking" : "Run checks"}</PagePrimaryAction>}
      description="Project conventions are visible as a short contract, not a wall of configuration."
      projectName={projectName}
      title="Template"
    >
      {unavailable ? <PageState emptyCopy="Initialize the project template to begin tracking adherence." scenario={scenario} /> : (
        <div className="grid gap-10 py-6 @3xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,.75fr)] @3xl:gap-12 @5xl:py-8">
          <main className="min-w-0 space-y-9">
            <section>
              <SectionHeading>Setup target</SectionHeading>
              <div className="grid border-y border-current/[.08] @md:grid-cols-3">
                {[
                  { icon: Monitor, label: "Machine", value: "Local workspace" },
                  { icon: FolderGit2, label: "Workspace", value: "issue-437-redesign…" },
                  { icon: FileCheck2, label: "Template", value: "Fullstack v3" },
                ].map(({ icon: Icon, label, value }) => (
                  <button className="flex items-center gap-3 border-b border-current/[.06] py-3.5 text-left last:border-0 @md:border-b-0 @md:border-r @md:px-4 @md:first:pl-0 @md:last:border-r-0" key={label} type="button">
                    <Icon className="size-4 shrink-0 text-current/30" />
                    <span className="min-w-0">
                      <span className="block text-[11px] text-current/35">{label}</span>
                      <span className="mt-0.5 block truncate text-xs font-medium text-current/65">{value}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
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
                        <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-4 text-left transition hover:bg-current/[.02] @md:gap-4" key={check.label} type="button">
                          <span className={`grid size-8 place-items-center rounded-full ${check.status === "Complete" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                            {check.status === "Complete" ? <Check className="size-4" /> : <TriangleAlert className="size-4" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{check.label}</span>
                            <span className="mt-1 block truncate text-xs text-current/40">{check.detail}</span>
                          </span>
                          <PageStatus tone={check.status === "Complete" ? "success" : "danger"}>{check.status}</PageStatus>
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>
          </main>

          <aside className="min-w-0 space-y-9">
            <section>
              <SectionHeading>Diagnostic</SectionHeading>
              <div className="border-y border-current/[.08] py-4">
                <div className="flex items-start gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-red-500/10 text-red-400"><Wrench className="size-3.5" /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">Release entry required</span>
                    <span className="mt-1.5 block text-xs leading-5 text-current/40">Create the numbered release entry before the pull request is marked ready.</span>
                  </span>
                </div>
                <Button className="mt-4 w-full" variant="secondary"><Wrench className="size-3.5" /> Prepare release entry</Button>
              </div>
            </section>

            <section>
              <SectionHeading>Project CLI</SectionHeading>
              <div className="rounded-xl bg-black/20 p-3 ring-1 ring-inset ring-current/[.06]">
                <div className="flex items-center gap-2">
                  <TerminalSquare className="size-3.5 text-current/35" />
                  <code className="min-w-0 flex-1 truncate text-[11px] text-current/55">project template apply --check</code>
                  <Button isIconOnly aria-label="Copy setup command" size="sm" style={{ color: "inherit" }} variant="ghost" onPress={copySetupCommand}><Clipboard className="size-3.5" /></Button>
                </div>
              </div>
              {copied ? <p className="mt-2 text-[11px] text-emerald-400">Command copied</p> : null}
            </section>

            <section>
              <SectionHeading>Manifest</SectionHeading>
              <div className="rounded-xl bg-black/20 p-4 ring-1 ring-inset ring-current/[.06]">
                <div className="mb-3 flex items-center gap-2 text-xs font-medium text-current/60"><FileJson className="size-3.5" /> project.yaml</div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-5 text-current/40"><code>{manifest}</code></pre>
              </div>
            </section>
          </aside>
        </div>
      )}
    </PageScaffold>
  );
}
