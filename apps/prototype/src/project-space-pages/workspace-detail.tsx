import { useState } from "react";
import { Button } from "@heroui/react";
import {
  ArrowLeft,
  Braces,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Play,
  RefreshCw,
  Square,
  TerminalSquare,
} from "lucide-react";

import { PageFilter, PageStatus, SectionHeading } from "./page-foundation";

export interface PrototypeWorkspace {
  branch: string;
  health: "Clean" | "Modified" | "Read only";
  machine: string;
  name: string;
  updated: string;
}

const files = [
  { depth: 0, kind: "folder", name: "apps" },
  { depth: 1, kind: "folder", name: "prototype" },
  { depth: 2, kind: "file", name: "project-space-home.tsx" },
  { depth: 2, kind: "file", name: "project-space-pages.tsx" },
  { depth: 0, kind: "folder", name: "src" },
  { depth: 1, kind: "file", name: "main.tsx" },
  { depth: 0, kind: "file", name: "package.json" },
];

const changedFiles = [
  { additions: 96, deletions: 14, name: "issue-detail.tsx", state: "M" },
  { additions: 214, deletions: 0, name: "issue-workflow.tsx", state: "A" },
  { additions: 93, deletions: 0, name: "issue-comments.tsx", state: "A" },
];

export function WorkspaceDetailView({ onBack, workspace }: { onBack(): void; workspace: PrototypeWorkspace }) {
  const [view, setView] = useState<"Changes" | "Files" | "Runtime">("Files");
  const [serverRunning, setServerRunning] = useState(true);
  const [selectedFile, setSelectedFile] = useState("project-space-home.tsx");

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-6 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="shrink-0 border-b border-current/[.08] pb-4">
        <div className="flex items-center justify-between gap-3">
          <Button size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}><ArrowLeft className="size-4" /> Workspaces</Button>
          <div className="flex items-center gap-1">
            <Button size="sm" style={{ color: "inherit" }} variant="ghost"><RefreshCw className="size-3.5" /> Refresh</Button>
            <Button size="sm" variant="secondary"><TerminalSquare className="size-3.5" /> Open</Button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <PageStatus tone={workspace.health === "Clean" ? "success" : workspace.health === "Modified" ? "info" : "muted"}>{workspace.health}</PageStatus>
          <span className="text-xs text-current/35">{workspace.machine}</span>
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-.03em]">{workspace.name}</h1>
        <p className="mt-2 flex items-center gap-1.5 truncate text-xs text-current/35"><GitBranch className="size-3.5" /> {workspace.branch}</p>
      </header>

      <div className="flex shrink-0 items-center gap-1 border-b border-current/[.08] py-3">
        {(["Files", "Changes", "Runtime"] as const).map((item) => (
          <PageFilter active={view === item} key={item} onPress={() => setView(item)}>{item}</PageFilter>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none]">
        {view === "Files" ? (
          <div className="grid min-h-full @3xl:grid-cols-[17rem_minmax(0,1fr)]">
            <aside className="border-b border-current/[.08] py-4 @3xl:border-b-0 @3xl:border-r @3xl:pr-4">
              <SectionHeading>Explorer</SectionHeading>
              <div className="space-y-0.5">
                {files.map((entry) => {
                  const Icon = entry.kind === "folder" ? Folder : entry.name.endsWith(".tsx") ? FileCode2 : File;
                  return (
                    <button
                      className={`flex h-8 w-full items-center gap-2 rounded-lg pe-2 text-left text-xs transition ${selectedFile === entry.name ? "bg-current/[.07] text-current/85" : "text-current/45 hover:bg-current/[.035] hover:text-current/70"}`}
                      key={`${entry.depth}-${entry.name}`}
                      style={{ paddingInlineStart: `${8 + entry.depth * 16}px` }}
                      type="button"
                      onClick={() => entry.kind === "file" && setSelectedFile(entry.name)}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  );
                })}
              </div>
            </aside>
            <main className="min-w-0 py-4 @3xl:pl-6">
              <div className="flex items-center justify-between gap-3 pb-3">
                <span className="flex items-center gap-2 text-xs font-medium"><Braces className="size-3.5 text-current/40" /> {selectedFile}</span>
                <span className="text-[11px] text-current/30">TypeScript React</span>
              </div>
              <pre className="min-h-72 overflow-x-auto rounded-xl bg-black/20 p-4 font-mono text-[11px] leading-6 text-current/55 ring-1 ring-inset ring-current/[.06]"><code>{`export function ProjectSpaceHome() {
  const [page, setPage] = useState("overview");

  return (
    <ProjectShell>
      <ProjectSidebar activePage={page} />
      <ProjectFeaturePage page={page} />
    </ProjectShell>
  );
}`}</code></pre>
            </main>
          </div>
        ) : null}

        {view === "Changes" ? (
          <div className="grid gap-8 py-6 @3xl:grid-cols-[18rem_minmax(0,1fr)]">
            <aside>
              <SectionHeading meta="3 files">Working tree</SectionHeading>
              <div className="border-y border-current/[.08]">
                {changedFiles.map((file) => (
                  <button className="flex w-full items-center gap-2 border-b border-current/[.06] py-3 text-left last:border-0" key={file.name} type="button">
                    <span className="grid size-6 place-items-center rounded-md bg-current/[.05] text-[10px] font-semibold text-current/50">{file.state}</span>
                    <span className="min-w-0 flex-1 truncate text-xs">{file.name}</span>
                    <span className="text-[10px] tabular-nums text-current/35"><span className="text-emerald-400">+{file.additions}</span> <span className="text-red-400">-{file.deletions}</span></span>
                  </button>
                ))}
              </div>
              <Button className="mt-4 w-full" variant="secondary"><GitCommitHorizontal className="size-4" /> Commit changes</Button>
            </aside>
            <main className="min-w-0">
              <SectionHeading>Diff preview</SectionHeading>
              <div className="overflow-x-auto rounded-xl bg-black/20 p-4 font-mono text-[11px] leading-6 ring-1 ring-inset ring-current/[.06]">
                <p className="text-current/35">@@ Issue detail workflow</p>
                <p className="bg-emerald-500/10 text-emerald-300">+ &lt;IssueComments /&gt;</p>
                <p className="bg-emerald-500/10 text-emerald-300">+ &lt;IssueWorkflow issue={'{issue}'} /&gt;</p>
                <p className="bg-red-500/10 text-red-300">- &lt;StaticIssueSummary /&gt;</p>
              </div>
            </main>
          </div>
        ) : null}

        {view === "Runtime" ? (
          <div className="grid gap-10 py-6 @3xl:grid-cols-[minmax(0,1fr)_18rem]">
            <main>
              <SectionHeading>Development server</SectionHeading>
              <div className="flex flex-col gap-4 border-y border-current/[.08] py-5 @md:flex-row @md:items-center">
                <span className={`grid size-10 place-items-center rounded-full ${serverRunning ? "bg-emerald-500/10 text-emerald-400" : "bg-current/[.05] text-current/35"}`}><Globe className="size-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Project prototype</span>
                  <span className="mt-1 block truncate text-xs text-current/40">issue-437-redesign-the-project-space-frontend.project-space.localhost</span>
                </span>
                <Button variant={serverRunning ? "outline" : "primary"} onPress={() => setServerRunning((value) => !value)}>
                  {serverRunning ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                  {serverRunning ? "Stop" : "Start"}
                </Button>
              </div>
              <div className="mt-8">
                <SectionHeading>Recent output</SectionHeading>
                <div className="rounded-xl bg-black/25 p-4 font-mono text-[11px] leading-6 text-current/50 ring-1 ring-inset ring-current/[.06]">
                  <p><span className="text-emerald-400">ready</span> Portless route active</p>
                  <p>Local: http://project-space.localhost:1355</p>
                  <p>HMR connected · waiting for changes</p>
                </div>
              </div>
            </main>
            <aside>
              <SectionHeading>Workspace state</SectionHeading>
              <div className="border-y border-current/[.08] py-2">
                {[["Machine", workspace.machine], ["Branch", workspace.branch], ["Changes", "3 files"], ["Dev server", serverRunning ? "Running" : "Stopped"]].map(([label, value]) => (
                  <div className="flex items-center justify-between gap-3 py-2.5" key={label}><span className="text-xs text-current/35">{label}</span><span className="max-w-40 truncate text-xs font-medium text-current/65">{value}</span></div>
                ))}
              </div>
              <a className="mt-4 flex items-center justify-center gap-1.5 rounded-xl bg-current/[.05] px-3 py-2.5 text-xs text-current/55 hover:text-current" href={`https://github.com/DotNaos/project-space/tree/${workspace.branch}`} rel="noreferrer" target="_blank">Open branch <ExternalLink className="size-3.5" /></a>
            </aside>
          </div>
        ) : null}
      </div>
    </section>
  );
}
