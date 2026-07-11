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
  errorMessage,
  onRetry,
  state
}: {
  errorMessage?: string;
  onRetry?(): void;
  state: Exclude<ProjectChatConnectionState, 'ready'> | 'empty';
}) {
  const configuration = state === 'loading'
    ? { Icon: Loader2, copy: 'Loading the shared conversation…', title: 'Opening #general' }
    : state === 'denied'
      ? { Icon: LockKeyhole, copy: 'This account is not a member of this Project Space.', title: 'Chat unavailable' }
      : state === 'error'
        ? { Icon: CircleAlert, copy: errorMessage ?? 'Project Chat could not be loaded.', title: 'Something went wrong' }
        : state === 'offline'
          ? { Icon: WifiOff, copy: 'Reconnect Project Space to read or send messages.', title: 'Project Chat is offline' }
        : { Icon: Hash, copy: 'Messages from people and agents will appear here in order.', title: 'No messages yet' };
  const Icon = configuration.Icon;

  return (
    <div
      aria-live="polite"
      className="grid min-h-0 flex-1 place-items-center px-6 py-16 text-center"
      role={state === 'error' || state === 'denied' ? 'alert' : 'status'}
    >
      <div className="max-w-xs">
        <Icon
          className={state === 'loading' ? 'mx-auto size-5 animate-spin text-neutral-400' : 'mx-auto size-5 text-neutral-500'}
          strokeWidth={1.6}
        />
        <Text className="mt-4 block text-sm font-medium text-neutral-200">{configuration.title}</Text>
        <Text className="mt-1 block text-xs leading-5 text-neutral-400">{configuration.copy}</Text>
        {(state === 'error' || state === 'offline') && onRetry ? (
          <Button className="mt-4" onPress={onRetry} size="sm" variant="outline">Retry</Button>
        ) : null}
      </div>
    </div>
  );
}

function MessageText({ message }: { message: ProjectChatMessageRecord }) {
  return (
    <p className="mt-1 whitespace-pre-wrap text-[13px] leading-6 text-neutral-300">
      {projectChatTextSegments(message).map((segment, index) =>
        segment.kind === 'mention' ? (
          <strong className="font-semibold text-neutral-50" key={`${segment.memberId}-${index}`}>
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

  return (
    <article
      className="group grid grid-cols-[34px_minmax(0,1fr)] gap-3 py-2.5 [contain-intrinsic-size:auto_72px] [content-visibility:auto]"
      data-project-chat-message-id={message.id}
    >
      <ParticipantVisual role={message.sender.role} size={32} />
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            className="truncate text-xs font-semibold text-neutral-200 hover:text-white hover:underline"
            onClick={() => onSelect(message)}
            type="button"
          >
            {message.sender.displayName}
          </button>
          <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-neutral-400">
            {message.sender.role}
          </span>
          {message.sender.role === 'agent' ? <PresenceDot state={state} /> : null}
          <time className="text-[10px] text-neutral-400" dateTime={message.createdAt}>
            {formatProjectChatTime(message.createdAt)}
          </time>
          {mentionedViewer ? (
            <span className="text-[9px] font-medium text-neutral-400">mentioned you</span>
          ) : null}
        </div>
        <MessageText message={message} />
        {message.sender.origin ? (
          <button
            className="mt-1.5 block max-w-full truncate font-mono text-[10px] text-neutral-400 hover:text-neutral-200"
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
  errorMessage,
  members,
  messages,
  now,
  onRetry,
  onSelectMessage,
  state,
  viewerMemberId
}: {
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
    return <FeedState errorMessage={errorMessage} onRetry={onRetry} state={state} />;
  }

  if (sortedMessages.length === 0) {
    return <FeedState onRetry={onRetry} state={state === 'offline' ? 'offline' : 'empty'} />;
  }

  let currentDateLabel = '';
  return (
    <div
      aria-label="Project Chat messages"
      aria-live="polite"
      aria-relevant="additions text"
      className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [overflow-anchor:none] sm:px-6"
      onScroll={(event) => {
        const element = event.currentTarget;
        shouldStickToBottomRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < 96;
        previousScrollTopRef.current = element.scrollTop;
      }}
      ref={scrollRef}
      role="log"
    >
      <div className="mx-auto max-w-3xl">
        {state === 'offline' ? (
          <div aria-live="polite" className="mb-4 flex items-center gap-2 border-y border-amber-400/15 py-2 text-[11px] text-amber-100/70" role="status">
            <WifiOff className="size-3.5 shrink-0" />
            Showing cached messages. Sending resumes when Project Space reconnects.
            {onRetry ? <button className="ml-auto text-neutral-200 underline" onClick={onRetry} type="button">Retry</button> : null}
          </div>
        ) : null}
        {state === 'error' ? (
          <div className="mb-4 flex items-center gap-2 border-y border-red-400/20 py-2 text-[11px] text-red-200" role="alert">
            <CircleAlert className="size-3.5 shrink-0" />
            <span className="truncate">{errorMessage ?? 'Project Chat could not refresh.'}</span>
            {onRetry ? <button className="ml-auto shrink-0 underline" onClick={onRetry} type="button">Retry</button> : null}
          </div>
        ) : null}
        {sortedMessages.map((message) => {
          const dateLabel = projectChatDateLabel(message.createdAt, now);
          const showDivider = dateLabel !== currentDateLabel;
          currentDateLabel = dateLabel;
          return (
            <div key={message.id}>
              {showDivider ? (
                <div className="flex items-center gap-3 py-3" role="separator">
                  <span className="h-px flex-1 bg-neutral-900" />
                  <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-400">{dateLabel}</span>
                  <span className="h-px flex-1 bg-neutral-900" />
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
