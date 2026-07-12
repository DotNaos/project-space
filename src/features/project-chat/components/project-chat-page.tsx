import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Hash, MessageSquareText, PanelRight, Tags, X } from 'lucide-react';
import { Button, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatChannelRecord,
  ProjectChatHumanProfileRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatProfileUpdateRequest,
  ProjectChatProfileUpdateResult
} from '@/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  projectChatThreads,
  type ProjectChatThreadSummary
} from '../project-chat-model';
import { ProjectChatComposer } from './project-chat-composer';
import { ProjectChatFeed, type ProjectChatConnectionState } from './project-chat-feed';
import { ProjectChatProfileDrawer } from './project-chat-profile-drawer';
import {
  ProjectChatNameRegistry,
  type ProjectChatNameRegistryEntry,
  type ProjectChatNameParentThread
} from './project-chat-name-registry';
import type { ProjectChatAgentAvatarCategory } from '../project-chat-agent-avatar';
import {
  ProjectChatInspector,
  type ProjectChatInspectorTab
} from './project-chat-inspector';
import { ProjectChatSidebar } from './project-chat-sidebar';
import { ProjectChatChannelList } from './project-chat-sidebar';
import { ProjectChatThreadDetails } from './project-chat-thread-details';

export interface ProjectChatPageProps {
  channel: ProjectChatChannelRecord;
  channels?: ProjectChatChannelRecord[];
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
  onClaimAgentName?(entry: ProjectChatNameRegistryEntry, parentThreadId?: string): Promise<void>;
  onSelectChannel?(channel: ProjectChatChannelRecord): void;
  onUpdateProfile?(request: ProjectChatProfileUpdateRequest): Promise<ProjectChatProfileUpdateResult>;
  profile?: ProjectChatHumanProfileRecord;
  registryAllowedCategory?: ProjectChatAgentAvatarCategory;
  registryEntries?: ProjectChatNameRegistryEntry[];
  registryParentThreads?: ProjectChatNameParentThread[];
  recentProjectIds?: string[];
  showChannelNavigation?: boolean;
  unreadMentionCount?: number;
  viewer?: ProjectChatMemberRecord;
}

