import { useEffect, useMemo, useState } from "react";
import { Button, TextArea } from "@heroui/react";
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  CircleDot,
  GitPullRequest,
  Monitor,
  Send,
} from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import {
  initialProjectChatEntries,
  projectChatMachineCounts,
  type ProjectChatEntry,
  type ProjectChatMachine,
} from "./project-chat-model";
import { type MockTask } from "./task-model";
import { PageScaffold, PageState } from "./page-foundation";

const messagesStorageKey = "project-space-prototype-project-chat-messages";
const machineStorageKey = "project-space-prototype-project-chat-machine";

function stateVisual(entry: ProjectChatEntry) {
  if (entry.state === "needs-you") return { icon: CircleAlert, label: "Needs you", tone: "text-red-300" };
  if (entry.state === "done") return { icon: CheckCircle2, label: "Done", tone: "text-emerald-300" };
  return { icon: CircleDot, label: "Working", tone: "text-blue-300" };
}

function AgentEvent({ entry, onOpenTask }: { entry: ProjectChatEntry; onOpenTask(number: number): void }) {
  const [expanded, setExpanded] = useState(false);
  const visual = stateVisual(entry);
  const StateIcon = visual.icon;

  return (
    <article className="border-b border-current/[.07] py-3.5">
      <button
        aria-expanded={expanded}
        className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-left transition-[background-color,scale] active:scale-[.99]"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span className="mt-0.5 grid size-7 place-items-center rounded-full bg-current/[.055] text-current/40">
          <Bot className="size-3.5" />
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <strong className="font-medium text-current/80">{entry.actor}</strong>
            <span className="inline-flex items-center gap-1 text-current/35"><Monitor className="size-3" /> {entry.machine}</span>
            <span className={`inline-flex items-center gap-1 ${visual.tone}`}><StateIcon className="size-3" /> {visual.label}</span>
          </span>
          <span className="mt-1.5 block text-sm leading-5 text-current/55">{entry.body}</span>
          <span className="mt-1.5 flex items-center gap-2 text-[11px] text-current/30">
            <span>Task #{entry.taskNumber}</span>
            <span aria-hidden="true">·</span>
            <span>Issue #{entry.issueNumber}</span>
          </span>
        </span>
        <span className="pt-0.5 text-[11px] text-current/25">{entry.time}</span>
      </button>
      {expanded && entry.taskNumber ? (
        <div className="ml-10 mt-3 flex items-center justify-between gap-3 border-l border-current/[.1] pl-3">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-current/35">
            <GitPullRequest className="size-3.5 shrink-0" /> Development context stays attached to this Task.
          </span>
          <Button size="sm" variant="ghost" onPress={() => onOpenTask(entry.taskNumber!)}>
            Open Task <ArrowRight className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ConversationMessage({ entry, managerMachine }: { entry: ProjectChatEntry; managerMachine: ProjectChatMachine }) {
  const manager = entry.kind === "manager";
  return (
    <article className={`flex gap-3 py-4 ${entry.kind === "user" ? "justify-end" : "justify-start"}`}>
      {manager ? (
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-300">
          <Bot className="size-4" />
        </span>
      ) : null}
      <div className={`max-w-[86%] @md:max-w-[72%] ${entry.kind === "user" ? "rounded-2xl bg-current/[.07] px-4 py-3" : "pt-1"}`}>
        <div className="flex items-center gap-2 text-xs">
          <strong className="font-medium text-current/75">{entry.actor}</strong>
          {manager ? <span className="text-current/30">{managerMachine} · main</span> : null}
          <span className="text-[10px] text-current/25">{entry.time}</span>
        </div>
        <p className="mt-1.5 text-sm leading-6 text-current/65">{entry.body}</p>
      </div>
    </article>
  );
}

export function ProjectChatsPage({
  onTaskOpen,
  projectName,
  scenario,
  tasks,
}: {
  onTaskOpen(number: number): void;
  projectName: string;
  scenario: PrototypeScenarioKind;
  tasks: MockTask[];
}) {
  const defaults = useMemo(() => initialProjectChatEntries(tasks), [tasks]);
  const [draft, setDraft] = useState("");
  const [customEntries, setCustomEntries] = useState<ProjectChatEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = window.sessionStorage.getItem(messagesStorageKey);
      return saved ? JSON.parse(saved) as ProjectChatEntry[] : [];
    } catch {
      return [];
    }
  });
  const [machine, setMachine] = useState<ProjectChatMachine>(() => {
    if (typeof window === "undefined") return "Local";
    try {
      const saved = window.sessionStorage.getItem(machineStorageKey);
      return saved === "os-pc" || saved === "os-yoga-unix" ? saved : "Local";
    } catch {
      return "Local";
    }
  });
  const entries = useMemo(() => [...defaults, ...customEntries], [customEntries, defaults]);
  const unavailable = scenario === "empty" || scenario === "offline";
  const machines = useMemo(() => projectChatMachineCounts(entries), [entries]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(messagesStorageKey, JSON.stringify(customEntries));
    } catch {
      // The prototype remains usable when browser storage is unavailable.
    }
  }, [customEntries]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(machineStorageKey, machine);
    } catch {
      // The prototype remains usable when browser storage is unavailable.
    }
  }, [machine]);

  function sendMessage() {
    const body = draft.trim();
    if (!body) return;
    setCustomEntries((current) => [...current, {
      actor: "Oli",
      body,
      id: `user-${Date.now()}`,
      kind: "user",
      time: "now",
    }]);
    setDraft("");
  }

  return (
    <PageScaffold
      contentClassName="flex flex-col overflow-hidden"
      description=""
      projectName={projectName}
      title="Chat"
    >
      <div className="flex shrink-0 flex-col gap-3 border-b border-current/[.08] py-3 @md:flex-row @md:items-center">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-300">
            <Bot className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">Project manager</p>
            <p className="truncate text-[11px] text-current/35">Persistent project thread · main worktree</p>
          </div>
        </div>
        <label className="relative ml-auto flex h-8 min-w-0 items-center rounded-lg bg-current/[.045] pl-2.5 pr-8 text-xs text-current/55">
          <Monitor className="mr-1.5 size-3.5 shrink-0 text-current/35" />
          <select
            aria-label="Select project manager machine"
            className="min-w-0 appearance-none bg-transparent outline-none"
            value={machine}
            onChange={(event) => setMachine(event.target.value as ProjectChatMachine)}
          >
            <option value="Local">Local · main</option>
            <option value="os-pc">os-pc · main</option>
            <option value="os-yoga-unix">os-yoga-unix · main</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-current/30" />
        </label>
      </div>

      {unavailable ? (
        <PageState emptyCopy="The project manager thread starts here." scenario={scenario} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-4 overflow-x-auto border-b border-current/[.07] py-2.5 text-[11px] [scrollbar-width:none]">
            <span className="shrink-0 text-current/30">Agent runs</span>
            {machines.map(({ count, machine: item }) => (
              <span className="inline-flex shrink-0 items-center gap-1.5 text-current/45" key={item}>
                <span className="size-1.5 rounded-full bg-current/30" /> {item} <span className="tabular-nums text-current/25">{count}</span>
              </span>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto w-full max-w-3xl py-2">
              {entries.map((entry) => entry.kind === "agent" ? (
                <AgentEvent entry={entry} key={entry.id} onOpenTask={onTaskOpen} />
              ) : (
                <ConversationMessage entry={entry} key={entry.id} managerMachine={machine} />
              ))}
            </div>
          </div>

          <form
            className="mx-auto w-full max-w-3xl shrink-0 border-t border-current/[.08] py-3"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <div className="flex items-end gap-2 rounded-2xl bg-current/[.05] p-2 ring-1 ring-inset ring-current/[.08] focus-within:ring-current/[.16]">
              <TextArea
                aria-label="Message the project"
                className="min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1 text-sm shadow-none"
                placeholder="Message the project"
                rows={1}
                value={draft}
                variant="secondary"
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button isIconOnly aria-label="Send project message" isDisabled={!draft.trim()} size="sm" type="submit" variant="primary">
                <Send className="size-4" />
              </Button>
            </div>
          </form>
        </>
      )}
    </PageScaffold>
  );
}
