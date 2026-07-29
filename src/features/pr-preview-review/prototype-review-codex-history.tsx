import {
  ArrowDown,
  ChevronDown,
  CircleDot,
  FilePenLine,
  ListChecks,
  TerminalSquare,
  Wrench
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type TouchEvent,
  type WheelEvent
} from 'react';

import { Text } from '@/app/dotnaos-ui';
import { CodexMarkdownMessage } from '@/features/codex-sessions/codex-markdown-message';
import type { CodexConversationItem } from '@/features/codex-sessions/codex-sessions-types';

const activityIcons: Record<
  NonNullable<Extract<CodexConversationItem, { kind: 'activity' }>['activityKind']>,
  ComponentType<{ className?: string }>
> = {
  command: TerminalSquare,
  'file-change': FilePenLine,
  'mcp-tool': Wrench,
  plan: ListChecks,
  reasoning: CircleDot,
  status: CircleDot
};

type ActivityItem = Extract<CodexConversationItem, { kind: 'activity' }>;
type VisibleHistoryItem =
  | Extract<CodexConversationItem, { kind: 'message' }>
  | { id: string; items: ActivityItem[]; kind: 'activity-group' };

function groupActivities(items: readonly CodexConversationItem[]): VisibleHistoryItem[] {
  const grouped: VisibleHistoryItem[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      grouped.push(item);
      continue;
    }
    const previous = grouped.at(-1);
    if (previous?.kind === 'activity-group') {
      previous.items.push(item);
    } else {
      grouped.push({ id: `activity-group-${item.id}`, items: [item], kind: 'activity-group' });
    }
  }
  return grouped;
}

