import { useState } from "react";
import { Bot, CheckCircle2, Plus, Radio, UserRound } from "lucide-react";

import type { PrototypeScenarioKind } from "../../../../src/shared/prototype-canvas";
import { ChatDetailView, type PrototypeChat } from "./chat-detail";
import { ProjectHistoryWorkbench } from "./history-workbench";
import {
  PagePrimaryAction,
  PageScaffold,
  PageSearch,
  PageState,
  PageStatus,
  SectionHeading,
} from "./page-foundation";

const chats: PrototypeChat[] = [
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
  const [conversations, setConversations] = useState(chats);
  const [creating, setCreating] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [selectedChat, setSelectedChat] = useState<PrototypeChat | null>(null);
  const visible = conversations.filter((chat) => `${chat.title} ${chat.meta} ${chat.preview}`.toLowerCase().includes(query.toLowerCase()));
  const unavailable = scenario === "empty" || scenario === "offline";
  if (selectedChat) return <ChatDetailView chat={selectedChat} onBack={() => setSelectedChat(null)} />;
  return (
    <PageScaffold
      action={<PagePrimaryAction icon={<Plus className="size-4" />} onPress={() => setCreating(true)}>New chat</PagePrimaryAction>}
      description="Conversations and active tasks stay together across your workspace."
      projectName={projectName}
      title="Chat"
    >
      <div className="border-b border-current/[.08] py-4">
        <PageSearch onChange={setQuery} placeholder="Search conversations" value={query} />
      </div>
      {unavailable ? <PageState emptyCopy="Start a chat when a project decision needs a shared place." scenario={scenario} /> : (
        <div className="space-y-8 py-6 @5xl:py-8">
          {creating ? (
            <form
              className="flex flex-col gap-3 rounded-2xl bg-current/[.035] p-4 @md:flex-row @md:items-center"
              onSubmit={(event) => {
                event.preventDefault();
                const title = newChatTitle.trim();
                if (!title) return;
                const chat: PrototypeChat = { avatar: title.slice(0, 2).toUpperCase(), meta: "Oli · Codex", preview: "New project conversation", title, unread: 0, updated: "now" };
                setConversations((current) => [chat, ...current]);
                setNewChatTitle("");
                setCreating(false);
                setSelectedChat(chat);
              }}
            >
              <input
                aria-label="Conversation title"
                autoFocus
                className="h-9 min-w-0 flex-1 rounded-xl bg-current/[.045] px-3 text-sm outline-none ring-1 ring-inset ring-current/[.08] placeholder:text-current/30 focus:ring-current/[.16]"
                placeholder="What should this conversation be about?"
                value={newChatTitle}
                onChange={(event) => setNewChatTitle(event.target.value)}
              />
              <div className="flex items-center justify-end gap-2">
                <button className="h-8 rounded-lg px-3 text-xs text-current/45 hover:bg-current/[.05]" onClick={() => setCreating(false)} type="button">Cancel</button>
                <button className="h-8 rounded-lg bg-blue-500 px-3 text-xs font-medium text-white disabled:opacity-40" disabled={!newChatTitle.trim()} type="submit">Start chat</button>
              </div>
            </form>
          ) : null}
          <section>
            <SectionHeading meta={`${visible.length} conversations`}>Conversations</SectionHeading>
            <div className="divide-y divide-current/[.07] border-y border-current/[.08]">
              {visible.map((chat) => (
                <button className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] gap-3 py-4 text-left hover:bg-current/[.02] @md:gap-4" key={chat.title} onClick={() => setSelectedChat(chat)} type="button">
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
          </section>
          <CodexTaskList />
        </div>
      )}
    </PageScaffold>
  );
}

export function ProjectHistoryPage({
  projectName,
  scenario,
}: {
  projectName: string;
  scenario: PrototypeScenarioKind;
}) {
  return <ProjectHistoryWorkbench projectName={projectName} scenario={scenario} />;
}

const codexTasks = [
  { agent: "—", detail: "Building the selected frontend direction", model: "5.6 Sol · High", state: "Working" as const, title: "#437 · Frontend redesign", updated: "now" },
  { agent: "Aurora", detail: "Local checks and release preparation", model: "5.6 Sol · High", state: "Completed" as const, title: "#434 · PR revisions", updated: "4h" },
  { agent: "Calypso", detail: "Preview capacity and trusted controls", model: "5.6 Sol · High", state: "Idle" as const, title: "#426 · Preview hub", updated: "2h" },
  { agent: "Juno", detail: "PR-scoped prototype canvases", model: "5.5 · High", state: "Completed" as const, title: "#356 · Prototype canvases", updated: "Jul 30" },
];

function CodexTaskList() {
  return (
    <section>
      <SectionHeading meta="1 working">Tasks</SectionHeading>
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
    </section>
  );
}
