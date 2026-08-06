import { useState } from "react";
import { Button, TextArea } from "@heroui/react";
import { ArrowLeft, Bot, GitBranch, MessageCircle, Send, UserRound } from "lucide-react";

import { PageStatus, SectionHeading } from "./page-foundation";

export interface PrototypeChat {
  avatar: string;
  meta: string;
  preview: string;
  title: string;
  unread: number;
  updated: string;
}

const initialMessages = [
  { author: "Oli", body: "The new layout should preserve every Project Space function, not reduce the product.", time: "09:34" },
  { author: "Codex", body: "I am treating the current application as the complete feature inventory and rebuilding each view in the selected visual direction.", time: "09:36" },
  { author: "Oli", body: "Keep Codex tasks and project conversations together here.", time: "09:38" },
];

export function ChatDetailView({ chat, onBack }: { chat: PrototypeChat; onBack(): void }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);

  function sendMessage() {
    const body = draft.trim();
    if (!body) return;
    setMessages((current) => [...current, { author: "Oli", body, time: "now" }]);
    setDraft("");
  }

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col px-5 pb-4 pt-3 @md:px-8 @3xl:px-10 @5xl:px-12 @5xl:pt-7">
      <header className="flex shrink-0 items-center gap-3 border-b border-current/[.08] pb-4">
        <Button isIconOnly aria-label="Back to chats" size="sm" style={{ color: "inherit" }} variant="ghost" onPress={onBack}><ArrowLeft className="size-4" /></Button>
        <span className="grid size-9 place-items-center rounded-full bg-current/[.07] text-[11px] font-semibold text-current/60">{chat.avatar}</span>
        <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold">{chat.title}</h1><p className="mt-0.5 truncate text-xs text-current/35">{chat.meta}</p></div>
        <PageStatus tone="success">Active</PageStatus>
      </header>

      <div className="grid min-h-0 flex-1 @3xl:grid-cols-[minmax(0,1fr)_18rem]">
        <main className="flex min-h-0 min-w-0 flex-col @3xl:pr-8">
          <div className="min-h-0 flex-1 overflow-y-auto py-6 [scrollbar-width:none]">
            <div className="mx-auto max-w-2xl space-y-6">
              {messages.map((message, index) => (
                <article className={`flex gap-3 ${message.author === "Oli" ? "justify-end" : "justify-start"}`} key={`${message.time}-${index}`}>
                  {message.author !== "Oli" ? <span className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-400"><Bot className="size-4" /></span> : null}
                  <div className={`max-w-[82%] ${message.author === "Oli" ? "rounded-2xl bg-current/[.07] px-4 py-3" : "pt-1"}`}>
                    <div className="flex items-center gap-2"><span className="text-xs font-medium text-current/70">{message.author}</span><span className="text-[10px] text-current/25">{message.time}</span></div>
                    <p className="mt-1.5 text-sm leading-6 text-current/65">{message.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
          <form className="mx-auto w-full max-w-2xl shrink-0 pb-2" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
            <div className="rounded-2xl bg-current/[.05] p-2 ring-1 ring-inset ring-current/[.08] focus-within:ring-current/[.16]">
              <TextArea aria-label="Message project chat" className="min-h-20 w-full resize-none border-0 bg-transparent px-2 py-1 text-sm shadow-none" placeholder="Message the project chat" rows={2} value={draft} variant="secondary" onChange={(event) => setDraft(event.target.value)} />
              <div className="flex justify-end px-1 pb-1"><Button isDisabled={!draft.trim()} size="sm" type="submit" variant="primary"><Send className="size-3.5" /> Send</Button></div>
            </div>
          </form>
        </main>

        <aside className="border-t border-current/[.08] py-6 @3xl:border-l @3xl:border-t-0 @3xl:pl-6">
          <SectionHeading>Attached task</SectionHeading>
          <div className="border-y border-current/[.08] py-4">
            <div className="flex items-center gap-2"><Bot className="size-4 text-emerald-400" /><span className="text-sm font-medium">#437 · Frontend redesign</span></div>
            <p className="mt-2 text-xs leading-5 text-current/40">Building the selected Project Space direction and preserving the existing workflow.</p>
            <div className="mt-4 flex items-center justify-between"><span className="flex items-center gap-1.5 text-[11px] text-current/35"><UserRound className="size-3" /> Codex</span><PageStatus tone="success">Working</PageStatus></div>
          </div>
          <div className="mt-7">
            <SectionHeading>Context</SectionHeading>
            <div className="space-y-1 border-y border-current/[.08] py-3">
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-current/55 hover:bg-current/[.04]" type="button"><MessageCircle className="size-3.5" /> Issue #437</button>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs text-current/55 hover:bg-current/[.04]" type="button"><GitBranch className="size-3.5" /> issue-437-redesign…</button>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
