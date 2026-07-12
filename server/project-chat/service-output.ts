import {
  ProjectChatError,
  type ProjectChatChannelRecord,
  type ProjectChatMember,
  type ProjectChatMemberRecord,
  type ProjectChatMessage,
  type ProjectChatMessageRecord,
  type ProjectChatProject,
  type ProjectChatPresenceRecord
} from './contracts';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError
} from './repository';

export function resolveProjectChatMentions(
  body: string,
  members: ProjectChatMemberRecord[]
) {
  const byHandle = new Map(members.map((member) => [member.handle.toLowerCase(), member]));
  const mentions = [];
  const seen = new Set<string>();
  const pattern = /(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;
  for (const match of body.matchAll(pattern)) {
    const member = byHandle.get(match[2].toLowerCase());
    if (!member || seen.has(member.memberId)) {
      continue;
    }
    seen.add(member.memberId);
    mentions.push({
      memberId: member.memberId,
      displayName: member.displayName,
      handle: member.handle
    });
  }
  return mentions;
}

export function publicProjectChatChannel(
  record: ProjectChatChannelRecord,
  project?: ProjectChatProject
) {
  return {
    channelId: record.channelId,
    displayName: record.kind === 'general' ? 'General' : record.name,
    description: record.kind === 'general'
      ? 'Human and agent coordination'
      : 'Project communication across machines and workspaces',
    createdAt: record.createdAt,
    ...(project ? { groupLabel: project.groupLabel } : {}),
    ...(project?.navigationProjectId
      ? { navigationProjectId: project.navigationProjectId }
      : {}),
    kind: record.kind,
    ...(record.projectId ? { projectId: record.projectId } : {})
  };
}

export function publicProjectChatMessage(
  record: ProjectChatMessageRecord
): ProjectChatMessage {
  return {
    id: record.id,
    channelId: record.channelId,
    sequence: record.sequence,
    body: record.body,
    sender: structuredClone(record.sender),
    mentions: structuredClone(record.mentions),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  };
}

export function publicProjectChatMember(
  member: ProjectChatMemberRecord,
  presence: ProjectChatPresenceRecord | undefined | null,
  now: Date
): ProjectChatMember {
  const isFresh = presence !== undefined && presence !== null
    && new Date(presence.expiresAt).getTime() > now.getTime();
  return {
    memberId: member.memberId,
    displayName: member.displayName,
    handle: member.handle,
    ...(member.avatarUrl ? { avatarUrl: member.avatarUrl } : {}),
    role: member.role,
    agentName: member.agentName ? structuredClone(member.agentName) : undefined,
    origin: member.origin ? structuredClone(member.origin) : undefined,
    presence: presence
      ? {
          state: isFresh ? presence.state : 'offline',
          lastSeenAt: presence.lastSeenAt,
          expiresAt: presence.expiresAt
        }
      : { state: 'offline', lastSeenAt: member.updatedAt },
    joinedAt: member.joinedAt,
    updatedAt: member.updatedAt
  };
}

export function mapProjectChatRepositoryError(error: unknown): unknown {
  if (error instanceof ProjectChatHandleConflictError) {
    return new ProjectChatError('name_conflict', 'This Project Chat name is already in use.');
  }
  if (error instanceof ProjectChatIdempotencyConflictError) {
    return new ProjectChatError(
      'idempotency_conflict',
      'The request key was already used for a different message.'
    );
  }
  if (error instanceof ProjectChatCursorOutOfRangeError) {
    return new ProjectChatError('cursor_out_of_range', 'The requested chat cursor is not available.');
  }
  return error;
}
