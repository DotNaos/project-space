import { useState } from "react";
import { Bot, CheckCircle2, GitCommitHorizontal, Plus, Radio, UserRound } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const chats = [
  { avatar: "FE", meta: "Oli · Codex", preview: "The responsive audit is green across all four viewport classes.", title: "Frontend redesign", unread: 2, updated: "now" },
  { avatar: "RL", meta: "Oli · Aurora", preview: "The release identity bundle is ready for the exact PR head.", title: "Release coordination", unread: 0, updated: "4h" },
  { avatar: "PV", meta: "Oli · Juno", preview: "The trusted Preview controls remain outside PR-controlled code.", title: "Prototype review", unread: 0, updated: "yesterday" },
  { avatar: "CI", meta: "Oli · Calypso", preview: "Deterministic lanes now run locally before a revision is pushed.", title: "CI reliability", unread: 0, updated: "Jul 30" },
];

export function ProjectChatsPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const [query, setQuery] = useState("");
  const visible = chats.filter((chat) => `${chat.title} ${chat.meta} ${chat.preview}`.toLowerCase().includes(query.toLowerCase()));
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New chat</PagePrimaryAction>}
      description="Conversations stay in the project context while their work opens in the main view."
      projectName={projectName}
      title="Chats"
    >
      <div className="border-b border-current/[.08] py-4">
        <PageSearch onChange={setQuery} placeholder="Search chats" value={query} />
      </div>
      {unavailable ? <PageState emptyCopy="Start a chat when a project decision needs a shared place." scenario={scenario} /> : (
        <div className="divide-y divide-current/[.07]">
          {visible.map((chat) => (
            <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4" key={chat.title} type="button">
              <span className="grid size-9 place-items-center rounded-full bg-current/[.07] text-[11px] font-semibold text-current/60">{chat.avatar}</span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{chat.title}</span>
                  {chat.unread ? <span className="grid size-5 place-items-center rounded-full bg-blue-500 text-[10px] font-semibold text-white">{chat.unread}</span> : null}
                </span>
                <span className="mt-1 block truncate text-xs text-current/40">{chat.preview}</span>
                <span className="mt-2 block text-[11px] text-current/25">{chat.meta}</span>
              </span>
              <span className="text-xs text-current/30">{chat.updated}</span>
            </button>
          ))}
        </div>
      )}
    </PageScaffold>
  );
}

const history = [
  { author: "OS", branch: "issue-437", message: "Build Project Space redesign prototype", sha: "72c0f48", time: "now" },
  { author: "GH", branch: "main", message: "Merge pull request #435", sha: "dc6bd8d", time: "4h" },
  { author: "AU", branch: "issue-434", message: "Make PR revisions green on first push", sha: "419a88b", time: "6h" },
  { author: "JU", branch: "issue-419", message: "Improve CI/CD reliability and speed", sha: "d07b6ec", time: "yesterday" },
  { author: "OS", branch: "main", message: "Release Project Space v0.4.51", sha: "a69a9f5", time: "yesterday" },
];

export function ProjectHistoryPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      description="A readable sequence of repository changes, with branches kept as context rather than navigation."
      projectName={projectName}
      title="History"
    >
      <div className="py-6 @5xl:py-8">
        <SectionHeading meta="Latest first">Repository activity</SectionHeading>
        {unavailable ? <PageState emptyCopy="Repository changes will appear after the first commit." scenario={scenario} /> : (
          <div className="border-y border-current/[.08]">
            {history.map((item, index) => (
              <button className="group relative grid w-full grid-cols-[2.25rem_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4" key={item.sha} type="button">
                {index < history.length - 1 ? <span aria-hidden className="absolute bottom-0 left-[1.08rem] top-8 w-px bg-current/[.08]" /> : null}
                <span className="relative z-10 grid size-9 place-items-center rounded-full bg-current/[.07] text-[10px] font-semibold text-current/55">{item.author}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{item.message}</span>
                  <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-current/35">
                    <GitCommitHorizontal className="size-3.5 shrink-0" />
                    <span className="font-mono">{item.sha}</span>
                    <span>·</span>
                    <span className="truncate">{item.branch}</span>
                  </span>
                </span>
                <span className="text-xs text-current/30">{item.time}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </PageScaffold>
  );
}

const codexTasks = [
  { agent: "—", detail: "Building the selected frontend direction", model: "5.6 Sol · High", state: "Working" as const, title: "#437 · Frontend redesign", updated: "now" },
  { agent: "Aurora", detail: "Local checks and release preparation", model: "5.6 Sol · High", state: "Completed" as const, title: "#434 · PR revisions", updated: "4h" },
  { agent: "Calypso", detail: "Preview capacity and trusted controls", model: "5.6 Sol · High", state: "Idle" as const, title: "#426 · Preview hub", updated: "2h" },
  { agent: "Juno", detail: "PR-scoped prototype canvases", model: "5.5 · High", state: "Completed" as const, title: "#356 · Prototype canvases", updated: "Jul 30" },
];

export function ProjectCodexPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  const unavailable = scenario === "empty" || scenario === "offline";
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />}>New task</PagePrimaryAction>}
      description="Follow the agents working in this project and continue their exact tasks."
      projectName={projectName}
      title="Codex"
    >
      <div className="py-6 @5xl:py-8">
        <SectionHeading meta="1 working">Project tasks</SectionHeading>
        {unavailable ? <PageState emptyCopy="Start a task from an issue to keep its ownership clear." scenario={scenario} /> : (
          <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
            {codexTasks.map((task) => (
              <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:grid-cols-[auto_minmax(0,1fr)_9rem_auto] @md:gap-4" key={task.title} type="button">
                <span className={`mt-0.5 grid size-9 place-items-center rounded-full ${task.state === "Working" ? "bg-emerald-500/10 text-emerald-400" : "bg-current/[.06] text-current/40"}`}>
                  {task.state === "Working" ? <Radio className="size-4" /> : task.state === "Completed" ? <CheckCircle2 className="size-4" /> : <Bot className="size-4" />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{task.title}</span>
                  <span className="mt-1 block truncate text-xs text-current/40">{task.detail}</span>
                  <span className="mt-2 flex items-center gap-1.5 text-[11px] text-current/25"><UserRound className="size-3" /> {task.agent} · {task.updated}</span>
                </span>
                <span className="hidden text-xs text-current/30 @md:block">{task.model}</span>
                <PageStatus tone={task.state === "Working" ? "success" : task.state === "Completed" ? "muted" : "warning"}>{task.state}</PageStatus>
              </button>
            ))}
          </div>
        )}
      </div>
    </PageScaffold>
  );
}
