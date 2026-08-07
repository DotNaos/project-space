import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react';
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
  projectChatThreadKey,
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
import type { CodexSessionTarget } from '../../codex-sessions/codex-session-route';

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
  onOpenThread?(target: CodexSessionTarget): void;
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
  taskPreview?: ReactNode;
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
  taskPreview,
  unreadMentionCount = 0,
  viewer
}: ProjectChatPageProps) {
  const threads = useMemo(() => projectChatThreads(messages, members), [members, messages]);
  // The left rail already lists rooms on the standalone route, so the panel
  // only takes that job over when it is the page's single navigation surface.
  const roomSwitcher = showChannelNavigation ? undefined : onSelectChannel;
  const [activeTab, setActiveTab] = useState<ProjectChatInspectorTab>(
    () => roomSwitcher && channels.length > 1 ? 'rooms' : 'mentions'
  );
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
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | undefined>(
    () => initialThread?.id
  );
  const selectedThread = threads.find((thread) => thread.id === selectedThreadKey);
  const activeAgentCount = members.filter(
    (member) => member.role === 'agent' && effectiveProjectChatPresence(member, now) === 'working'
  ).length;
  /**
   * The panel earns its column once it can navigate somewhere: other rooms to
   * open, agents to connect to, or mentions and threads to follow. A quiet room
   * with a single pinned channel keeps the full width for the conversation.
   */
  const canSwitchRooms = Boolean(roomSwitcher) && channels.length > 1;
  const hasInspectorContent = canSwitchRooms ||
    mentionMessages.length > 0 ||
    threads.length > 0 ||
    members.some((member) => member.role === 'agent');
  const reservesInspectorColumn = hasInspectorContent;
  const reservesThreadColumn = hasInspectorContent && Boolean(selectedThread);
  const gridColumns = showChannelNavigation
    ? reservesThreadColumn
      ? 'grid-cols-[224px_minmax(0,1fr)] max-[719px]:grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[224px_minmax(0,1fr)_268px] min-[1360px]:grid-cols-[224px_minmax(0,1fr)_268px_278px]'
      : reservesInspectorColumn
        ? 'grid-cols-[224px_minmax(0,1fr)] max-[719px]:grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[224px_minmax(0,1fr)_268px]'
        : 'grid-cols-[224px_minmax(0,1fr)] max-[719px]:grid-cols-[minmax(0,1fr)]'
    : reservesThreadColumn
      ? 'grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[minmax(0,1fr)_268px] min-[1360px]:grid-cols-[minmax(0,1fr)_268px_278px]'
      : reservesInspectorColumn
        ? 'grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[minmax(0,1fr)_268px]'
        : 'grid-cols-[minmax(0,1fr)]';

  useEffect(() => {
    const currentThread = threads.find((thread) => thread.id === selectedThreadKey);
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
      setSelectedThreadKey(nextThread.id);
      return;
    }

    const nextMember = members.find((member) => member.role === 'agent');
    setSelectedMemberId(nextMember?.memberId);
    setSelectedThreadKey(undefined);
  }, [members, selectedMemberId, selectedThreadKey, threads]);

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
    // The overlay only duplicates what the reserved columns already show.
    if (!reservesThreadColumn) return;
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
  }, [reservesThreadColumn]);

  function usesCompactDetails() {
    return !reservesThreadColumn ||
      (typeof window !== 'undefined' && window.matchMedia('(max-width: 1359px)').matches);
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
    setSelectedThreadKey(thread.id);
    setSelectedMemberId(thread.memberId);
    openCompactThreadDetails();
  }

  function selectMember(memberId: string) {
    setSelectedMemberId(memberId);
    const memberThread = threads.find((thread) => thread.memberId === memberId);
    if (memberThread) {
      setSelectedThreadKey(memberThread.id);
      openCompactThreadDetails();
    } else {
      setSelectedThreadKey(undefined);
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
      setSelectedThreadKey(projectChatThreadKey(
        message.sender.origin.machineId,
        message.sender.origin.threadId
      ));
      openCompactThreadDetails();
    } else {
      const mentionedAgent = message.mentions
        .map((mention) => members.find((member) => member.memberId === mention.memberId))
        .find((member) => member?.origin);
      if (mentionedAgent?.origin) {
        setSelectedMemberId(mentionedAgent.memberId);
        setSelectedThreadKey(projectChatThreadKey(
          mentionedAgent.origin.machineId,
          mentionedAgent.origin.threadId
        ));
        openCompactThreadDetails();
      }
    }
  }

  const inspector = (
    <ProjectChatInspector
      activeTab={activeTab}
      channels={channels}
      members={members}
      mentionError={mentionError}
      mentionMessages={mentionMessages}
      messages={messages}
      now={now}
      canSwitchRooms={canSwitchRooms}
      onOpenThread={onOpenThread}
      onSelectChannel={roomSwitcher}
      onSelectMember={selectMember}
      onSelectMessage={selectMessage}
      onSelectTab={setActiveTab}
      onSelectThread={selectThread}
      recentProjectIds={recentProjectIds}
      selectedChannelId={channel.channelId}
      selectedMemberId={selectedMemberId}
      selectedThreadKey={selectedThreadKey}
      onRetryMention={onRetryMention}
      unreadMentionCount={unreadMentionCount}
    />
  );

  return (
    <div className={`relative grid h-full min-h-0 overflow-hidden text-neutral-100 ${gridColumns}`}>
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

      <section className={`flex min-h-0 min-w-0 flex-col ${showChannelNavigation ? 'px-4 sm:px-6' : ''}`}>
        <header className="flex shrink-0 flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-neutral-800/70 pb-4 pt-1">
          <div className="flex min-w-0 items-center gap-2">
            {showChannelNavigation ? (
              <button
                aria-label="Open project room list"
                className="flex shrink-0 items-center gap-1 rounded-lg py-1 text-left text-neutral-500 transition hover:text-neutral-200 min-[720px]:hidden"
                onClick={() => setChannelDrawerOpen(true)}
                type="button"
              >
                <Hash className="size-4" strokeWidth={1.8} />
                <ChevronDown className="size-3.5" />
              </button>
            ) : null}
            <div className="min-w-0">
              <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
                Chat
              </Text>
              <Text className="mt-1 block truncate text-sm text-neutral-500">
                #{channel.displayName} · {channel.description}
              </Text>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {taskPreview}
            {activeAgentCount > 0 ? (
              <span className="hidden items-center gap-1.5 text-[11px] text-neutral-500 sm:flex">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                {activeAgentCount} active {activeAgentCount === 1 ? 'agent' : 'agents'}
              </span>
            ) : null}
            {hasInspectorContent ? (
              <Button
                aria-label="Open Project Chat details"
                isIconOnly
                onPress={openInspector}
                size="sm"
                variant="ghost"
                className={`size-8 min-h-0 ${reservesInspectorColumn ? 'min-[1100px]:hidden' : ''}`}
              >
                <PanelRight className="size-4" />
              </Button>
            ) : null}
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

      {reservesInspectorColumn ? (
        <div className="hidden min-h-0 min-[1100px]:block">{inspector}</div>
      ) : null}
      {reservesThreadColumn ? (
        <div className="hidden min-h-0 min-[1360px]:block">
          <ProjectChatThreadDetails
            members={members}
            messages={messages}
            now={now}
            onOpenThread={onOpenThread}
            thread={selectedThread}
          />
        </div>
      ) : null}

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
          className={`fixed inset-0 z-[70] ${reservesThreadColumn ? 'min-[1360px]:hidden' : ''}`}
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
