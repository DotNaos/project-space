import { Button, Modal, TextArea } from "@heroui/react";
import { ArrowUp, Bot, Check, Globe, LoaderCircle, PanelLeft, Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { MockTask, MockTaskAgentThread } from "./task-model";

interface ChatMessage {
  body: string;
  id: string;
  role: "assistant" | "user";
}

export function TaskThreadWorkspace({
  isOpen,
  onOpenChange,
  portalContainer,
  task,
  thread,
}: {
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  portalContainer: HTMLElement | null;
  task: MockTask;
  thread?: MockTaskAgentThread;
}) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => initialMessages(task, thread));

  useEffect(() => {
    setDraft("");
    setMessages(initialMessages(task, thread));
  }, [task, thread]);

  function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setMessages((current) => [...current, { body, id: `local-${current.length}`, role: "user" }]);
    setDraft("");
  }

  const threadName = thread?.name ?? `#${task.number} · Development`;
  const machine = task.workspace?.machine ?? "Development machine";

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop
        UNSTABLE_portalContainer={portalContainer ?? undefined}
        className="z-[96] bg-black/80"
        style={portalContainer ? {
          height: "var(--device-content-height)",
          overflow: "hidden",
          position: "absolute",
          width: "var(--device-content-width)",
        } : undefined}
        variant="blur"
      >
        <Modal.Container className="p-3" placement="center" size="cover">
          <Modal.Dialog className="@container flex max-h-[min(52rem,calc(var(--device-content-height)_-_1.5rem))] min-h-0 flex-col overflow-hidden bg-[#0d0d0d] text-neutral-100 ring-1 ring-inset ring-white/10">
            <Modal.CloseTrigger aria-label="Close thread workspace" />
            <Modal.Header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-white/[.08] px-4 py-3 pr-12">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[.06] text-neutral-400">
                <Bot className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <Modal.Heading className="truncate text-sm font-semibold">{threadName}</Modal.Heading>
                <span className="mt-0.5 block truncate text-[11px] text-neutral-500">{machine} · Dev server live</span>
              </span>
              {thread?.status === "running" ? <LoaderCircle aria-label="Thread running" className="size-4 animate-spin text-emerald-300" /> : <span aria-label="Thread idle" className="size-2 rounded-full bg-neutral-600" />}
            </Modal.Header>
            <Modal.Body className="min-h-0 overflow-hidden p-0">
              <div className="grid h-full min-h-0 grid-rows-[minmax(12rem,.8fr)_minmax(17rem,1.2fr)] @3xl:grid-cols-[minmax(0,1.15fr)_minmax(20rem,.85fr)] @3xl:grid-rows-1">
                <DevServer task={task} />
                <ThreadChat draft={draft} messages={messages} onDraftChange={setDraft} onSubmit={sendMessage} thread={thread} />
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function DevServer({ task }: { task: MockTask }) {
  return (
    <section aria-label="Live development server" className="flex min-h-0 flex-col border-b border-white/[.08] bg-[#080808] @3xl:border-b-0 @3xl:border-r">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[.07] px-3">
        <Globe className="size-3.5 text-neutral-500" />
        <span className="text-xs font-medium text-neutral-300">Development server</span>
        <span className="ml-1 size-1.5 rounded-full bg-emerald-400" aria-label="Live" />
        <span className="ml-auto text-[10px] text-neutral-600">Embedded</span>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[3rem_minmax(0,1fr)] bg-[#0b0b0b]">
        <nav aria-label="Mock project navigation" className="flex flex-col items-center gap-3 border-r border-white/[.06] py-3 text-neutral-600">
          <PanelLeft className="size-4" />
          <Search className="size-4" />
          <Bot className="size-4" />
        </nav>
        <main className="grid min-h-0 place-items-center overflow-hidden px-5 py-4 text-center">
          <div className="max-w-md">
            <span className="mx-auto grid size-9 place-items-center rounded-xl bg-blue-500/10 text-xs font-semibold text-blue-300">PS</span>
            <p className="mt-3 text-[10px] text-neutral-600">Live from {task.workspace?.machine ?? "workspace"}</p>
            <h2 className="mt-1 text-base font-semibold tracking-[-.02em] text-neutral-200 @3xl:text-xl">{task.title}</h2>
            <div className="mx-auto mt-4 flex w-fit items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
              <Check className="size-3" /> Ready for iteration
            </div>
          </div>
        </main>
      </div>
    </section>
  );
}

function ThreadChat({ draft, messages, onDraftChange, onSubmit, thread }: {
  draft: string;
  messages: ChatMessage[];
  onDraftChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  thread?: MockTaskAgentThread;
}) {
  return (
    <section aria-label="Codex thread chat" className="flex min-h-0 flex-col bg-[#111]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-white/[.07] px-3">
        <Bot className="size-3.5 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-300">Codex thread</span>
        <span className="text-[10px] text-neutral-600">{thread?.status === "running" ? "Working" : "Idle"}</span>
      </header>
      <div aria-live="polite" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 [scrollbar-width:none]">
        {messages.map((message) => (
          <article className={`max-w-[88%] rounded-2xl px-3 py-2 text-xs leading-5 ${message.role === "user" ? "ml-auto bg-blue-500 text-white" : "bg-white/[.055] text-neutral-300"}`} key={message.id}>
            {message.body}
          </article>
        ))}
      </div>
      <form className="flex shrink-0 items-end gap-2 border-t border-white/[.07] p-2.5" onSubmit={onSubmit}>
        <TextArea aria-label="Message Codex thread" className="min-h-10 flex-1 resize-none rounded-2xl bg-white/[.055] px-3 py-2 text-xs text-neutral-100" fullWidth placeholder="Message Codex…" rows={2} value={draft} variant="secondary" onChange={(event) => onDraftChange(event.target.value)} />
        <Button aria-label="Send message" className="size-10 min-w-10 rounded-full" isDisabled={!draft.trim()} isIconOnly type="submit">
          <ArrowUp className="size-4" />
        </Button>
      </form>
    </section>
  );
}

function initialMessages(task: MockTask, thread?: MockTaskAgentThread): ChatMessage[] {
  return [
    {
      body: thread?.status === "running"
        ? "I’m working on the authenticated Preview flow. The development server is live beside this thread."
        : "This thread is idle. Send a message to continue from its current workspace.",
      id: `${thread?.id ?? task.number}-assistant-1`,
      role: "assistant",
    },
    {
      body: "Keep the Preview pinned to the exact pull-request revision and show me the result here.",
      id: `${thread?.id ?? task.number}-user-1`,
      role: "user",
    },
    {
      body: `Done. The current mock is running on ${task.workspace?.machine ?? "the assigned machine"}; we can inspect and iterate without leaving the conversation.`,
      id: `${thread?.id ?? task.number}-assistant-2`,
      role: "assistant",
    },
  ];
}
