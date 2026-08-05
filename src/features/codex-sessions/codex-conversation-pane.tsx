import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowUp,
  Brain,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock3,
  FilePenLine,
  ListChecks,
  Loader2,
  PanelRight,
  ShieldCheck,
  TerminalSquare,
  Wrench,
  X
} from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import { cn } from '@/lib/utils';
import type { CodexSessionTurnSettings } from '@/shared/codex-sessions-api';
import { codexContinueBlockReason, codexThreadOrigin } from './codex-sessions-model';
import { CodexComposerTextArea } from './codex-composer-textarea';
import { CodexMarkdownMessage } from './codex-markdown-message';
import { CodexSessionPermissionControl } from './codex-session-permission-control';
import {
  CodexSessionModelSelect,
  type CodexSessionModelSelection
} from './codex-session-model-select';
import type {
  CodexConversation,
  CodexConversationItem,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin
} from './codex-sessions-types';

const activityStateIcon = {
  failed: X,
  running: Loader2,
  waiting: Clock3
};

const activityStateLabel = {
  failed: 'Failed',
  running: 'Running',
  waiting: 'Waiting'
};

const completedActivityIcon = {
  command: TerminalSquare,
  'file-change': FilePenLine,
  'mcp-tool': Wrench,
  plan: ListChecks,
  reasoning: Brain,
  status: CircleDot
};

type ActivityItem = Extract<CodexConversationItem, { kind: 'activity' }>;
type MessageConversationItem = Extract<CodexConversationItem, { kind: 'message' }>;

type ConversationSegment =
  | { item: MessageConversationItem; kind: 'message' }
  | { items: ActivityItem[]; kind: 'activity-run' };

function groupConversationItems(items: CodexConversationItem[]): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let activityRun: ActivityItem[] = [];

  function flushActivityRun() {
    if (!activityRun.length) return;
    segments.push({ items: activityRun, kind: 'activity-run' });
    activityRun = [];
  }

  for (const item of items) {
    if (item.kind === 'activity') {
      activityRun.push(item);
      continue;
    }
    flushActivityRun();
    segments.push({ item, kind: 'message' });
  }
  flushActivityRun();
  return segments;
}

function activityIcon(item: ActivityItem) {
  return item.state === 'completed'
    ? completedActivityIcon[item.activityKind ?? 'status']
    : activityStateIcon[item.state];
}

function activityDisplayText(item: ActivityItem) {
  return item.detail ?? item.label;
}

function completedActivityRunLabel(items: ActivityItem[]) {
  const actions = [...new Set(items.map(activityDisplayText))];
  const visibleActions = actions.slice(0, 2).join(', ');
  return actions.length > 2 ? `${visibleActions}, +${actions.length - 2}` : visibleActions;
}

function ActivityRowContent({ item }: { item: ActivityItem }) {
  const Icon = activityIcon(item);
  return (
    <>
      <Icon className={cn(
        'mt-[0.3rem] size-[1.125rem] shrink-0 stroke-[1.75] text-neutral-500',
        item.state === 'running' && 'animate-spin text-neutral-300',
        item.state === 'failed' && 'text-red-400'
      )} />
      <span className="min-w-0 break-words">
        {item.state === 'completed' ? null : (
          <span className="sr-only">{activityStateLabel[item.state]}: </span>
        )}
        <Text className="text-neutral-400">
          {activityDisplayText(item)}
        </Text>
      </span>
    </>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div
      className="my-1.5 flex min-w-0 items-start gap-3 py-1.5 text-[0.9375rem] leading-7 text-neutral-500"
      data-codex-activity-kind={item.activityKind ?? 'unknown'}
      data-codex-activity-row="true"
    >
      <ActivityRowContent item={item} />
    </div>
  );
}

function ActivityRun({ items }: { items: ActivityItem[] }) {
  if (items.length === 1) return <ActivityRow item={items[0]} />;

  const activeItem = [...items].reverse().find((item) => item.state !== 'completed');
  const visibleItem = activeItem ?? items[items.length - 1];
  const hiddenItems = items.filter((item) => item.id !== visibleItem.id);
  const SummaryIcon = activeItem ? activityIcon(activeItem) : ListChecks;
  const summaryLabel = activeItem
    ? activityDisplayText(activeItem)
    : completedActivityRunLabel(items);

  return (
    <details
      className="group/activity-run my-1.5 min-w-0 text-[0.9375rem] leading-7 text-neutral-500"
      data-codex-activity-run="true"
      data-codex-activity-run-count={items.length}
      data-codex-activity-run-state={activeItem?.state ?? 'completed'}
    >
      <summary
        className="flex min-w-0 cursor-pointer list-none items-start gap-3 py-1.5 outline-none transition-colors hover:text-neutral-300 focus-visible:text-neutral-200 [&::-webkit-details-marker]:hidden"
        data-codex-activity-run-summary="true"
      >
        <SummaryIcon className={cn(
          'mt-[0.3rem] size-[1.125rem] shrink-0 stroke-[1.75] text-neutral-500',
          activeItem?.state === 'running' && 'animate-spin text-neutral-300',
          activeItem?.state === 'failed' && 'text-red-400'
        )} />
        <Text className="min-w-0 flex-1 truncate text-neutral-400">{summaryLabel}</Text>
        <span className="mt-[0.2rem] shrink-0 text-[10px] tabular-nums text-neutral-600">
          +{hiddenItems.length}
        </span>
        <ChevronRight className="mt-[0.35rem] size-3.5 shrink-0 text-neutral-600 transition-transform duration-150 group-open/activity-run:rotate-90" />
      </summary>
      <div className="pl-7" data-codex-activity-run-items="true">
        {hiddenItems.map((item) => <ActivityRow item={item} key={item.id} />)}
      </div>
    </details>
  );
}

