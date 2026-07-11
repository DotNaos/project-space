import {
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  type ProjectChatClient,
  type ProjectChatChannelId,
  type ProjectChatJoinResult,
  type ProjectChatMemberListResult,
  type ProjectChatMentionListResult,
  type ProjectChatReadResult
} from '../../shared/project-chat-api';

const pageSize = 100;
export const PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT = 500;
const maximumPagesPerRefresh = Math.ceil(PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT / pageSize) + 2;

export function cursorAfterLocalSend(currentSequence: number, sentSequence: number) {
  return sentSequence === currentSequence + 1 ? sentSequence : currentSequence;
}

export function mergeVisibleProjectChatMessages(
  current: ProjectChatReadResult['messages'],
  incoming: ProjectChatReadResult['messages'],
  now = new Date()
) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    byId.set(message.id, message);
  }

  return [...byId.values()]
    .filter((message) => {
      const expiresAt = Date.parse(message.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now.getTime();
    })
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT);
}

export async function readProjectChatPages(
  client: Pick<ProjectChatClient, 'read'>,
  channelId: ProjectChatChannelId = PROJECT_CHAT_GENERAL_CHANNEL_ID,
  afterSequence = 0
): Promise<ProjectChatReadResult> {
  const messages: ProjectChatReadResult['messages'] = [];
  let cursor = afterSequence;
  let latestSequence = afterSequence;

  for (let page = 0; page < maximumPagesPerRefresh; page += 1) {
    const result = await client.read({
      afterSequence: cursor,
      channelId,
      limit: pageSize
    });
    latestSequence = Math.max(latestSequence, result.latestSequence);

    if (
      page === 0 &&
      result.hasMore &&
      result.latestSequence - afterSequence > PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT
    ) {
      cursor = Math.max(afterSequence, result.latestSequence - PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT);
      continue;
    }

    messages.push(...result.messages);

    if (!result.hasMore) {
      return {
        afterSequence,
        channelId,
        hasMore: false,
        latestSequence,
        messages: messages.slice(-PROJECT_CHAT_VISIBLE_MESSAGE_LIMIT),
        nextSequence: Math.max(cursor, result.nextSequence, latestSequence)
      };
    }

    if (result.nextSequence <= cursor) {
      throw new Error('Project Chat returned a non-advancing message cursor.');
    }
    cursor = result.nextSequence;
  }

  throw new Error('Project Chat returned too many message pages in one refresh.');
}

export interface ProjectChatInitialLoadResult {
  joinResult: ProjectChatJoinResult;
  memberResult: ProjectChatMemberListResult;
  mentionResult: ProjectChatMentionListResult;
  readResult: ProjectChatReadResult;
}

export async function loadInitialProjectChat(
  client: ProjectChatClient
): Promise<ProjectChatInitialLoadResult> {
  const joinResult = await client.join();
  const channelId = joinResult.channel.channelId;
  const [readResult, memberResult, mentionResult] = await Promise.all([
    readProjectChatPages(client, channelId),
    client.listMembers(),
    client.listMentions({ channelId, limit: 50 })
  ]);

  return { joinResult, memberResult, mentionResult, readResult };
}
