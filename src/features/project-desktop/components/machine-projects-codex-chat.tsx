import { useEffect, useRef, useState } from 'react';
import type {
  CodexChatMessageRecord,
  CodexModelRecord,
  MachineRecord,
  ProjectStructureActionRequest,
  ProjectStructureActionType,
  ProjectStructureViolationRecord
} from '@/shared/project-space-api';
import { projectSpaceClient, streamCodexChat } from '@/api/project-space-client';
import { Text } from '@/app/dotnaos-ui';
import {
  ArrowUp,
  Bot,
  Check,
  CircleAlert,
  Loader2,
  MessageSquarePlus,
  ShieldCheck,
  X
} from 'lucide-react';
import { IssueMarkdown } from './issue-markdown';
import { CodexModelSelect } from './codex-model-select';

type GeneratedRepairActionStatus = 'accepted' | 'declined' | 'failed' | 'running';

interface GeneratedRepairAction {
  action: ProjectStructureActionType;
  label: string;
  path: string;
  reason: string;
  risk?: string;
  type: ProjectStructureViolationRecord['type'];
}

const repairActionLabels: Record<ProjectStructureActionType, string> = {
  initialize_git: 'Initialize Git',
  keep_local_only: 'Keep local only',
  move_to_poc: 'Move to POCs',
  move_to_trash: 'Move to Archive'
};

