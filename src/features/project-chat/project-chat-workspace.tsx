import { useCallback, useEffect, useRef, useState } from 'react';
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
  runProjectChatProfileMutation,
  type ProjectChatProfileGenerationGuard
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
  onOpenThread
}: {
  client: ProjectChatClient;
  onOpenThread?: ProjectChatPageProps['onOpenThread'];
}) {
  const [channel, setChannel] = useState<ProjectChatChannelRecord>({
    channelId: PROJECT_CHAT_GENERAL_CHANNEL_ID,
    description: 'Shared coordination stream for people and agents',
    displayName: 'general'
  });
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
      } = await loadInitialProjectChat(client);
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
  }, [client, profileGeneration]);

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
      connectionState={connectionState}
      errorMessage={errorMessage}
      members={members}
      mentionMessages={mentionMessages}
      messages={messages}
      mentionError={mentionError}
      onAcknowledgeMention={requestMentionAcknowledge}
      onClaimAgentName={viewer?.role === 'agent' ? claimAgentName : undefined}
      onOpenThread={onOpenThread}
      onRetry={() => void load()}
      onRetryMention={failedAcknowledgeSequence === undefined
        ? undefined
        : () => requestMentionAcknowledge(failedAcknowledgeSequence)}
      onSend={send}
      onUpdateProfile={updateProfile}
      profile={profile}
      registryEntries={registryEntries}
      registryParentThreads={members.flatMap((member) => {
        const identity = projectChatAgentNameIdentity(member);
        return member.role === 'agent' && identity?.category === 'mythology' && member.origin?.threadId
          ? [{ displayName: identity.displayName, threadId: member.origin.threadId }]
          : [];
      })}
      unreadMentionCount={unreadMentionCount}
      viewer={viewer}
    />
  );
}
