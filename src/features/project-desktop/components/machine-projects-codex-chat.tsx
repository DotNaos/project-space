import { useEffect, useRef, useState } from 'react';
import type {
  CodexChatMessageRecord,
  MachineRecord,
  ProjectStructureViolationRecord
} from '@/shared/project-space-api';
import { streamCodexChat } from '@/api/project-space-client';
import { Text } from '@/app/dotnaos-ui';
import { ArrowUp, Bot, CircleAlert, Loader2, MessageSquarePlus } from 'lucide-react';

function createMessageId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function MachineProjectsCodexChat({
  cwd,
  machine,
  systemPrompt,
  violations
}: {
  cwd: string;
  machine: MachineRecord;
  systemPrompt: string;
  violations: ProjectStructureViolationRecord[];
}) {
  const [error, setError] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [messages, setMessages] = useState<CodexChatMessageRecord[]>([]);
  const [prompt, setPrompt] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      behavior: 'smooth',
      top: scrollRef.current.scrollHeight
    });
  }, [isRunning, messages]);

  async function sendMessage() {
    const requestText = prompt.trim();
    if (!requestText || isRunning) {
      return;
    }

    const userMessage: CodexChatMessageRecord = {
      id: createMessageId(),
      role: 'user',
      text: requestText
    };
    const assistantMessageId = createMessageId();
    const history = messages;

    setMessages([
      ...messages,
      userMessage,
      {
        id: assistantMessageId,
        role: 'assistant',
        text: ''
      }
    ]);
    setError('');
    setIsRunning(true);
    setPrompt('');

    try {
      await streamCodexChat(
        {
          cwd,
          machineId: machine.id,
          messages: history,
          prompt: requestText,
          systemPrompt
        },
        (event) => {
          if (event.type === 'delta') {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, text: `${message.text}${event.delta}` }
                  : message
              )
            );
            return;
          }

          if (event.type === 'done') {
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessageId
                  ? { ...message, text: event.response }
                  : message
              )
            );
            return;
          }

          setError(event.message);
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessageId
                ? { ...message, text: message.text || event.message }
                : message
            )
          );
        }
      );
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Codex chat failed.';
      setError(message);
      setMessages((current) =>
        current.map((entry) =>
          entry.id === assistantMessageId ? { ...entry, text: entry.text || message } : entry
        )
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <aside className="flex h-[min(38rem,calc(100vh-18rem))] min-h-[28rem] flex-col overflow-hidden rounded-xl border border-neutral-800/90 bg-neutral-950/70">
      <div className="flex shrink-0 items-center gap-3 border-b border-neutral-900 px-3 py-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-full bg-neutral-900 text-neutral-300">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <Text className="block truncate text-sm font-semibold text-neutral-100">
            Codex repair chat
          </Text>
          <Text className="block truncate text-xs text-neutral-500">
            {machine.name} · {violations.length} violations
          </Text>
        </div>
        {isRunning ? <Loader2 className="size-4 animate-spin text-neutral-400" /> : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col justify-center gap-3 text-center">
            <div className="mx-auto grid size-11 place-items-center rounded-full bg-neutral-900 text-neutral-400">
              <MessageSquarePlus className="size-5" />
            </div>
            <div>
              <Text className="block text-sm font-medium text-neutral-200">
                Ask Codex to clean this machine.
              </Text>
              <Text className="mx-auto mt-1 block max-w-64 text-xs leading-5 text-neutral-500">
                It runs through the Codex app-server on the selected machine and streams the
                answer here.
              </Text>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === 'user'
                    ? 'max-w-[88%] self-end rounded-2xl rounded-br-md bg-neutral-800 px-3 py-2 text-sm leading-5 text-neutral-100'
                    : 'max-w-full self-start whitespace-pre-wrap px-1 py-1 text-sm leading-6 text-neutral-200'
                }
              >
                {message.text || (message.role === 'assistant' && isRunning ? 'Thinking...' : '')}
              </div>
            ))}
          </div>
        )}
      </div>

      {error ? (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="flex shrink-0 items-end gap-2 border-t border-neutral-900 px-3 py-3">
        <textarea
          rows={1}
          value={prompt}
          onChange={(event) => setPrompt(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void sendMessage();
            }
          }}
          placeholder="Ask Codex what to fix..."
          className="max-h-32 min-h-11 flex-1 resize-none rounded-2xl bg-neutral-900 px-4 py-3 text-sm leading-5 text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <button
          type="button"
          aria-label="Ask Codex"
          disabled={isRunning || !prompt.trim()}
          onClick={() => void sendMessage()}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-950 transition active:scale-95 hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
        >
          {isRunning ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ArrowUp className="size-4" />
          )}
        </button>
      </div>
    </aside>
  );
}
