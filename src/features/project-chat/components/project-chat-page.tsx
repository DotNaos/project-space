import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Hash, PanelRight, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatChannelRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '@/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  projectChatThreads,
  type ProjectChatThreadSummary
} from '../project-chat-model';
import { ProjectChatComposer } from './project-chat-composer';
import { ProjectChatFeed, type ProjectChatConnectionState } from './project-chat-feed';
import {
  ProjectChatInspector,
  type ProjectChatInspectorTab
} from './project-chat-inspector';
import { ProjectChatSidebar } from './project-chat-sidebar';
import { ProjectChatThreadDetails } from './project-chat-thread-details';

export interface ProjectChatPageProps {
  channel: ProjectChatChannelRecord;
  connectionState?: ProjectChatConnectionState;
  errorMessage?: string;
  members: ProjectChatMemberRecord[];
  mentionError?: string;
  mentionMessages?: ProjectChatMessageRecord[];
  messages: ProjectChatMessageRecord[];
  now?: Date;
  onAcknowledgeMention?(throughSequence: number): void;
  onOpenThread?(threadId: string): void;
  onRetry?(): void;
  onRetryMention?(): void;
  onSend(body: string): Promise<void> | void;
  unreadMentionCount?: number;
  viewer?: ProjectChatMemberRecord;
}

