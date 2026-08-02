import { useState } from "react";
import { Button } from "@heroui/react";
import { ExternalLink, FileDiff, GitBranch, GitCommitHorizontal, GitGraph, RotateCcw } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { PageFilter, PageScaffold, PageState, PageStatus, SectionHeading } from "./page-foundation";

const commits = [
  { author: "OS", branch: "issue-437", message: "Restore full issue workflow", sha: "0248d9d", state: "Working", time: "now" },
  { author: "OS", branch: "issue-437", message: "Build responsive project pages", sha: "72c0f48", state: "Working", time: "42 min" },
  { author: "GH", branch: "main", message: "Merge pull request #435", sha: "dc6bd8d", state: "Main", time: "4h" },
  { author: "AU", branch: "issue-434", message: "Make PR revisions green on first push", sha: "419a88b", state: "Merged", time: "6h" },
  { author: "JU", branch: "issue-419", message: "Improve CI/CD reliability and speed", sha: "d07b6ec", state: "Merged", time: "yesterday" },
];

export function ProjectHistoryWorkbench({ projectName, scenario }: { projectName: string; scenario: PrototypeScenarioKind }) {
  const [mode, setMode] = useState<"Changes" | "Graph">("Graph");
  const [selectedSha, setSelectedSha] = useState(commits[0].sha);
  const selected = commits.find((commit) => commit.sha === selectedSha) ?? commits[0];
  const unavailable = scenario === "empty" || scenario === "offline";

  return (
    <PageScaffold description="Repository history, branch position, and changed files in one workbench." projectName={projectName} title="History">
      <div className="flex items-center gap-1 border-b border-current/[.08] py-4">
        {(["Graph", "Changes"] as const).map((item) => <PageFilter active={mode === item} key={item} onPress={() => setMode(item)}>{item}</PageFilter>)}
        <Button className="ml-auto" size="sm" style={{ color: "inherit" }} variant="ghost"><RotateCcw className="size-3.5" /> Refresh</Button>
      </div>
      {unavailable ? <PageState emptyCopy="Repository changes will appear after the first commit." scenario={scenario} /> : (
        <div className="grid min-h-[34rem] @3xl:grid-cols-[minmax(19rem,.75fr)_minmax(0,1.25fr)]">
          <aside className="border-b border-current/[.08] py-5 @3xl:border-b-0 @3xl:border-r @3xl:pr-5">
            <SectionHeading meta="Latest first">Commits</SectionHeading>
            <div>
              {commits.map((commit, index) => (
                <button className={`relative grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] gap-3 rounded-xl px-2 py-3 text-left transition ${selectedSha === commit.sha ? "bg-current/[.06]" : "hover:bg-current/[.025]"}`} key={commit.sha} onClick={() => setSelectedSha(commit.sha)} type="button">
                  {index < commits.length - 1 ? <span aria-hidden className="absolute bottom-0 left-[1.46rem] top-8 w-px bg-current/[.1]" /> : null}
                  <span className={`relative z-10 mt-0.5 grid size-5 place-items-center rounded-full ring-4 ring-[var(--background)] ${commit.state === "Working" ? "bg-blue-400" : commit.state === "Main" ? "bg-emerald-400" : "bg-violet-400"}`}><span className="size-1.5 rounded-full bg-black/50" /></span>
                  <span className="min-w-0"><span className="block text-xs font-medium leading-5">{commit.message}</span><span className="mt-1 flex items-center gap-1.5 text-[10px] text-current/35"><GitCommitHorizontal className="size-3" /> {commit.sha} · {commit.branch}</span></span>
                  <span className="text-[10px] text-current/25">{commit.time}</span>
                </button>
              ))}
            </div>
          </aside>
          <main className="min-w-0 py-5 @3xl:pl-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><PageStatus tone={selected.state === "Working" ? "info" : selected.state === "Main" ? "success" : "muted"}>{selected.state}</PageStatus><span className="font-mono text-xs text-current/35">{selected.sha}</span></div><h2 className="mt-3 text-lg font-semibold">{selected.message}</h2><p className="mt-1 text-xs text-current/35">{selected.author} · {selected.time}</p></div>
              <Button size="sm" variant="ghost"><ExternalLink className="size-3.5" /> GitHub</Button>
            </div>
            {mode === "Graph" ? (
              <div className="mt-8">
                <SectionHeading>Branch position</SectionHeading>
                <div className="rounded-xl bg-current/[.025] p-5 ring-1 ring-inset ring-current/[.06]">
                  <div className="flex items-center gap-3"><span className="h-px flex-1 bg-violet-400/50" /><span className="grid size-8 place-items-center rounded-full bg-violet-500/15 text-violet-300"><GitGraph className="size-4" /></span><span className="h-px w-16 bg-blue-400/60" /><span className="grid size-8 place-items-center rounded-full bg-blue-500/15 text-blue-300"><GitBranch className="size-4" /></span></div>
                  <div className="mt-4 grid grid-cols-2 gap-4 text-xs"><div><span className="block text-current/35">Base</span><span className="mt-1 block font-medium">main · dc6bd8d</span></div><div><span className="block text-current/35">Head</span><span className="mt-1 block font-medium">issue-437 · {selected.sha}</span></div></div>
                </div>
              </div>
            ) : (
              <div className="mt-8">
                <SectionHeading meta="4 files">Changed files</SectionHeading>
                <div className="border-y border-current/[.08]">
                  {["issue-detail.tsx", "issue-workflow.tsx", "issue-comments.tsx", "prototype-project-space-home.test.tsx"].map((file) => <button className="flex w-full items-center gap-3 border-b border-current/[.06] py-3 text-left last:border-0 hover:bg-current/[.025]" key={file} type="button"><FileDiff className="size-3.5 text-current/35" /><span className="min-w-0 flex-1 truncate text-xs">{file}</span><span className="text-[10px] text-emerald-400">modified</span></button>)}
                </div>
                <pre className="mt-5 overflow-x-auto rounded-xl bg-black/20 p-4 font-mono text-[11px] leading-6 ring-1 ring-inset ring-current/[.06]"><code><span className="text-current/35">@@ project workflow</span>{"\n"}<span className="text-emerald-300">+ preserve every existing feature</span>{"\n"}<span className="text-emerald-300">+ rebuild each project view</span></code></pre>
              </div>
            )}
          </main>
        </div>
      )}
    </PageScaffold>
  );
}