function createMessageId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export function MachineProjectsCodexChat({
  cwd,
  machine,
  onApplyAction,
  systemPrompt,
  violations
}: {
  cwd: string;
  machine: MachineRecord;
  onApplyAction(request: ProjectStructureActionRequest): Promise<string>;
  systemPrompt: string;
  violations: ProjectStructureViolationRecord[];
}) {
  const [error, setError] = useState('');
  const [actionStatuses, setActionStatuses] = useState<
    Record<string, { message?: string; status: GeneratedRepairActionStatus }>
  >({});
  const [isRunning, setIsRunning] = useState(false);
  const [messages, setMessages] = useState<CodexChatMessageRecord[]>([]);
  const [models, setModels] = useState<CodexModelRecord[]>([]);
  const [model, setModel] = useState('');
  const [modelError, setModelError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [prompt, setPrompt] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      behavior: 'smooth',
      top: scrollRef.current.scrollHeight
    });
  }, [isRunning, messages]);

  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setModelError('');
    setModels([]);
    setModel('');

    void projectSpaceClient
      .getCodexModels({ cwd, machineId: machine.id })
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.status === 'error' || result.models.length === 0) {
          setModels([]);
          setModel('');
          setModelError(result.message ?? 'Codex returned no available models.');
          return;
        }

        setModels(result.models);
        setModel((current) =>
          result.models.some((entry) => entry.model === current)
            ? current
            : (result.models.find((entry) => entry.isDefault) ?? result.models[0]).model
        );
      })
      .catch((loadError) => {
        if (!cancelled) {
          setModels([]);
          setModel('');
          setModelError(
            loadError instanceof Error ? loadError.message : 'Could not load Codex models.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setModelsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, machine.id]);

  async function sendMessage() {
    const requestText = prompt.trim();
    if (
      !requestText ||
      isRunning ||
      modelsLoading ||
      !models.some((entry) => entry.model === model)
    ) {
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
          model,
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

  async function acceptAction(action: GeneratedRepairAction, actionKey: string) {
    const matchingViolation = violations.find(
      (violation) => violation.path === action.path && violation.type === action.type
    );

    if (!matchingViolation) {
      setActionStatuses((current) => ({
        ...current,
        [actionKey]: {
          message: 'This proposal no longer matches a current violation.',
          status: 'failed'
        }
      }));
      return;
    }

    if (
      !window.confirm(
        `Apply this Project Space repair?\n\n${action.label}\n${action.path}\n\nCodex cannot run this itself. Project Space will apply it only after this confirmation.`
      )
    ) {
      return;
    }

    setActionStatuses((current) => ({
      ...current,
      [actionKey]: { status: 'running' }
    }));

    try {
      const message = await onApplyAction({
        action: action.action,
        path: action.path,
        type: action.type
      });

      setActionStatuses((current) => ({
        ...current,
        [actionKey]: { message, status: 'accepted' }
      }));
    } catch (applyError) {
      setActionStatuses((current) => ({
        ...current,
        [actionKey]: {
          message: applyError instanceof Error ? applyError.message : 'Could not apply repair.',
          status: 'failed'
        }
      }));
    }
  }

  function declineAction(actionKey: string) {
    setActionStatuses((current) => ({
      ...current,
      [actionKey]: { status: 'declined' }
    }));
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
        <CodexModelSelect
          disabled={modelsLoading || isRunning}
          models={models}
          onChange={setModel}
          value={model}
        />
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
                Ask Codex to inspect this machine.
              </Text>
              <Text className="mx-auto mt-1 block max-w-64 text-xs leading-5 text-neutral-500">
                It runs read-only through the Codex app-server on the selected machine and streams
                the answer here.
              </Text>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <ChatMessage
                key={message.id}
                actionStatuses={actionStatuses}
                isRunning={isRunning}
                message={message}
                onAcceptAction={(action, actionKey) => void acceptAction(action, actionKey)}
                onDeclineAction={declineAction}
                violations={violations}
              />
            ))}
          </div>
        )}
      </div>

      <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs leading-5 text-emerald-100/80">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Read-only. Codex must ask for explicit confirmation before any move, delete, discard, or
          file change.
        </span>
      </div>

      {error ? (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-200">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {modelError ? (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{modelError}</span>
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
          disabled={
            isRunning ||
            modelsLoading ||
            !prompt.trim() ||
            !models.some((entry) => entry.model === model)
          }
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

function ChatMessage({
  actionStatuses,
  isRunning,
  message,
  onAcceptAction,
  onDeclineAction,
  violations
}: {
  actionStatuses: Record<string, { message?: string; status: GeneratedRepairActionStatus }>;
  isRunning: boolean;
  message: CodexChatMessageRecord;
  onAcceptAction(action: GeneratedRepairAction, actionKey: string): void;
  onDeclineAction(actionKey: string): void;
  violations: ProjectStructureViolationRecord[];
}) {
  if (message.role === 'user') {
    return (
      <div className="max-w-[88%] self-end rounded-2xl rounded-br-md bg-neutral-800 px-3 py-2 text-sm leading-5 text-neutral-100">
        {message.text}
      </div>
    );
  }

  const generatedActions = parseGeneratedRepairActions(message.text);
  const visibleMarkdown = stripGeneratedActionBlocks(message.text);

  return (
    <div className="max-w-full self-start px-1 py-1 text-sm leading-6 text-neutral-200">
      {visibleMarkdown ? (
        <IssueMarkdown
          className="text-sm leading-6 text-neutral-200"
          emptyText=""
          markdown={visibleMarkdown}
        />
      ) : isRunning ? (
        'Thinking...'
      ) : null}
      {generatedActions.length > 0 ? (
        <div className="mt-3 grid gap-2 rounded-lg border border-neutral-800 bg-neutral-950/80 p-2">
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Proposed repairs
          </div>
          {generatedActions.map((action, index) => {
            const actionKey = `${message.id}:${index}:${action.path}:${action.action}`;
            const status = actionStatuses[actionKey];
            const isCurrentViolation = violations.some(
              (violation) => violation.path === action.path && violation.type === action.type
            );
            const disabled = Boolean(status) || !isCurrentViolation;

            return (
              <div
                key={actionKey}
                className="grid gap-2 rounded-md border border-neutral-800 bg-neutral-900/45 p-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-neutral-100">
                    {action.label || repairActionLabels[action.action]}
                  </div>
                  <div className="truncate font-mono text-xs text-neutral-500">
                    {action.path}
                  </div>
                </div>
                {action.reason ? (
                  <div className="text-xs leading-5 text-neutral-400">{action.reason}</div>
                ) : null}
                {action.risk ? (
                  <div className="text-xs leading-5 text-amber-200/80">{action.risk}</div>
                ) : null}
                {!isCurrentViolation ? (
                  <div className="text-xs leading-5 text-red-200">
                    Disabled because this no longer matches a current violation.
                  </div>
                ) : null}
                {status?.message ? (
                  <div
                    className={[
                      'text-xs leading-5',
                      status.status === 'failed' ? 'text-red-200' : 'text-emerald-200'
                    ].join(' ')}
                  >
                    {status.message}
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onAcceptAction(action, actionKey)}
                    className="inline-flex items-center gap-2 rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
                  >
                    {status?.status === 'running' ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Check className="size-3.5" />
                    )}
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={Boolean(status)}
                    onClick={() => onDeclineAction(actionKey)}
                    className="inline-flex items-center gap-2 rounded-md border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:text-neutral-600"
                  >
                    <X className="size-3.5" />
                    Decline
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function stripGeneratedActionBlocks(text: string) {
  return text.replace(/```project-space-actions\s*[\s\S]*?```/g, '').trim();
}

function parseGeneratedRepairActions(text: string): GeneratedRepairAction[] {
  const actions: GeneratedRepairAction[] = [];
  const blockPattern = /```project-space-actions\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = blockPattern.exec(text))) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      const candidates = Array.isArray(parsed) ? parsed : [parsed];

      for (const candidate of candidates) {
        const action = parseGeneratedRepairAction(candidate);

        if (action) {
          actions.push(action);
        }
      }
    } catch {
      // Ignore malformed proposal blocks; the text answer still renders above.
    }
  }

  return actions;
}

function parseGeneratedRepairAction(candidate: unknown): GeneratedRepairAction | undefined {
  if (!candidate || typeof candidate !== 'object') {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const action = typeof record.action === 'string' ? record.action : '';
  const path = typeof record.path === 'string' ? record.path : '';
  const type = typeof record.type === 'string' ? record.type : '';

  if (!isProjectStructureAction(action) || !isProjectStructureViolationType(type) || !path) {
    return undefined;
  }

  return {
    action,
    label:
      typeof record.label === 'string' && record.label.trim()
        ? record.label.trim()
        : repairActionLabels[action],
    path,
    reason: typeof record.reason === 'string' ? record.reason : '',
    risk: typeof record.risk === 'string' ? record.risk : undefined,
    type
  };
}

function isProjectStructureAction(value: string): value is ProjectStructureActionType {
  return value in repairActionLabels;
}

function isProjectStructureViolationType(
  value: string
): value is ProjectStructureViolationRecord['type'] {
  return [
    'git_repo_missing_github_remote',
    'nested_project_checkout',
    'orphan_worktree_container',
    'root_stray_file',
    'root_stray_folder',
    'worktree_project_stray_file',
    'worktree_stray_folder',
    'worktrees_missing_project_layer',
    'worktrees_stray_file'
  ].includes(value);
}
