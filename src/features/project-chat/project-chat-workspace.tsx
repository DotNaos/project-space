import { useCallback, useEffect, useRef, useState } from 'react';
import { ProjectChatRequestError } from '@/api/project-chat-client';
import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  type ProjectChatChannelRecord,
  type ProjectChatClient,
  type ProjectChatMemberRecord,
  type ProjectChatMessageRecord
} from '@/shared/project-chat-api';
import {
  cursorAfterLocalSend,
  loadInitialProjectChat,
  mergeVisibleProjectChatMessages,
  readProjectChatPages
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
  const [unreadMentionCount, setUnreadMentionCount] = useState(0);
  const [viewer, setViewer] = useState<ProjectChatMemberRecord>();
  const latestSequenceRef = useRef(0);

  const load = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setConnectionState('offline');
      return;
    }

    setErrorMessage('');
    try {
      const { joinResult, readResult, memberResult, mentionResult } = await loadInitialProjectChat(client);
      setChannel(joinResult.channel);
      setViewer(joinResult.member);
      setMessages(mergeVisibleProjectChatMessages([], readResult.messages));
      latestSequenceRef.current = Math.max(latestSequenceRef.current, readResult.nextSequence);
      setMembers(memberResult.members);
      setMentionMessages(mergeVisibleProjectChatMessages([], mentionResult.messages));
      setUnreadMentionCount(mentionResult.unreadCount);
      setConnectionState('ready');
    } catch (error) {
      setConnectionState(connectionStateForFailure(error));
      setErrorMessage(error instanceof Error ? error.message : 'Project Chat could not be loaded.');
    }
  }, [client]);

  const refresh = useCallback(async () => {
    try {
      const refreshedViewer = await client.updatePresence({ state: 'working' });
      const [readResult, memberResult, mentionResult] = await Promise.all([
        readProjectChatPages(client, channel.channelId, latestSequenceRef.current),
        client.listMembers(),
        client.listMentions({ channelId: channel.channelId, limit: 50 })
      ]);
      setMessages((current) => mergeVisibleProjectChatMessages(current, readResult.messages));
      latestSequenceRef.current = Math.max(latestSequenceRef.current, readResult.nextSequence);
      setMembers(memberResult.members);
      setMentionMessages(mergeVisibleProjectChatMessages([], mentionResult.messages));
      setUnreadMentionCount(mentionResult.unreadCount);
      setViewer(refreshedViewer);
      setConnectionState('ready');
      setErrorMessage('');
    } catch (error) {
      setConnectionState(connectionStateForFailure(error));
      setErrorMessage(error instanceof Error ? error.message : 'Project Chat could not be refreshed.');
    }
  }, [channel.channelId, client]);

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
      unreadMentionCount={unreadMentionCount}
      viewer={viewer}
    />
  );
}