export function ProjectChatPage({
  channel,
  channels = [channel],
  connectionState = 'ready',
  errorMessage,
  members,
  mentionError,
  mentionMessages = [],
  messages,
  now = new Date(),
  onAcknowledgeMention,
  onClaimAgentName,
  onSelectChannel,
  onOpenThread,
  onRetry,
  onRetryMention,
  onSend,
  onUpdateProfile,
  profile,
  registryAllowedCategory,
  registryEntries = [],
  registryParentThreads = [],
  recentProjectIds = [],
  showChannelNavigation = true,
  unreadMentionCount = 0,
  viewer
}: ProjectChatPageProps) {
  const threads = useMemo(() => projectChatThreads(messages, members), [members, messages]);
  const [activeTab, setActiveTab] = useState<ProjectChatInspectorTab>('mentions');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compactDetailsOpen, setCompactDetailsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [registryOpen, setRegistryOpen] = useState(false);
  const [channelDrawerOpen, setChannelDrawerOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const channelDrawerRef = useRef<HTMLDivElement>(null);
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
    if (!channelDrawerOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    channelDrawerRef.current?.focus();
    return () => previouslyFocused?.focus();
  }, [channelDrawerOpen]);

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

  function openProfile() {
    if (!profile || viewer?.role !== 'human' || !onUpdateProfile) {
      return;
    }
    closeInspector();
    setProfileOpen(true);
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

  function handleChannelDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setChannelDrawerOpen(false);
      return;
    }
    if (event.key !== 'Tab' || !channelDrawerRef.current) return;
    const focusable = [...channelDrawerRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    )];
    if (focusable.length === 0) return;
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
    <div className={showChannelNavigation
      ? 'relative grid h-full min-h-0 grid-cols-[224px_minmax(0,1fr)] overflow-hidden bg-[#080808] text-neutral-100 max-[719px]:grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[224px_minmax(0,1fr)_236px] min-[1360px]:grid-cols-[224px_minmax(0,1fr)_236px_278px]'
      : 'relative grid h-full min-h-0 grid-cols-[minmax(0,1fr)] overflow-hidden bg-[#080808] text-neutral-100 min-[1100px]:grid-cols-[minmax(0,1fr)_236px] min-[1360px]:grid-cols-[minmax(0,1fr)_236px_278px]'}>
      <div className="contents" inert={inspectorOpen || profileOpen || registryOpen || channelDrawerOpen || undefined}>
        {showChannelNavigation && onSelectChannel ? (
          <ProjectChatSidebar
            channels={channels}
            now={now}
            onEditProfile={openProfile}
            onSelectChannel={onSelectChannel}
            recentProjectIds={recentProjectIds}
            selectedChannelId={channel.channelId}
            viewer={viewer}
          />
        ) : null}

      <section className="flex min-h-0 min-w-0 flex-col bg-neutral-950/25">
        <header className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800/80 px-4 sm:px-5">
          {showChannelNavigation ? (
            <button
              aria-label="Open project room list"
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-neutral-900 min-[720px]:hidden"
              onClick={() => setChannelDrawerOpen(true)}
              type="button"
            >
              <Hash className="size-4 shrink-0 text-neutral-400" strokeWidth={1.8} />
              <ChevronDown className="size-3.5 shrink-0 text-neutral-500" />
            </button>
          ) : null}
          {showChannelNavigation ? (
            <Hash className="hidden size-4 shrink-0 text-neutral-400 min-[720px]:block" strokeWidth={1.8} />
          ) : (
            <Hash className="size-4 shrink-0 text-neutral-400" strokeWidth={1.8} />
          )}
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
            {registryEntries.length > 0 ? (
              <Button
                aria-label="Open agent name registry"
                className="size-8 min-h-0"
                isIconOnly
                onPress={() => {
                  closeInspector();
                  setProfileOpen(false);
                  setRegistryOpen(true);
                }}
                size="sm"
                variant="ghost"
              >
                <Tags className="size-4" />
              </Button>
            ) : null}
          </div>
        </header>

        <ProjectChatFeed
          channelName={channel.displayName}
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
          channelName={channel.displayName}
          disabled={connectionState !== 'ready'}
          onEditProfile={profile && viewer?.role === 'human' ? openProfile : undefined}
          onSend={onSend}
          viewerName={viewer?.displayName}
          viewerRole="Human"
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

      {channelDrawerOpen && showChannelNavigation && onSelectChannel && typeof document !== 'undefined'
        ? createPortal((
          <div
            aria-label="Project Chat rooms"
            aria-modal="true"
            className="fixed inset-0 z-[80] min-[720px]:hidden"
            onKeyDown={handleChannelDrawerKeyDown}
            ref={channelDrawerRef}
            role="dialog"
            tabIndex={-1}
          >
            <button
              aria-hidden="true"
              className="absolute inset-0 bg-black/70"
              onClick={() => setChannelDrawerOpen(false)}
              tabIndex={-1}
              type="button"
            />
            <div className="absolute inset-y-0 left-0 flex w-[min(21rem,92vw)] flex-col border-r border-neutral-800 bg-neutral-950 shadow-2xl shadow-black">
              <div className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800 px-4">
                <span className="grid size-8 place-items-center rounded-lg bg-neutral-100 text-neutral-950">
                  <MessageSquareText className="size-4" />
                </span>
                <Text className="text-sm font-semibold text-neutral-100">Project Chat</Text>
                <Button
                  aria-label="Close project room list"
                  className="ml-auto size-8 min-h-0"
                  isIconOnly
                  onPress={() => setChannelDrawerOpen(false)}
                  size="sm"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <ProjectChatChannelList
                channels={channels}
                onSelectChannel={(nextChannel) => {
                  setChannelDrawerOpen(false);
                  onSelectChannel(nextChannel);
                }}
                recentProjectIds={recentProjectIds}
                selectedChannelId={channel.channelId}
              />
            </div>
          </div>
        ), document.body)
        : null}
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
      {onUpdateProfile ? (
        <ProjectChatProfileDrawer
          onClose={() => setProfileOpen(false)}
          onSave={onUpdateProfile}
          open={profileOpen}
          profile={profile}
        />
      ) : null}
      <ProjectChatNameRegistry
        allowedCategory={registryAllowedCategory}
        entries={registryEntries}
        onClaim={onClaimAgentName}
        onClose={() => setRegistryOpen(false)}
        open={registryOpen}
        parentThreads={registryParentThreads}
      />
    </div>
  );
}
