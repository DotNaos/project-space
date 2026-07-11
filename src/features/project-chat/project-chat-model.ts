import type {
  ProjectChatHumanProfileRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatPresenceState,
  ProjectChatProfileUpdateRequest,
  ProjectChatSenderRecord
} from '@/shared/project-chat-api';

export const PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH = 48;

export type ProjectChatAvatarUpdate = string | null | undefined;

export interface ProjectChatParticipantIdentity extends ProjectChatSenderRecord {
  avatarUrl?: string;
}

export interface ProjectChatProfileGenerationGuard {
  acceptProfileRevision(revision: number): boolean;
  beginMutation(): number;
  captureRefresh(): ProjectChatProfileRefreshToken;
  canApplyRefresh(refresh: ProjectChatProfileRefreshToken, revision: number): boolean;
  finishMutation(generation: number): boolean;
  isRefreshCurrent(refresh: ProjectChatProfileRefreshToken): boolean;
}

export interface ProjectChatProfileRefreshToken {
  generation: number;
  sequence: number;
}

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

export function createProjectChatProfileGenerationGuard(): ProjectChatProfileGenerationGuard {
  let generation = 0;
  let latestAcceptedRefreshSequence = 0;
  let latestProfileRevision = 0;
  let pendingMutation: number | undefined;
  let refreshSequence = 0;

  function acceptProfileRevision(revision: number) {
    if (
      !Number.isSafeInteger(revision)
      || revision < 1
      || revision < latestProfileRevision
    ) {
      return false;
    }
    latestProfileRevision = revision;
    return true;
  }

  return {
    acceptProfileRevision,
    beginMutation() {
      generation += 1;
      pendingMutation = generation;
      return generation;
    },
    captureRefresh() {
      refreshSequence += 1;
      return { generation, sequence: refreshSequence };
    },
    canApplyRefresh(refresh, revision) {
      if (
        pendingMutation !== undefined
        || refresh.generation !== generation
        || !Number.isSafeInteger(revision)
        || revision < 1
        || revision < latestProfileRevision
        || (revision === latestProfileRevision
          && refresh.sequence < latestAcceptedRefreshSequence)
      ) {
        return false;
      }
      latestProfileRevision = revision;
      latestAcceptedRefreshSequence = refresh.sequence;
      return true;
    },
    finishMutation(mutationGeneration) {
      if (pendingMutation !== mutationGeneration) {
        return false;
      }
      pendingMutation = undefined;
      generation += 1;
      return true;
    },
    isRefreshCurrent(refresh) {
      return pendingMutation === undefined && refresh.generation === generation;
    }
  };
}

export async function runProjectChatProfileMutation<Result>(
  guard: ProjectChatProfileGenerationGuard,
  mutate: () => Promise<Result>,
  reconcile: (result?: Result) => Promise<boolean>
) {
  const mutationGeneration = guard.beginMutation();
  try {
    const result = await mutate();
    const finished = guard.finishMutation(mutationGeneration);
    if (!finished) {
      return { applyResult: false, result };
    }
    let reconciled = false;
    try {
      reconciled = await reconcile(result);
    } catch {
      // The mutation response remains a safe fallback when reconciliation fails.
    }
    return {
      applyResult: !reconciled,
      result
    };
  } catch (error) {
    guard.finishMutation(mutationGeneration);
    try {
      await reconcile();
    } catch {
      // Preserve the mutation failure. The caller's reconciliation path reports its own state.
    }
    throw error;
  }
}

export function projectChatMessageIdentity(
  message: ProjectChatMessageRecord,
  member?: ProjectChatMemberRecord
) {
  const currentHuman = member?.role === 'human' && message.sender.role === 'human'
    && member.memberId === message.sender.memberId
    ? member
    : undefined;
  return {
    avatarUrl: currentHuman?.avatarUrl,
    displayName: currentHuman?.displayName ?? message.sender.displayName,
    role: message.sender.role
  };
}

export function projectChatMemberWithProfile(
  member: ProjectChatMemberRecord,
  profile: ProjectChatHumanProfileRecord
) {
  if (member.role !== 'human') {
    return member;
  }

  return {
    ...member,
    avatarUrl: profile.avatarUrl,
    displayName: profile.displayName,
    handle: profile.handle
  } satisfies ProjectChatMemberRecord;
}

export function projectChatIdentitySnapshot(
  viewer: ProjectChatMemberRecord,
  members: ProjectChatMemberRecord[],
  profile: ProjectChatHumanProfileRecord
) {
  const currentViewer = projectChatMemberWithProfile(viewer, profile);
  return {
    members: members.some((member) => member.memberId === currentViewer.memberId)
      ? members.map((member) => (
          member.memberId === currentViewer.memberId ? currentViewer : member
        ))
      : [...members, currentViewer],
    viewer: currentViewer
  };
}

export function projectChatProfileUpdateRequest(
  profile: ProjectChatHumanProfileRecord,
  displayName: string,
  displayNameTouched: boolean,
  avatarUpdate: ProjectChatAvatarUpdate
) {
  const normalizedName = displayName.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalizedName || normalizedName.length > PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `Display name must be between 1 and ${PROJECT_CHAT_MAX_DISPLAY_NAME_LENGTH} characters.`
    );
  }

  const request: ProjectChatProfileUpdateRequest = {};
  if (displayNameTouched && normalizedName !== profile.displayName) {
    request.displayName = normalizedName === profile.defaultDisplayName
      ? null
      : normalizedName;
  }
  if (avatarUpdate !== undefined) {
    request.avatarDataUrl = avatarUpdate;
  }

  return Object.keys(request).length > 0 ? request : undefined;
}

export function projectChatThreadParticipants(
  messages: ProjectChatMessageRecord[],
  members: ProjectChatMemberRecord[],
  thread: ProjectChatThreadSummary
) {
  const snapshots = new Map<string, ProjectChatParticipantIdentity>();

  for (const message of messages) {
    if (message.sender.origin?.threadId === thread.threadId) {
      snapshots.set(message.sender.memberId, message.sender);
      continue;
    }

    if (message.mentions.some((mention) => mention.memberId === thread.memberId)) {
      snapshots.set(message.sender.memberId, message.sender);
    }
  }

  const threadMember = members.find((member) => member.memberId === thread.memberId);
  if (!snapshots.has(thread.memberId)) {
    snapshots.set(thread.memberId, threadMember?.role === 'agent'
      ? threadMember
      : {
          displayName: thread.memberName,
          handle: thread.memberName,
          memberId: thread.memberId,
          role: 'agent'
        });
  }

  return [...snapshots.values()].map((snapshot) => {
    const current = members.find((member) => (
      member.memberId === snapshot.memberId && member.role === snapshot.role
    ));
    if (!current) {
      return {
        ...snapshot,
        avatarUrl: undefined
      };
    }

    return {
      avatarUrl: current.role === 'human' ? current.avatarUrl : undefined,
      displayName: current.displayName,
      handle: current.handle,
      memberId: current.memberId,
      origin: current.origin,
      role: current.role
    } satisfies ProjectChatParticipantIdentity;
  });
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
