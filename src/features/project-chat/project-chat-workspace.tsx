import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Hash } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import { ProjectChatRequestError } from '@/api/project-chat-client';
import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  type ProjectChatChannelRecord,
  type ProjectChatClient,
  type ProjectChatHumanProfileRecord,
  type ProjectChatMemberRecord,
  type ProjectChatMessageRecord,
  type ProjectChatNameEntry,
  type ProjectChatProfileUpdateRequest
} from '@/shared/project-chat-api';
import {
  createProjectChatProfileGenerationGuard,
  projectChatAgentNameIdentity,
  projectChatIdentitySnapshot,
  reconcileProjectChatMemberTaskTitles,
  reconcileProjectChatMessageTaskTitles,
  runProjectChatProfileMutation,
  type ProjectChatProfileGenerationGuard,
  type ProjectChatTaskTitle
} from './project-chat-model';
import {
  cursorAfterLocalSend,
  loadInitialProjectChat,
  mergeVisibleProjectChatMessages,
  refreshProjectChat
} from './project-chat-loading';
import {
  ProjectChatPage,
  type ProjectChatPageProps
} from './components/project-chat-page';
import type { ProjectChatConnectionState } from './components/project-chat-feed';
import type { ProjectChatNameRegistryEntry } from './components/project-chat-name-registry';
import { parseProjectChatRoute, projectChatRoute } from './project-chat-route';
import { ProjectChatSidebar } from './components/project-chat-sidebar';

function registryEntry(entry: ProjectChatNameEntry): ProjectChatNameRegistryEntry {
  return {
    category: entry.category,
    claimedByDisplayName: entry.displayName,
    claimedByThreadId: entry.claimedByThreadId,
    name: entry.name,
    status: entry.state
  };
}

async function loadRegistryEntries(client: ProjectChatClient) {
  try {
    const result = await client.listNames();
    return result.groups.flatMap((group) => group.names.map(registryEntry));
  } catch {
    return undefined;
  }
}

function createIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `project-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function connectionStateForFailure(error: unknown): ProjectChatConnectionState {
  if (error instanceof ProjectChatRequestError && [401, 403].includes(error.status)) {
    return 'denied';
  }

  if (
    (typeof navigator !== 'undefined' && !navigator.onLine) ||
    error instanceof TypeError
  ) {
    return 'offline';
  }

  return 'error';
}

export function ProjectChatWorkspace({
  client,
  defaultProjectId,
  fixedProjectId,
  onOpenThread,
  recentProjectIds = [],
  showChannelNavigation = fixedProjectId === undefined,
  syncRoute = fixedProjectId === undefined,
  taskTitles = [],
  taskPreview,
  threadDirectory
}: {
  client: ProjectChatClient;
  /** Room to open on first render. Unlike `fixedProjectId` it can be left. */
  defaultProjectId?: string;
  /** Restricts the workspace to a single room and hides every other one. */
  fixedProjectId?: string;
  onOpenThread?: ProjectChatPageProps['onOpenThread'];
  recentProjectIds?: string[];
  showChannelNavigation?: boolean;
  /** Whether switching rooms writes the `/chat` route. */
  syncRoute?: boolean;
  taskTitles?: readonly ProjectChatTaskTitle[];
  taskPreview?: ReactNode;
  threadDirectory?: ReactNode;
}) {
  const initialRoute = typeof window === 'undefined'
    ? { matches: true as const, projectId: undefined }
    : parseProjectChatRoute(window.location.pathname);
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => fixedProjectId ?? (syncRoute ? initialRoute.projectId : defaultProjectId)
  );
  const appliedDefaultProjectId = useRef(defaultProjectId);
  const [channels, setChannels] = useState<ProjectChatChannelRecord[]>([]);
  const [channelError, setChannelError] = useState('');
  const [channelsLoading, setChannelsLoading] = useState(true);

  const loadChannels = useCallback(async () => {
    setChannelsLoading(true);
    setChannelError('');
    try {
      if (fixedProjectId) {
        const result = await client.join({ projectId: fixedProjectId });
        setChannels([result.channel]);
      } else {
        await client.join();
        const result = await client.listChannels();
        setChannels(result.channels);
      }
    } catch (error) {
      setChannelError(error instanceof Error ? error.message : 'Project rooms could not be loaded.');
    } finally {
      setChannelsLoading(false);
    }
  }, [client, fixedProjectId]);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (fixedProjectId) setSelectedProjectId(fixedProjectId);
  }, [fixedProjectId]);

  // `defaultProjectId` only seeds the first render, so a later workspace project
  // switch has to move the room too. Comparing against the last applied default
  // keeps a room the reader picked themselves.
  useEffect(() => {
    if (fixedProjectId || appliedDefaultProjectId.current === defaultProjectId) return;
    appliedDefaultProjectId.current = defaultProjectId;
    setSelectedProjectId(defaultProjectId);
  }, [defaultProjectId, fixedProjectId]);

  useEffect(() => {
    if (!syncRoute || typeof window === 'undefined') return;
    const handlePopState = () => {
      const route = parseProjectChatRoute(window.location.pathname);
      if (route.matches) setSelectedProjectId(route.projectId);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [syncRoute]);

  const generalChannel = channels.find((channel) => channel.kind === 'general');
  const projectChannel = selectedProjectId
    ? channels.find((channel) => channel.projectId === selectedProjectId)
    : undefined;
  // Opening a project that has no room of its own — a Codex thread's project, for
  // instance — should land in the lobby rather than on a dead end.
  const selectedChannel = selectedProjectId
    ? projectChannel ?? (fixedProjectId ? undefined : generalChannel)
    : generalChannel;

  function selectChannel(channel: ProjectChatChannelRecord) {
    const projectId = channel.kind === 'project' ? channel.projectId : undefined;
    setSelectedProjectId(projectId);
    if (syncRoute && typeof window !== 'undefined') {
      const nextPath = projectChatRoute(projectId);
      window.history.pushState(
        null,
        '',
        `${nextPath}${window.location.search}${window.location.hash}`
      );
    }
  }

  if (!selectedChannel) {
    return (
      <div className={`grid h-full min-h-0 overflow-hidden text-neutral-100 ${
        showChannelNavigation && channels.length > 0
          ? 'grid-cols-[224px_minmax(0,1fr)] max-[719px]:grid-cols-[minmax(0,1fr)]'
          : 'grid-cols-[minmax(0,1fr)]'
      }`}>
        {showChannelNavigation && channels.length > 0 ? (
          <ProjectChatSidebar
            channels={channels}
            now={new Date()}
            onSelectChannel={selectChannel}
            recentProjectIds={recentProjectIds}
            selectedChannelId=""
          />
        ) : null}
        <div className={`flex min-h-0 flex-col ${showChannelNavigation ? 'px-4 sm:px-6' : ''}`}>
          <header className="shrink-0 border-b border-neutral-800/70 pb-4 pt-1">
            <Text as="h1" className="block text-2xl font-semibold tracking-[-.02em] text-neutral-50">
              Chat
            </Text>
          </header>
          <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
            <div className="max-w-sm">
              <Hash className="mx-auto size-6 text-neutral-700" strokeWidth={1.6} />
              <Text className="mt-3 block text-sm font-medium text-neutral-300">
                {channelsLoading ? 'Opening project room…' : 'Project room unavailable'}
              </Text>
              <Text className="mt-1 block text-sm leading-6 text-neutral-500">
                {channelsLoading
                  ? 'Checking the room and its project access.'
                  : channelError || 'This project is no longer available to this account.'}
              </Text>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <ProjectChatRoomWorkspace
      channel={selectedChannel}
      channels={channels}
      client={client}
      key={selectedChannel.channelId}
      onOpenThread={onOpenThread}
      onSelectChannel={fixedProjectId ? undefined : selectChannel}
      projectId={selectedChannel.projectId}
      recentProjectIds={recentProjectIds}
      showChannelNavigation={showChannelNavigation}
      taskTitles={taskTitles}
      taskPreview={taskPreview}
      threadDirectory={threadDirectory}
    />
  );
}

function ProjectChatRoomWorkspace({
  channel: initialChannel,
  channels,
  client,
  onOpenThread,
  onSelectChannel,
  projectId,
  recentProjectIds,
  showChannelNavigation,
  taskTitles,
  taskPreview,
  threadDirectory
}: {
  channel: ProjectChatChannelRecord;
  channels: ProjectChatChannelRecord[];
  client: ProjectChatClient;
  onOpenThread?: ProjectChatPageProps['onOpenThread'];
  onSelectChannel?: (channel: ProjectChatChannelRecord) => void;
  projectId?: string;
  recentProjectIds: string[];
  showChannelNavigation: boolean;
  taskTitles: readonly ProjectChatTaskTitle[];
  taskPreview?: ReactNode;
  threadDirectory?: ReactNode;
}) {
  const [channel, setChannel] = useState<ProjectChatChannelRecord>(initialChannel);
  const [connectionState, setConnectionState] = useState<ProjectChatConnectionState>('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [members, setMembers] = useState<ProjectChatMemberRecord[]>([]);
  const [mentionMessages, setMentionMessages] = useState<ProjectChatMessageRecord[]>([]);
  const [mentionError, setMentionError] = useState('');
  const [failedAcknowledgeSequence, setFailedAcknowledgeSequence] = useState<number>();
  const [messages, setMessages] = useState<ProjectChatMessageRecord[]>([]);
  const [profile, setProfile] = useState<ProjectChatHumanProfileRecord>();
  const [registryEntries, setRegistryEntries] = useState<ProjectChatNameRegistryEntry[]>([]);
  const [unreadMentionCount, setUnreadMentionCount] = useState(0);
  const [viewer, setViewer] = useState<ProjectChatMemberRecord>();
  const profileGenerationRef = useRef<ProjectChatProfileGenerationGuard | null>(null);
  if (!profileGenerationRef.current) {
    profileGenerationRef.current = createProjectChatProfileGenerationGuard();
  }
  const profileGeneration = profileGenerationRef.current;
  const latestSequenceRef = useRef(0);
  const displayedMembers = useMemo(
    () => reconcileProjectChatMemberTaskTitles(members, taskTitles),
    [members, taskTitles]
  );
  const displayedMentionMessages = useMemo(
    () => reconcileProjectChatMessageTaskTitles(mentionMessages, taskTitles),
    [mentionMessages, taskTitles]
  );
  const displayedMessages = useMemo(
    () => reconcileProjectChatMessageTaskTitles(messages, taskTitles),
    [messages, taskTitles]
  );

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setConnectionState('offline');
      return;
    }

    const refreshGeneration = profileGeneration.captureRefresh();
    setErrorMessage('');
    try {
      const {
        joinResult,
        readResult,
        memberResult,
        mentionResult,
        profileResult
      } = await loadInitialProjectChat(client, projectId);
      setChannel(joinResult.channel);
      setMessages(mergeVisibleProjectChatMessages([], readResult.messages));
      latestSequenceRef.current = Math.max(latestSequenceRef.current, readResult.nextSequence);
      setMentionMessages(mergeVisibleProjectChatMessages([], mentionResult.messages));
      setUnreadMentionCount(mentionResult.unreadCount);
      if (profileGeneration.canApplyRefresh(refreshGeneration, profileResult.profile.revision)) {
        const identity = projectChatIdentitySnapshot(
          joinResult.member,
          memberResult.members,
          profileResult.profile
        );
        setViewer(identity.viewer);
        setMembers(identity.members);
        setProfile(profileResult.profile);
      }
      setRegistryEntries(await loadRegistryEntries(client) ?? []);
      setConnectionState('ready');
    } catch (error) {
      setConnectionState(connectionStateForFailure(error));
      setErrorMessage(error instanceof Error ? error.message : 'Project Chat could not be loaded.');
    }
  }, [client, profileGeneration, projectId]);

  const refresh = useCallback(async (minimumProfileRevision = 0) => {
    const refreshGeneration = profileGeneration.captureRefresh();
    try {
      const {
        memberResult,
        mentionResult,
        profileResult,
        readResult,
        refreshedViewer
      } = await refreshProjectChat(client, channel.channelId, latestSequenceRef.current);
      const identity = projectChatIdentitySnapshot(
        refreshedViewer,
        memberResult.members,
        profileResult.profile
      );
      setMessages((current) => mergeVisibleProjectChatMessages(current, readResult.messages));
      latestSequenceRef.current = Math.max(latestSequenceRef.current, readResult.nextSequence);
      setMentionMessages(mergeVisibleProjectChatMessages([], mentionResult.messages));
      setUnreadMentionCount(mentionResult.unreadCount);
      const authoritativeProfile = profileResult.profile.revision >= minimumProfileRevision;
      const canApplyIdentity = authoritativeProfile && profileGeneration.canApplyRefresh(
        refreshGeneration,
        profileResult.profile.revision
      );
      if (canApplyIdentity) {
        setMembers(identity.members);
        setProfile(profileResult.profile);
        setViewer(identity.viewer);
      }
      const refreshedNames = await loadRegistryEntries(client);
      if (refreshedNames) setRegistryEntries(refreshedNames);
      setConnectionState('ready');
      setErrorMessage('');
      return authoritativeProfile;
    } catch (error) {
      setConnectionState(connectionStateForFailure(error));
      setErrorMessage(error instanceof Error ? error.message : 'Project Chat could not be refreshed.');
      return !profileGeneration.isRefreshCurrent(refreshGeneration);
    }
  }, [channel.channelId, client, profileGeneration]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const markOffline = () => setConnectionState('offline');
    const markOnline = () => void load();
    window.addEventListener('offline', markOffline);
    window.addEventListener('online', markOnline);
    return () => {
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('online', markOnline);
    };
  }, [load]);

  useEffect(() => {
    if (connectionState !== 'ready') {
      return;
    }
    return client.subscribe({
      afterSequence: latestSequenceRef.current,
      channelId: channel.channelId
    }, (message) => {
      setMessages((current) => mergeVisibleProjectChatMessages(current, [message]));
      latestSequenceRef.current = Math.max(latestSequenceRef.current, message.sequence);
      setConnectionState('ready');
      setErrorMessage('');
    }, (error) => {
      setErrorMessage(error instanceof Error ? error.message : 'Live Project Chat disconnected.');
    });
  }, [channel.channelId, client, connectionState]);

  async function send(body: string) {
    const result = await client.send({
      body,
      channelId: channel.channelId,
      idempotencyKey: createIdempotencyKey()
    });
    setMessages((current) => mergeVisibleProjectChatMessages(current, [result.message]));
    latestSequenceRef.current = cursorAfterLocalSend(
      latestSequenceRef.current,
      result.message.sequence
    );
  }

  async function updateProfile(request: ProjectChatProfileUpdateRequest) {
    const { applyResult, result } = await runProjectChatProfileMutation(
      profileGeneration,
      () => client.updateProfile(request),
      (result) => refresh(result?.profile.revision)
    );
    if (applyResult && profileGeneration.acceptProfileRevision(result.profile.revision)) {
      setProfile(result.profile);
      setViewer(result.member);
      setMembers((current) => {
        const found = current.some((member) => member.memberId === result.member.memberId);
        return found
          ? current.map((member) => member.memberId === result.member.memberId
              ? result.member
              : member)
          : [...current, result.member];
      });
    }
    return result;
  }

  async function claimAgentName(entry: ProjectChatNameRegistryEntry, parentThreadId?: string) {
    if (entry.category === 'gradient') {
      throw new Error('Gradient avatars are a visual variant and cannot be claimed as a role name.');
    }
    if (entry.category !== 'mythology' && !parentThreadId?.trim()) {
      throw new Error('A specialist name requires its main agent thread ID.');
    }
    const result = await client.claimName({
      category: entry.category === 'scientist' ? 'science' : entry.category,
      name: entry.name,
      ...(entry.category === 'mythology' ? {} : { parentThreadId: parentThreadId!.trim() })
    });
    setViewer((current) => current?.memberId === result.member.memberId ? result.member : current);
    setMembers((current) => current.some((member) => member.memberId === result.member.memberId)
      ? current.map((member) => member.memberId === result.member.memberId ? result.member : member)
      : [...current, result.member]);
    const names = await client.listNames();
    setRegistryEntries(names.groups.flatMap((group) => group.names.map(registryEntry)));
  }

  async function acknowledgeMention(throughSequence: number) {
    await client.acknowledge({ channelId: channel.channelId, throughSequence });
    const mentionResult = await client.listMentions({ channelId: channel.channelId, limit: 50 });
    setMentionMessages(mergeVisibleProjectChatMessages([], mentionResult.messages));
    setUnreadMentionCount(mentionResult.unreadCount);
  }

  function requestMentionAcknowledge(throughSequence: number) {
    setMentionError('');
    setFailedAcknowledgeSequence(undefined);
    void acknowledgeMention(throughSequence)
      .then(() => {
        setMentionError('');
        setFailedAcknowledgeSequence(undefined);
      })
      .catch(() => {
        setMentionError('The mention could not be marked as read.');
        setFailedAcknowledgeSequence(throughSequence);
      });
  }

  return (
    <ProjectChatPage
      channel={channel}
      channels={channels}
      connectionState={connectionState}
      errorMessage={errorMessage}
      members={displayedMembers}
      mentionMessages={displayedMentionMessages}
      messages={displayedMessages}
      mentionError={mentionError}
      onAcknowledgeMention={requestMentionAcknowledge}
      onClaimAgentName={viewer?.role === 'agent' ? claimAgentName : undefined}
      onOpenThread={onOpenThread}
      onSelectChannel={onSelectChannel}
      onRetry={() => void load()}
      onRetryMention={failedAcknowledgeSequence === undefined
        ? undefined
        : () => requestMentionAcknowledge(failedAcknowledgeSequence)}
      onSend={send}
      onUpdateProfile={updateProfile}
      profile={profile}
      registryEntries={registryEntries}
      registryParentThreads={displayedMembers.flatMap((member) => {
        const identity = projectChatAgentNameIdentity(member);
        return member.role === 'agent' && identity?.category === 'mythology' && member.origin?.threadId
          ? [{ displayName: identity.displayName, threadId: member.origin.threadId }]
          : [];
      })}
      recentProjectIds={recentProjectIds}
      showChannelNavigation={showChannelNavigation}
      taskPreview={taskPreview}
      threadDirectory={threadDirectory}
      unreadMentionCount={unreadMentionCount}
      viewer={viewer}
    />
  );
}
