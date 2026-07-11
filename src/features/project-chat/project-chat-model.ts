import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatPresenceState
} from '@/shared/project-chat-api';

export interface ProjectChatTextSegment {
  kind: 'mention' | 'text';
  memberId?: string;
  value: string;
}

export interface ProjectChatThreadSummary {
  hostId: string;
  lastActivityAt: string;
  machineId: string;
  memberId: string;
  memberName: string;
  taskTitle: string;
  threadId: string;
}

export function sortProjectChatMessages(messages: ProjectChatMessageRecord[]) {
  return [...messages].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }

    const createdDifference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return createdDifference || left.id.localeCompare(right.id);
  });
}

export function shortProjectChatId(value: string) {
  const normalized = value.trim();
  return normalized.length <= 12 ? normalized : `${normalized.slice(0, 4)}…${normalized.slice(-4)}`;
}

export function effectiveProjectChatPresence(
  member: ProjectChatMemberRecord,
  now = new Date()
): ProjectChatPresenceState {
  if (member.presence.state === 'offline' || !member.presence.expiresAt) {
    return 'offline';
  }

  const expiry = Date.parse(member.presence.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
    return 'offline';
  }

  return member.presence.state;
}

export function projectChatPresenceLabel(state: ProjectChatPresenceState) {
  if (state === 'working') {
    return 'Active now';
  }

  if (state === 'idle') {
    return 'Idle';
  }

  return 'Offline';
}

export function formatProjectChatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

export function formatProjectChatActivity(value: string, now = new Date()) {
  const date = new Date(value);
  const elapsedMs = now.getTime() - date.getTime();

  if (!Number.isFinite(elapsedMs)) {
    return 'Unknown';
  }

  if (elapsedMs < 60_000) {
    return 'Just now';
  }

  const minutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function projectChatDateLabel(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown date';
  }

  const localDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const differenceInDays = Math.round((today - localDay) / 86_400_000);

  if (differenceInDays === 0) {
    return 'Today';
  }

  if (differenceInDays === 1) {
    return 'Yesterday';
  }

  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short'
  }).format(date);
}

function isHandleBoundaryCharacter(value: string | undefined) {
  return value === undefined || !/[\p{L}\p{N}_-]/u.test(value);
}

export function projectChatTextSegments(
  message: Pick<ProjectChatMessageRecord, 'body' | 'mentions'>
): ProjectChatTextSegment[] {
  if (message.mentions.length === 0) {
    return [{ kind: 'text', value: message.body }];
  }

  const handles = message.mentions
    .map((mention) => ({ ...mention, token: `@${mention.handle.replace(/^@/, '')}` }))
    .sort((left, right) => right.token.length - left.token.length);
  const lowerBody = message.body.toLocaleLowerCase();
  const segments: ProjectChatTextSegment[] = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < message.body.length) {
    const match = handles.find(({ token }) => {
      const lowerToken = token.toLocaleLowerCase();
      if (!lowerBody.startsWith(lowerToken, cursor)) {
        return false;
      }

      return (
        isHandleBoundaryCharacter(message.body[cursor - 1]) &&
        isHandleBoundaryCharacter(message.body[cursor + token.length])
      );
    });

    if (!match) {
      cursor += 1;
      continue;
    }

    if (cursor > textStart) {
      segments.push({ kind: 'text', value: message.body.slice(textStart, cursor) });
    }

    const end = cursor + match.token.length;
    segments.push({
      kind: 'mention',
      memberId: match.memberId,
      value: message.body.slice(cursor, end)
    });
    cursor = end;
    textStart = end;
  }

  if (textStart < message.body.length) {
    segments.push({ kind: 'text', value: message.body.slice(textStart) });
  }

  return segments.length > 0 ? segments : [{ kind: 'text', value: message.body }];
}

export function threadMembers(
  messages: ProjectChatMessageRecord[],
  threadId: string
) {
  const memberIndex = new Map<string, ProjectChatMessageRecord['sender']>();

  for (const message of messages) {
    if (message.sender.origin?.threadId === threadId) {
      memberIndex.set(message.sender.memberId, message.sender);
    }

    for (const mention of message.mentions) {
      memberIndex.set(mention.memberId, {
        displayName: mention.displayName,
        handle: mention.handle,
        memberId: mention.memberId,
        role: 'agent'
      });
    }
  }

  return [...memberIndex.values()];
}

export function projectChatThreads(
  messages: ProjectChatMessageRecord[],
  members: ProjectChatMemberRecord[] = []
) {
  const threads = new Map<string, ProjectChatThreadSummary>();

  function addThread(candidate: ProjectChatThreadSummary) {
    const existing = threads.get(candidate.threadId);
    const candidateTime = Date.parse(candidate.lastActivityAt);
    const existingTime = existing ? Date.parse(existing.lastActivityAt) : Number.NaN;
    if (!existing || !Number.isFinite(existingTime) || candidateTime >= existingTime) {
      threads.set(candidate.threadId, candidate);
    }
  }

  for (const member of members) {
    const origin = member.origin;
    if (!origin) {
      continue;
    }

    addThread({
      hostId: origin.hostId,
      lastActivityAt: member.presence.lastSeenAt,
      machineId: origin.machineId,
      memberId: member.memberId,
      memberName: member.displayName,
      taskTitle: origin.taskTitle ?? 'Untitled Codex task',
      threadId: origin.threadId
    });
  }

  for (const message of sortProjectChatMessages(messages)) {
    const origin = message.sender.origin;
    if (!origin) {
      continue;
    }

    addThread({
      hostId: origin.hostId,
      lastActivityAt: message.createdAt,
      machineId: origin.machineId,
      memberId: message.sender.memberId,
      memberName: message.sender.displayName,
      taskTitle: origin.taskTitle ?? 'Untitled Codex task',
      threadId: origin.threadId
    });
  }

  return [...threads.values()].sort(
    (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt)
  );
}
