import { useLayoutEffect, useMemo, useRef } from 'react';
import { CircleAlert, Hash, Loader2, LockKeyhole, WifiOff } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '@/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  formatProjectChatTime,
  projectChatDateLabel,
  projectChatMessageIdentity,
  projectChatAgentNameIdentity,
  projectChatTextSegments,
  shortProjectChatId,
  sortProjectChatMessages
} from '../project-chat-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';

export type ProjectChatConnectionState = 'denied' | 'error' | 'loading' | 'offline' | 'ready';

interface MessagePosition {
  bottom: number;
  top: number;
}

function messagePositions(element: HTMLDivElement) {
  const containerTop = element.getBoundingClientRect().top;
  const positions = new Map<string, MessagePosition>();
  for (const message of element.querySelectorAll<HTMLElement>('[data-project-chat-message-id]')) {
    const id = message.dataset.projectChatMessageId;
    if (!id) {
      continue;
    }
    const bounds = message.getBoundingClientRect();
    const top = bounds.top - containerTop + element.scrollTop;
    positions.set(id, { bottom: top + bounds.height, top });
  }
  return positions;
}

function FeedState({
  channelName,
  errorMessage,
  onRetry,
  state
}: {
  channelName: string;
  errorMessage?: string;
  onRetry?(): void;
  state: Exclude<ProjectChatConnectionState, 'ready'> | 'empty';
}) {
  const configuration = state === 'loading'
    ? { Icon: Loader2, copy: 'Loading the shared conversation…', title: `Opening #${channelName}` }
    : state === 'denied'
      ? { Icon: LockKeyhole, copy: 'This account is not a member of this Project Space.', title: 'Chat unavailable' }
      : state === 'error'
        ? { Icon: CircleAlert, copy: errorMessage ?? 'Project Chat could not be loaded.', title: 'Something went wrong' }
        : state === 'offline'
          ? { Icon: WifiOff, copy: 'Reconnect Project Space to read or send messages.', title: 'Project Chat is offline' }
        : { Icon: Hash, copy: 'Write the first message. People and agents in this room see it in order.', title: 'No messages yet' };
  const Icon = configuration.Icon;

  return (
    <div
      aria-live="polite"
      className="grid min-h-0 flex-1 place-items-center gap-3 px-6 py-16 text-center"
      role={state === 'error' || state === 'denied' ? 'alert' : 'status'}
    >
      <div className="max-w-sm">
        <Icon
          className={state === 'loading'
            ? 'mx-auto size-6 animate-spin text-neutral-600'
            : 'mx-auto size-6 text-neutral-700'}
          strokeWidth={1.6}
        />
        <Text className="mt-3 block text-sm font-medium text-neutral-300">{configuration.title}</Text>
        <Text className="mt-1 block text-sm leading-6 text-neutral-500">{configuration.copy}</Text>
        {(state === 'error' || state === 'offline') && onRetry ? (
          <Button className="mt-4" onPress={onRetry} size="sm" variant="ghost">Retry</Button>
        ) : null}
      </div>
    </div>
  );
}

function MessageText({ message }: { message: ProjectChatMessageRecord }) {
  return (
    <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-neutral-300">
      {projectChatTextSegments(message).map((segment, index) =>
        segment.kind === 'mention' ? (
          <strong className="font-medium text-sky-300" key={`${segment.memberId}-${index}`}>
            {segment.value}
          </strong>
        ) : (
          <span key={`text-${index}`}>{segment.value}</span>
        )
      )}
    </p>
  );
}

