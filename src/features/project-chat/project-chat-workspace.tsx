import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectChatRequestError } from '@/api/project-chat-client';
import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  type ProjectChatChannelRecord,
  type ProjectChatClient,
  type ProjectChatHumanProfileRecord,
  type ProjectChatMemberRecord,
  type ProjectChatMessageRecord,
  type ProjectChatProfileUpdateRequest
} from '@/shared/project-chat-api';
import {
  createProjectChatProfileGenerationGuard,
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
  onOpenThread,
  pollIntervalMs = 60_000
}: {
  client: ProjectChatClient;
  onOpenThread?: ProjectChatPageProps['onOpenThread'];
  pollIntervalMs?: number;
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
    if (connectionState === 'loading' || connectionState === 'denied') {
      return;
    }

    const timer = window.setInterval(
      () => void (connectionState === 'ready' ? refresh() : load()),
      pollIntervalMs
    );
    return () => window.clearInterval(timer);
  }, [connectionState, load, pollIntervalMs, refresh]);

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
      onOpenThread={onOpenThread}
      onRetry={() => void load()}
      onRetryMention={failedAcknowledgeSequence === undefined
        ? undefined
        : () => requestMentionAcknowledge(failedAcknowledgeSequence)}
      onSend={send}
      onUpdateProfile={updateProfile}
      profile={profile}
      unreadMentionCount={unreadMentionCount}
      viewer={viewer}
    />
  );
}