function MessageItem({ item }: { item: Extract<CodexConversationItem, { kind: 'message' }> }) {
  if (item.role === 'assistant') {
    return (
      <article
        aria-label="Assistant response"
        className="min-w-0 py-4 sm:py-5"
        data-codex-message-role="assistant"
      >
        <CodexMarkdownMessage text={item.text} />
        {item.streaming ? (
          <span className="mt-2 inline-flex items-center gap-1.5 text-[10px] text-neutral-500">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> Streaming
          </span>
        ) : null}
      </article>
    );
  }

  return (
    <article
      aria-label="Your message"
      className="flex justify-end py-3"
      data-codex-message-role="user"
    >
      <div className="min-w-0 max-w-full rounded-2xl rounded-br-md bg-neutral-800/90 px-4 py-2.5 text-sm leading-6 text-neutral-100 sm:max-w-[76ch] max-[639px]:max-w-[88%]">
        <p className="break-words whitespace-pre-wrap">{item.text}</p>
      </div>
    </article>
  );
}

export function CodexConversationPane({
  conversation,
  historyState = 'ready',
  historyStatusDetail,
  machine,
  modelSelection,
  onBack,
  onContinue,
  onPermissionChange,
  onOpenDetails,
  session,
  showHeader = true,
  supplemental
}: {
  conversation?: CodexConversation;
  historyState?: 'blocked' | 'loading' | 'ready';
  historyStatusDetail?: string;
  machine?: CodexMachine;
  modelSelection?: CodexSessionModelSelection;
  onBack?(): void;
  onContinue?(
    origin: CodexThreadOrigin,
    message: string,
    settings?: CodexSessionTurnSettings
  ): Promise<void> | void;
  onPermissionChange?(
    origin: CodexThreadOrigin,
    permissionProfileId: string
  ): Promise<void>;
  onOpenDetails?(): void;
  session?: CodexSession;
  showHeader?: boolean;
  supplemental?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setDraft('');
  }, [session?.machineId, session?.threadId]);

  useEffect(() => {
    if (conversation?.items.some((item) => item.kind === 'message' && item.streaming)) {
      endRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [conversation?.items]);

  if (!session) {
    return (
      <section className="grid h-full min-h-0 place-items-center bg-neutral-950 text-center">
        <div className="max-w-xs px-6">
          <TerminalSquare className="mx-auto size-6 text-neutral-700" />
          <Text as="h2" className="mt-4 block text-sm font-medium text-neutral-300">Select a Codex session</Text>
          <Text className="mt-1 block text-xs leading-5 text-neutral-500">
            Stored history opens read-only. Continuing is a separate action.
          </Text>
        </div>
      </section>
    );
  }

  const blockReason = codexContinueBlockReason(session, machine);
  const pendingCount = (conversation?.approvals?.length ?? 0) + (conversation?.userInputRequests?.length ?? 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || blockReason || !onContinue || sending) return;
    setSending(true);
    try {
      await onContinue(codexThreadOrigin(session!), message, modelSelection?.override);
      setDraft('');
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-label="Selected Codex conversation" className="flex h-full min-h-0 flex-col bg-neutral-950">
      {showHeader ? <header className="flex h-[68px] shrink-0 items-center gap-2 border-b border-neutral-800/80 px-4">
        {onBack ? (
          <Button aria-label="Back to sessions" className="-ml-2 size-8 min-h-0" isIconOnly onPress={onBack} size="sm" variant="ghost">
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <div className="min-w-0">
          <Text as="h2" className="block truncate text-sm font-semibold text-neutral-100">{session.title}</Text>
          <div className="mt-1 flex items-center gap-2 text-[9px] text-neutral-500">
            <span className="rounded-full border border-neutral-800 px-1.5 py-0.5">History opened read-only</span>
            {session.status === 'active' ? <span className="text-emerald-400">Streaming</span> : null}
          </div>
        </div>
        {onOpenDetails ? (
          <Button aria-label="Open session details" className="ml-auto size-8 min-h-0" isIconOnly onPress={onOpenDetails} size="sm" variant="ghost">
            {pendingCount > 0 ? <CircleAlert className="size-4 text-amber-400" /> : <PanelRight className="size-4" />}
          </Button>
        ) : null}
      </header> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-8">
        {conversation?.items.length ? (
          <div className="mx-auto w-full max-w-[84ch]" data-codex-transcript="article">
            {groupConversationItems(conversation.items).map((segment) => (
              segment.kind === 'message'
                ? <MessageItem item={segment.item} key={segment.item.id} />
                : <ActivityRun items={segment.items} key={`activity-run-${segment.items[0].id}`} />
            ))}
          </div>
        ) : historyState === 'loading' ? (
          <div className="grid h-full place-items-center text-center">
            <div>
              <Loader2 className="mx-auto size-4 animate-spin text-neutral-500" />
              <Text className="mt-3 block text-xs text-neutral-400">Loading stored conversation…</Text>
              <Text className="mt-1 block text-[10px] text-neutral-600">The task remains unchanged while history is verified.</Text>
            </div>
          </div>
        ) : historyState === 'blocked' ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm px-6">
              <CircleAlert className="mx-auto size-4 text-amber-400" />
              <Text className="mt-3 block text-xs text-neutral-300">Stored conversation is not available right now.</Text>
              <Text className="mt-1 block text-[10px] leading-4 text-neutral-500">
                {historyStatusDetail ?? 'Reconnect the owning machine to verify this task history.'}
              </Text>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center text-center">
            <div>
              <Text className="block text-xs text-neutral-400">No stored conversation items were returned.</Text>
              <Text className="mt-1 block text-[10px] text-neutral-600">The session remains unchanged.</Text>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {supplemental}
      <form
        className="shrink-0 bg-neutral-950 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6 sm:pb-4"
        data-codex-composer="true"
        onSubmit={submit}
      >
        {blockReason ? (
          <div className="mb-2 flex items-center gap-2 text-[10px] text-neutral-500">
            <Clock3 className="size-3 shrink-0" />
            <Text>{blockReason}</Text>
          </div>
        ) : null}
        <div className="flex min-h-[7.25rem] flex-col rounded-[1.75rem] border border-neutral-700/80 bg-neutral-900 px-3 pb-2.5 pt-3 shadow-[0_10px_32px_rgba(0,0,0,0.32)] transition-colors focus-within:border-neutral-500">
          <CodexComposerTextArea
            aria-label="Continue this Codex session"
            className="min-h-14 w-full flex-none px-1 py-0"
            disabled={Boolean(blockReason) || !onContinue || sending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={blockReason ?? 'Continue this session…'}
            value={draft}
          />
          <div className="mt-auto flex min-w-0 items-center justify-between gap-3" data-codex-composer-actions="true">
            <div className="flex min-w-0 items-center gap-0.5">
              {session.permissionProfiles?.length && onPermissionChange ? (
                <CodexSessionPermissionControl
                  activeProfileId={session.permissionProfileId}
                  disabled={Boolean(blockReason) || sending}
                  isDark
                  onChange={(profileId) => onPermissionChange(codexThreadOrigin(session), profileId)}
                  profiles={session.permissionProfiles}
                />
              ) : (
                <span
                  aria-label="Exact machine and task authorization"
                  className="grid size-9 shrink-0 place-items-center text-neutral-500"
                  role="img"
                  title="Exact machine and task authorization"
                >
                  <ShieldCheck className="size-4" />
                </span>
              )}
              <CodexSessionModelSelect
                disabled={Boolean(blockReason) || sending || (modelSelection?.disabled ?? true)}
                effort={modelSelection?.effort}
                error={modelSelection?.error}
                models={modelSelection?.models ?? []}
                onChange={modelSelection?.onChange ?? (() => {})}
                onEffortChange={modelSelection?.onEffortChange ?? (() => {})}
                onServiceTierChange={modelSelection?.onServiceTierChange ?? (() => {})}
                override={modelSelection?.override}
                serviceTier={modelSelection?.serviceTier}
                usesCatalogueDefault={modelSelection?.usesCatalogueDefault}
                value={modelSelection?.value ?? session.model ?? ''}
              />
            </div>
            <button
              aria-label="Send to this Codex session"
              className="grid size-9 shrink-0 place-items-center rounded-full bg-neutral-100 text-neutral-900 shadow-sm transition hover:bg-white disabled:pointer-events-none disabled:opacity-50"
              disabled={!draft.trim() || Boolean(blockReason) || !onContinue || sending}
              type="submit"
            >
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
