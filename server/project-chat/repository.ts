import type {
  ProjectChatChannelRecord,
  ProjectChatHumanProfileRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatNameClaimRecord,
  ProjectChatPresenceRecord
} from './contracts';

export interface ProjectChatAppendInput {
  message: Omit<ProjectChatMessageRecord, 'sequence'>;
  idempotencyKey: string;
}

export interface ProjectChatAppendResult {
  inserted: boolean;
  message: ProjectChatMessageRecord;
}

export interface ProjectChatMessagePage {
  messages: ProjectChatMessageRecord[];
  latestSequence: number;
  hasMore: boolean;
}

export interface ProjectChatUnreadMentions {
  messages: ProjectChatMessageRecord[];
  unreadCount: number;
}

export interface ProjectChatHumanProfileUpdate {
  accountId: string;
  avatarDataUrlOverride?: string | null;
  displayNameOverride?: string | null;
  spaceId: string;
  updatedAt: string;
}

export interface ProjectChatHumanProfileUpdateResult {
  member: ProjectChatMemberRecord;
  profile: ProjectChatHumanProfileRecord;
}

export interface ProjectChatHumanProfileState {
  member: ProjectChatMemberRecord | null;
  profile: ProjectChatHumanProfileRecord | null;
}

export interface ProjectChatRepository {
  listNameClaims(spaceId: string): Promise<ProjectChatNameClaimRecord[]>;
  findNameClaimByThread(spaceId: string, accountId: string, threadId: string): Promise<ProjectChatNameClaimRecord | null>;
  claimName(claim: ProjectChatNameClaimRecord): Promise<ProjectChatNameClaimRecord>;
  claimNameAndJoin(
    claim: ProjectChatNameClaimRecord,
    member: ProjectChatMemberRecord,
    presence: ProjectChatPresenceRecord
  ): Promise<{
    claim: ProjectChatNameClaimRecord;
    member: ProjectChatMemberRecord;
    presence: ProjectChatPresenceRecord;
  }>;
  reapExpiredNameClaims(spaceId: string, expiresAtOrBefore: string): Promise<number>;
  ensureHumanProfileAndMember(
    profile: ProjectChatHumanProfileRecord,
    member: ProjectChatMemberRecord,
    options?: { refreshDefaults?: boolean }
  ): Promise<ProjectChatHumanProfileUpdateResult>;
  findHumanProfile(
    spaceId: string,
    accountId: string
  ): Promise<ProjectChatHumanProfileRecord | null>;
  findHumanProfileAndMember(
    spaceId: string,
    accountId: string,
    actorKey: string
  ): Promise<ProjectChatHumanProfileState>;
  updateHumanProfileAndMember(
    input: ProjectChatHumanProfileUpdate,
    member: ProjectChatMemberRecord
  ): Promise<ProjectChatHumanProfileUpdateResult>;
  ensureChannel(channel: ProjectChatChannelRecord): Promise<ProjectChatChannelRecord>;
  findChannel(spaceId: string, channelId: string): Promise<ProjectChatChannelRecord | null>;
  findMemberByActorKey(spaceId: string, actorKey: string): Promise<ProjectChatMemberRecord | null>;
  findMemberById(spaceId: string, memberId: string): Promise<ProjectChatMemberRecord | null>;
  upsertMember(member: ProjectChatMemberRecord): Promise<ProjectChatMemberRecord>;
  listMembers(spaceId: string): Promise<ProjectChatMemberRecord[]>;
  setPresence(presence: ProjectChatPresenceRecord): Promise<ProjectChatPresenceRecord>;
  getPresence(spaceId: string, memberId: string): Promise<ProjectChatPresenceRecord | null>;
  listPresences(spaceId: string): Promise<ProjectChatPresenceRecord[]>;
  appendMessage(input: ProjectChatAppendInput): Promise<ProjectChatAppendResult>;
  readMessages(input: {
    spaceId: string;
    channelId: string;
    afterSequence: number;
    limit: number;
    now: string;
  }): Promise<ProjectChatMessagePage>;
  listUnreadMentions(input: {
    spaceId: string;
    channelId: string;
    memberId: string;
    afterSequence: number;
    limit: number;
    now: string;
  }): Promise<ProjectChatUnreadMentions>;
  getChannelSequence(spaceId: string, channelId: string): Promise<number>;
  getCursor(spaceId: string, memberId: string, channelId: string): Promise<number>;
  acknowledgeCursor(input: {
    spaceId: string;
    memberId: string;
    channelId: string;
    throughSequence: number;
    updatedAt: string;
  }): Promise<number>;
  purgeExpired(now: string): Promise<number>;
}

export function memberWithHumanProfile(
  member: ProjectChatMemberRecord,
  profile: ProjectChatHumanProfileRecord
): ProjectChatMemberRecord {
  if (member.role !== 'human' || member.spaceId !== profile.spaceId) {
    throw new Error('Project Chat human profile does not match its member.');
  }
  return {
    ...member,
    avatarUrl: profile.avatarDataUrlOverride ?? profile.defaultAvatarUrl,
    displayName: profile.displayNameOverride ?? profile.defaultDisplayName,
    origin: undefined,
    profileRevision: profile.revision,
    role: 'human',
    updatedAt: profile.updatedAt
  };
}

export class ProjectChatHandleConflictError extends Error {
  constructor() {
    super('The chat handle is already in use.');
    this.name = 'ProjectChatHandleConflictError';
  }
}

export class ProjectChatNameClaimConflictError extends Error {
  constructor(readonly reason: 'name_claimed' | 'thread_claimed') {
    super(reason === 'name_claimed' ? 'The registry name is already claimed.' : 'This thread already has a registry name.');
    this.name = 'ProjectChatNameClaimConflictError';
  }
}

export class ProjectChatNameParentConflictError extends Error {
  constructor() {
    super('The specialist parent is no longer an active mythology claim.');
    this.name = 'ProjectChatNameParentConflictError';
  }
}

export function memberForNameClaim(
  member: ProjectChatMemberRecord,
  claim: ProjectChatNameClaimRecord,
  parent: ProjectChatNameClaimRecord | null
): ProjectChatMemberRecord {
  if (claim.parentThreadId && (
    !parent || parent.spaceId !== claim.spaceId || parent.accountId !== claim.accountId ||
    parent.threadId !== claim.parentThreadId || parent.category !== 'mythology'
  )) throw new ProjectChatNameParentConflictError();
  const displayName=parent ? `${parent.displayName}.${claim.displayName}` : claim.displayName;
  return {...member,displayName,agentName:{
    name:claim.displayName,category:claim.category,displayName,
    ...(claim.parentThreadId?{parentThreadId:claim.parentThreadId}:{})
  }};
}

export class ProjectChatIdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for different content.');
    this.name = 'ProjectChatIdempotencyConflictError';
  }
}

export class ProjectChatCursorOutOfRangeError extends Error {
  constructor() {
    super('The cursor is outside the channel range.');
    this.name = 'ProjectChatCursorOutOfRangeError';
  }
}