export function ProjectChatPage({
  channel,
  connectionState = 'ready',
  errorMessage,
  members,
  mentionError,
  mentionMessages = [],
  messages,
  now = new Date(),
  onAcknowledgeMention,
  onOpenThread,
  onRetry,
  onRetryMention,
  onSend,
  unreadMentionCount = 0,
  viewer
}: ProjectChatPageProps) {
  const threads = useMemo(() => projectChatThreads(messages, members), [members, messages]);
  const [activeTab, setActiveTab] = useState<ProjectChatInspectorTab>('mentions');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compactDetailsOpen, setCompactDetailsOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const initialThread = threads[0];
  const [selectedMemberId, setSelectedMemberId] = useState<string | undefined>(
    () => initialThread?.memberId ?? members.find((member) => member.role === 'agent')?.memberId
  );
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>(
    () => initialThread?.threadId
  );
  const selectedThread = threads.find((thread) => thread.threadId === selectedThreadId);
  const activeAgentCount = members.filter(
    (member) => member.role === 'agent' && effectiveProjectChatPresence(member, now) === 'working'
  ).length;

  useEffect(() => {
    const currentThread = threads.find((thread) => thread.threadId === selectedThreadId);
    if (currentThread) {
      if (selectedMemberId !== currentThread.memberId) {
        setSelectedMemberId(currentThread.memberId);
      }
      return;
    }

    const memberThread = threads.find((thread) => thread.memberId === selectedMemberId);
    const nextThread = memberThread ?? threads[0];
    if (nextThread) {
      setSelectedMemberId(nextThread.memberId);
      setSelectedThreadId(nextThread.threadId);
      return;
    }

    const nextMember = members.find((member) => member.role === 'agent');
    setSelectedMemberId(nextMember?.memberId);
    setSelectedThreadId(undefined);
  }, [members, selectedMemberId, selectedThreadId, threads]);

  useEffect(() => {
    if (!inspectorOpen) {
      return;
    }

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    dialogRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, [inspectorOpen]);

  useEffect(() => {
    if (inspectorOpen && compactDetailsOpen) {
      dialogRef.current?.focus();
    }
  }, [compactDetailsOpen, inspectorOpen]);

  useEffect(() => {
    const wideViewport = window.matchMedia('(min-width: 1360px)');
    const closeAtWideViewport = () => {
      if (wideViewport.matches) {
        setInspectorOpen(false);
        setCompactDetailsOpen(false);
      }
    };
    wideViewport.addEventListener('change', closeAtWideViewport);
    closeAtWideViewport();
    return () => wideViewport.removeEventListener('change', closeAtWideViewport);
  }, []);

  function usesCompactDetails() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 1359px)').matches;
  }

  function closeInspector() {
    setInspectorOpen(false);
    setCompactDetailsOpen(false);
  }

  function openInspector() {
    setCompactDetailsOpen(false);
    setInspectorOpen(true);
  }

  function openCompactThreadDetails() {
    if (usesCompactDetails()) {
      setCompactDetailsOpen(true);
      setInspectorOpen(true);
    }
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeInspector();
      return;
    }

    if (event.key !== 'Tab' || !dialogRef.current) {
      return;
    }

    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )];
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function selectThread(thread: ProjectChatThreadSummary) {
    setSelectedThreadId(thread.threadId);
    setSelectedMemberId(thread.memberId);
    openCompactThreadDetails();
  }

  function selectMember(memberId: string) {
    setSelectedMemberId(memberId);
    const memberThread = threads.find((thread) => thread.memberId === memberId);
    if (memberThread) {
      setSelectedThreadId(memberThread.threadId);
      openCompactThreadDetails();
    } else {
      setSelectedThreadId(undefined);
    }
  }

  function selectMessage(message: ProjectChatMessageRecord) {
    const mentionedViewer = viewer && message.mentions.some(
      (mention) => mention.memberId === viewer.memberId
    );
    if (mentionedViewer) {
      onAcknowledgeMention?.(message.sequence);
    }

    if (message.sender.origin) {
      setSelectedMemberId(message.sender.memberId);
      setSelectedThreadId(message.sender.origin.threadId);
      openCompactThreadDetails();
    } else {
      const mentionedAgent = message.mentions
        .map((mention) => members.find((member) => member.memberId === mention.memberId))
        .find((member) => member?.origin);
      if (mentionedAgent?.origin) {
        setSelectedMemberId(mentionedAgent.memberId);
        setSelectedThreadId(mentionedAgent.origin.threadId);
        openCompactThreadDetails();
      }
    }
  }

  const inspector = (
    <ProjectChatInspector
      activeTab={activeTab}
      members={members}
      mentionError={mentionError}
      mentionMessages={mentionMessages}
      messages={messages}
      now={now}
      onSelectMember={selectMember}
      onSelectMessage={selectMessage}
      onSelectTab={setActiveTab}
      onSelectThread={selectThread}
      selectedMemberId={selectedMemberId}
      selectedThreadId={selectedThreadId}
      onRetryMention={onRetryMention}
      unreadMentionCount={unreadMentionCount}
    />
  );

  return (
    <div className="relative grid h-full min-h-0 grid-cols-[176px_minmax(0,1fr)] overflow-hidden bg-[#080808] text-neutral-100 max-[719px]:grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[176px_minmax(0,1fr)_236px] min-[1360px]:grid-cols-[176px_minmax(0,1fr)_236px_278px]">
      <div className="contents" inert={inspectorOpen || undefined}>
        <ProjectChatSidebar messageCount={messages.length} now={now} viewer={viewer} />

      <section className="flex min-h-0 min-w-0 flex-col bg-neutral-950/25">
        <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800/80 px-4 sm:px-5">
          <Hash className="size-4 shrink-0 text-neutral-400" strokeWidth={1.8} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Text as="h1" className="truncate text-sm font-semibold text-neutral-100">{channel.displayName}</Text>
              <span className="border border-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-[0.12em] text-neutral-400">
                Append only
              </span>
            </div>
            <Text className="mt-0.5 block truncate text-[11px] text-neutral-400">{channel.description}</Text>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-1.5 text-[10px] text-neutral-400 sm:flex">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              {activeAgentCount} active {activeAgentCount === 1 ? 'agent' : 'agents'}
            </span>
            <Button
              aria-label="Open Project Chat details"
              isIconOnly
              onPress={openInspector}
              size="sm"
              variant="ghost"
              className="size-8 min-h-0 min-[1100px]:hidden"
            >
              <PanelRight className="size-4" />
            </Button>
          </div>
        </header>

        <ProjectChatFeed
          errorMessage={errorMessage}
          members={members}
          messages={messages}
          now={now}
          onRetry={onRetry}
          onSelectMessage={selectMessage}
          state={connectionState}
          viewerMemberId={viewer?.memberId}
        />
        <ProjectChatComposer
          disabled={connectionState !== 'ready'}
          onSend={onSend}
          viewerName={viewer?.displayName}
          viewerRole={viewer?.role === 'agent' ? 'Agent' : viewer?.role === 'system' ? 'System' : 'Human'}
        />
      </section>

      <div className="hidden min-h-0 min-[1100px]:block">{inspector}</div>
      <div className="hidden min-h-0 min-[1360px]:block">
        <ProjectChatThreadDetails
          members={members}
          messages={messages}
          now={now}
          onOpenThread={onOpenThread}
          thread={selectedThread}
        />
      </div>
      </div>

      {inspectorOpen && typeof document !== 'undefined' ? createPortal((
        <div
          aria-label={compactDetailsOpen ? 'Project Chat thread details' : 'Project Chat activity'}
          aria-modal="true"
          className="fixed inset-0 z-[70] min-[1360px]:hidden"
          onKeyDown={handleDialogKeyDown}
          ref={dialogRef}
          role="dialog"
          tabIndex={-1}
        >
          <button
            aria-hidden="true"
            aria-label="Close Project Chat details"
            className="absolute inset-0 bg-black/65"
            onClick={closeInspector}
            tabIndex={-1}
            type="button"
          />
          <div className="absolute inset-y-0 right-0 w-[min(22rem,92vw)] bg-neutral-950 shadow-2xl shadow-black">
            {compactDetailsOpen && selectedThread ? (
              <ProjectChatThreadDetails
                members={members}
                messages={messages}
                now={now}
                onBack={() => setCompactDetailsOpen(false)}
                onClose={closeInspector}
                onOpenThread={onOpenThread}
                thread={selectedThread}
              />
            ) : (
              <>
                {inspector}
                <Button
                  aria-label="Close Project Chat details"
                  isIconOnly
                  onPress={closeInspector}
                  size="sm"
                  variant="ghost"
                  className="absolute right-2 top-2 size-8 min-h-0"
                >
                  <X className="size-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}