function ChatMessage({
  member,
  message,
  now,
  onSelect,
  viewerMemberId
}: {
  member?: ProjectChatMemberRecord;
  message: ProjectChatMessageRecord;
  now: Date;
  onSelect(message: ProjectChatMessageRecord): void;
  viewerMemberId?: string;
}) {
  const state = member ? effectiveProjectChatPresence(member, now) : 'offline';
  const mentionedViewer = Boolean(
    viewerMemberId && message.mentions.some((mention) => mention.memberId === viewerMemberId)
  );
  const identity = projectChatMessageIdentity(message, member);
  const agentName = projectChatAgentNameIdentity(message.sender);

  return (
    <article
      className="group grid grid-cols-[2rem_minmax(0,1fr)] gap-3 py-3 [contain-intrinsic-size:auto_84px] [content-visibility:auto]"
      data-project-chat-message-id={message.id}
    >
      <ParticipantVisual
        agentCategory={agentName?.category}
        agentName={agentName?.name}
        avatarUrl={identity.avatarUrl}
        displayName={identity.displayName}
        role={message.sender.role}
        size={32}
      />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            className="truncate text-sm font-medium text-neutral-200 transition hover:text-white"
            onClick={() => onSelect(message)}
            type="button"
          >
            {identity.displayName}
          </button>
          {message.sender.role === 'agent' ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-600">
              <PresenceDot state={state} />
              Agent
            </span>
          ) : null}
          <time className="text-[11px] text-neutral-600" dateTime={message.createdAt}>
            {formatProjectChatTime(message.createdAt)}
          </time>
          {mentionedViewer ? (
            <span className="shrink-0 text-[11px] font-medium text-sky-300/90">mentioned you</span>
          ) : null}
        </div>
        <MessageText message={message} />
        {message.sender.origin ? (
          <button
            className="mt-1.5 block max-w-full truncate font-mono text-[11px] text-neutral-700 transition hover:text-neutral-400"
            onClick={() => onSelect(message)}
            type="button"
          >
            origin {shortProjectChatId(message.sender.origin.threadId)} · {message.sender.origin.taskTitle ?? message.sender.origin.hostId}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function ProjectChatFeed({
  channelName,
  errorMessage,
  members,
  messages,
  now,
  onRetry,
  onSelectMessage,
  state,
  viewerMemberId
}: {
  channelName: string;
  errorMessage?: string;
  members: ProjectChatMemberRecord[];
  messages: ProjectChatMessageRecord[];
  now: Date;
  onRetry?(): void;
  onSelectMessage(message: ProjectChatMessageRecord): void;
  state: ProjectChatConnectionState;
  viewerMemberId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousPositionsRef = useRef(new Map<string, MessagePosition>());
  const previousScrollTopRef = useRef(0);
  const shouldStickToBottomRef = useRef(true);
  const sortedMessages = useMemo(() => sortProjectChatMessages(messages), [messages]);
  const firstSequence = sortedMessages[0]?.sequence ?? 0;
  const lastSequence = sortedMessages.at(-1)?.sequence ?? 0;
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.memberId, member])),
    [members]
  );

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    if (shouldStickToBottomRef.current) {
      element.scrollTo({ top: element.scrollHeight });
    } else {
      const currentPositions = messagePositions(element);
      const anchor = [...previousPositionsRef.current].find(
        ([id, position]) => position.bottom > previousScrollTopRef.current && currentPositions.has(id)
      );
      if (anchor) {
        const [id, previousPosition] = anchor;
        const viewportOffset = previousPosition.top - previousScrollTopRef.current;
        element.scrollTop = Math.max(0, currentPositions.get(id)!.top - viewportOffset);
      }
    }
    previousScrollTopRef.current = element.scrollTop;
    previousPositionsRef.current = messagePositions(element);
  }, [firstSequence, lastSequence]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      previousScrollTopRef.current = element.scrollTop;
      previousPositionsRef.current = messagePositions(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (state === 'loading' || state === 'denied' || (state === 'error' && sortedMessages.length === 0)) {
    return <FeedState channelName={channelName} errorMessage={errorMessage} onRetry={onRetry} state={state} />;
  }

  if (sortedMessages.length === 0) {
    return <FeedState channelName={channelName} onRetry={onRetry} state={state === 'offline' ? 'offline' : 'empty'} />;
  }

  let currentDateLabel = '';
  return (
    <div
      aria-label="Project Chat messages"
      aria-live="polite"
      aria-relevant="additions text"
      className="min-h-0 flex-1 overflow-y-auto py-2 [overflow-anchor:none]"
      onScroll={(event) => {
        const element = event.currentTarget;
        shouldStickToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        previousScrollTopRef.current = element.scrollTop;
      }}
      ref={scrollRef}
      role="log"
    >
      {/* A short conversation sits on the composer instead of floating at the top. */}
      <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end">
        {state === 'offline' ? (
          <div
            aria-live="polite"
            className="mb-3 flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[.07] px-3 py-2 text-xs text-amber-200/90"
            role="status"
          >
            <WifiOff className="size-3.5 shrink-0" />
            Showing cached messages. Sending resumes when Project Space reconnects.
            {onRetry ? (
              <button className="ml-auto shrink-0 underline" onClick={onRetry} type="button">Retry</button>
            ) : null}
          </div>
        ) : null}
        {state === 'error' ? (
          <div
            className="mb-3 flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/[.07] px-3 py-2 text-xs text-red-200/90"
            role="alert"
          >
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="truncate">{errorMessage ?? 'Project Chat could not refresh.'}</span>
            {onRetry ? (
              <button className="ml-auto shrink-0 underline" onClick={onRetry} type="button">Retry</button>
            ) : null}
          </div>
        ) : null}
        {sortedMessages.map((message) => {
          const dateLabel = projectChatDateLabel(message.createdAt, now);
          const showDivider = dateLabel !== currentDateLabel;
          currentDateLabel = dateLabel;
          return (
            <div key={message.id}>
              {showDivider ? (
                <div className="flex items-center gap-3 py-4" role="separator">
                  <span className="h-px flex-1 bg-neutral-800/70" />
                  <span className="text-[11px] font-medium text-neutral-600">{dateLabel}</span>
                  <span className="h-px flex-1 bg-neutral-800/70" />
                </div>
              ) : null}
              <ChatMessage
                member={membersById.get(message.sender.memberId)}
                message={message}
                now={now}
                onSelect={onSelectMessage}
                viewerMemberId={viewerMemberId}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
