import type {
  ProjectChatChannelRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
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

export interface ProjectChatRepository {
  ensureChannel(channel: ProjectChatChannelRecord): Promise<ProjectChatChannelRecord>;
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

export class ProjectChatHandleConflictError extends Error {
  constructor() {
    super('The chat handle is already in use.');
    this.name = 'ProjectChatHandleConflictError';
  }
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