export function PrototypeReviewCodexHistory({
  isDark,
  items,
  loading,
  working
}: {
  isDark: boolean;
  items: readonly CodexConversationItem[];
  loading: boolean;
  working: boolean;
}) {
  const retainedMessageIds = new Set(
    items
      .filter((item) => item.kind === 'message')
      .slice(-20)
      .map((item) => item.id)
  );
  const recentItemIds = new Set(items.slice(-120).map((item) => item.id));
  const visibleItems = items.filter(
    (item) => retainedMessageIds.has(item.id) || recentItemIds.has(item.id)
  );
  const historyItems = groupActivities(visibleItems);
  const contentVersion = visibleItems
    .map((item) => item.kind === 'message'
      ? `${item.id}:${item.text.length}:${item.images?.length ?? 0}:${item.streaming ? 1 : 0}`
      : `${item.id}:${item.state}:${item.label.length}:${item.detail?.length ?? 0}`)
    .join('|');
  const latestActivityId = [...visibleItems]
    .reverse()
    .find((item) => item.kind === 'activity')?.id;
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstLayout = useRef(true);
  const openingPin = useRef(true);
  const followingLatestRef = useRef(true);
  const touchStartY = useRef<number | undefined>(undefined);
  const [followingLatest, setFollowingLatest] = useState(true);

  const updateFollowingLatest = useCallback((value: boolean) => {
    followingLatestRef.current = value;
    setFollowingLatest(value);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior) => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    updateFollowingLatest(true);
    if (behavior === 'auto') scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTo({ behavior, top: scroller.scrollHeight });
  }, [updateFollowingLatest]);

  const pauseFollowingLatest = useCallback(() => {
    openingPin.current = false;
    updateFollowingLatest(false);
  }, [updateFollowingLatest]);

  useLayoutEffect(() => {
    if (!firstLayout.current) return;
    firstLayout.current = false;
    scrollToLatest('auto');
  }, [scrollToLatest]);

  useEffect(() => {
    const release = window.setTimeout(() => {
      scrollToLatest('auto');
      openingPin.current = false;
    }, 300);
    return () => window.clearTimeout(release);
  }, [scrollToLatest]);

  useEffect(() => {
    if (!followingLatestRef.current) return;
    const frame = requestAnimationFrame(() => scrollToLatest('smooth'));
    return () => cancelAnimationFrame(frame);
  }, [contentVersion, scrollToLatest]);

  useEffect(() => {
    const content = contentRef.current;
    const scroller = scrollRef.current;
    if (!content || !scroller || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (openingPin.current) scrollToLatest('auto');
      else if (followingLatestRef.current) scrollToLatest('smooth');
    });
    observer.observe(content);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  function handleScroll() {
    const scroller = scrollRef.current;
    if (!scroller) return;
    if (openingPin.current) return;
    const atLatest =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    if (atLatest) updateFollowingLatest(true);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) pauseFollowingLatest();
  }

  function handleTouchStart(event: TouchEvent<HTMLDivElement>) {
    touchStartY.current = event.touches[0]?.clientY;
  }

  function handleTouchMove(event: TouchEvent<HTMLDivElement>) {
    const currentY = event.touches[0]?.clientY;
    if (currentY === undefined || touchStartY.current === undefined) return;
    if (currentY > touchStartY.current + 2) pauseFollowingLatest();
    touchStartY.current = currentY;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (['ArrowUp', 'Home', 'PageUp'].includes(event.key)) pauseFollowingLatest();
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        className="h-full overflow-x-hidden overflow-y-auto px-5 py-5 sm:px-8"
        data-prototype-codex-history-scroll="true"
        onKeyDown={handleKeyDown}
        onPointerDown={pauseFollowingLatest}
        onScroll={handleScroll}
        onTouchMove={handleTouchMove}
        onTouchStart={handleTouchStart}
        onWheel={handleWheel}
        ref={scrollRef}
        tabIndex={0}
      >
        <div
          className="mx-auto min-w-0 max-w-4xl space-y-5 overflow-x-hidden py-3"
          ref={contentRef}
        >
          {!historyItems.length ? (
            <Text className="block py-10 text-center text-xs text-neutral-500">
              {loading ? 'Loading the verified conversation…' : 'No messages yet.'}
            </Text>
          ) : null}
          {historyItems.map((item) =>
            item.kind === 'message' ? (
              <article
                className={`min-w-0 ${item.role === 'user' ? 'flex justify-end' : ''}`}
                key={item.id}
              >
                {item.role === 'user' ? (
                  <div className="flex min-w-0 max-w-[min(82%,42rem)] flex-col items-end gap-2">
                    {item.images?.length ? (
                      <div className="flex max-w-full flex-wrap justify-end gap-2">
                        {item.images.map((image, index) => (
                          <img
                            alt={`Attached image ${index + 1}`}
                            className="max-h-72 max-w-full rounded-2xl object-contain shadow-[0_12px_30px_rgba(0,0,0,0.2)]"
                            key={image.id}
                            loading="lazy"
                            src={image.dataUrl}
                          />
                        ))}
                      </div>
                    ) : null}
                    {item.text ? (
                      <div
                        className={`min-w-0 max-w-full overflow-hidden rounded-[1.4rem] rounded-br-md px-4 py-3 ${
                          isDark ? 'bg-neutral-800 text-neutral-100' : 'bg-white text-neutral-800'
                        }`}
                      >
                        <CodexMarkdownMessage
                          className="min-w-0 max-w-full break-words text-sm leading-6 [overflow-wrap:anywhere] [&_*]:max-w-full"
                          text={item.text}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="min-w-0 max-w-3xl">
                    <CodexMarkdownMessage
                      className={`min-w-0 text-sm leading-6 ${
                        isDark ? 'text-neutral-300' : 'text-neutral-700'
                      }`}
                      text={item.text}
                    />
                  </div>
                )}
              </article>
            ) : (
              <ActivityGroup
                items={item.items}
                key={item.id}
                latestActivityId={latestActivityId}
                working={working}
              />
            )
          )}
        </div>
      </div>
      {!followingLatest ? (
        <button
          aria-label="Jump to latest message and resume auto-scroll"
          className={`absolute bottom-5 right-5 grid size-10 place-items-center rounded-full shadow-[0_10px_30px_rgba(0,0,0,0.32)] transition hover:-translate-y-0.5 ${
            isDark
              ? 'bg-neutral-100 text-neutral-950 hover:bg-white'
              : 'bg-neutral-900 text-white hover:bg-black'
          }`}
          onClick={() => scrollToLatest('smooth')}
          type="button"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

function activityGroupSummary(items: readonly ActivityItem[]): string {
  const toolCount = items.filter((item) => item.activityKind === 'mcp-tool').length;
  const commandCount = items.filter((item) => item.activityKind === 'command').length;
  const fileCount = items.filter((item) => item.activityKind === 'file-change').length;
  const otherCount = items.length - toolCount - commandCount - fileCount;
  const parts = [
    toolCount ? `${toolCount} tool${toolCount === 1 ? '' : 's'}` : '',
    commandCount ? `${commandCount} command${commandCount === 1 ? '' : 's'}` : '',
    fileCount ? `${fileCount} file change${fileCount === 1 ? '' : 's'}` : '',
    otherCount ? `${otherCount} step${otherCount === 1 ? '' : 's'}` : ''
  ].filter(Boolean);
  return parts.length ? `Worked with ${parts.join(', ')}` : 'Worked on the task';
}

function activityText(item: ActivityItem): string {
  const text = item.detail ?? item.label;
  return item.state === 'failed' ? `${text} failed` : text;
}

function ActivityGroup({
  items,
  latestActivityId,
  working
}: {
  items: readonly ActivityItem[];
  latestActivityId?: string;
  working: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = items.find((item) => item.id === latestActivityId);
  const current = working ? latest : undefined;
  const TriggerIcon = current?.activityKind
    ? activityIcons[current.activityKind]
    : Wrench;
  const triggerText = current ? activityText(current) : activityGroupSummary(items);

  return (
    <section
      className="min-w-0 text-neutral-500"
      data-prototype-codex-activity-group="true"
    >
      <button
        aria-expanded={expanded}
        className="flex min-h-8 max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs font-semibold leading-5 text-neutral-400 transition-colors hover:bg-neutral-500/10 hover:text-neutral-300"
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <TriggerIcon className="size-3.5 shrink-0" />
        <span
          className={`min-w-0 truncate font-semibold ${
            current ? 'prototype-codex-visor-text' : ''
          }`}
        >
          {triggerText}
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform duration-200 ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded ? (
        <div className="space-y-0.5">
          {items
            .filter((item) => item.id !== current?.id)
            .map((item) => <ActivityRow item={item} key={item.id} />)}
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const Icon = item.activityKind ? activityIcons[item.activityKind] : CircleDot;
  return (
    <div
      className="flex min-w-0 items-start gap-2.5 px-2 py-1 break-words text-xs font-medium leading-5 text-neutral-500 [overflow-wrap:anywhere]"
      data-prototype-codex-activity={item.activityKind ?? 'status'}
      data-prototype-codex-activity-state={item.state}
    >
      <Icon className="mt-1 size-3.5 shrink-0" />
      <span className="min-w-0">{activityText(item)}</span>
    </div>
  );
}
