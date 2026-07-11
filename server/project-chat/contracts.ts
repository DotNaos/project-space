export const PROJECT_CHAT_GENERAL_CHANNEL_ID = 'general';
export const PROJECT_CHAT_DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS = 90 * 1_000;
export const PROJECT_CHAT_MAX_BODY_LENGTH = 4_000;

export type ProjectChatRole = 'human' | 'agent' | 'system';
export type ProjectChatLivePresenceState = 'working' | 'idle';
export type ProjectChatPresenceState = ProjectChatLivePresenceState | 'offline';
export type ProjectChatIdKind = 'channel' | 'member' | 'message';

export interface ProjectChatClock {
  now(): Date;
}

export interface ProjectChatIdGenerator {
  next(kind: ProjectChatIdKind): string;
}

export interface ProjectChatHumanActor {
  kind: 'human';
  accountId: string;
  displayName: string;
  handle: string;
}

export interface ProjectChatAgentActor {
  kind: 'agent';
  accountId: string;
  machineId: string;
  hostId: string;
  threadId: string;
}

export interface ProjectChatSystemActor {
  kind: 'system';
  serviceId: string;
  displayName: string;
  handle: string;
}

/**
 * A trusted identity assembled by the HTTP/authentication adapter. Request JSON
 * must never be cast directly to this union.
 */
export type ProjectChatActor =
  | ProjectChatHumanActor
  | ProjectChatAgentActor
  | ProjectChatSystemActor;

export interface ProjectChatContext {
  /** Server-derived installation/workspace boundary. */
  spaceId: string;
  actor: ProjectChatActor;
}

export interface ProjectChatJoinInput {
  /** Required for agents; ignored authority never comes from this input. */
  displayName?: string;
  taskTitle?: string;
}

export interface ProjectChatPresenceInput {
  state: ProjectChatLivePresenceState;
  /** `null` explicitly clears a previously stored agent task title. */
  taskTitle?: string | null;
}

export interface ProjectChatSendInput {
  channelId?: string;
  body: string;
  idempotencyKey: string;
}

export interface ProjectChatReadInput {
  channelId?: string;
  afterSequence?: number;
  limit?: number;
}

export interface ProjectChatAcknowledgeInput {
  channelId?: string;
  throughSequence: number;
}

export interface ProjectChatMentionStateInput {
  channelId?: string;
  limit?: number;
}

export interface ProjectChatOrigin {
  threadId: string;
  hostId: string;
  machineId: string;
  taskTitle?: string;
}

export interface ProjectChatSender {
  memberId: string;
  displayName: string;
  handle: string;
  role: ProjectChatRole;
  origin?: ProjectChatOrigin;
}

export interface ProjectChatMention {
  memberId: string;
  displayName: string;
  handle: string;
}

export interface ProjectChatMessage {
  id: string;
  channelId: string;
  sequence: number;
  body: string;
  sender: ProjectChatSender;
  mentions: ProjectChatMention[];
  createdAt: string;
  expiresAt: string;
}

export interface ProjectChatPresence {
  state: ProjectChatPresenceState;
  lastSeenAt: string;
  expiresAt?: string;
}

export interface ProjectChatMember {
  memberId: string;
  displayName: string;
  handle: string;
  role: ProjectChatRole;
  origin?: ProjectChatOrigin;
  presence: ProjectChatPresence;
  joinedAt: string;
  updatedAt: string;
}

export interface ProjectChatChannel {
  channelId: string;
  displayName: string;
  description: string;
  createdAt: string;
}

export interface ProjectChatJoinResult {
  channel: ProjectChatChannel;
  member: ProjectChatMember;
}

export interface ProjectChatReadResult {
  channelId: string;
  messages: ProjectChatMessage[];
  afterSequence: number;
  nextSequence: number;
  latestSequence: number;
  hasMore: boolean;
}

export interface ProjectChatCursor {
  channelId: string;
  sequence: number;
  updatedAt: string;
}

export interface ProjectChatMentionState {
  channelId: string;
  unreadCount: number;
  messages: ProjectChatMessage[];
}

export type ProjectChatErrorCode =
  | 'invalid_request'
  | 'not_member'
  | 'name_conflict'
  | 'idempotency_conflict'
  | 'cursor_out_of_range'
  | 'content_rejected'
  | 'rate_limited';

export class ProjectChatError extends Error {
  readonly code: ProjectChatErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: ProjectChatErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProjectChatError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ProjectChatMemberRecord {
  spaceId: string;
  actorKey: string;
  memberId: string;
  displayName: string;
  handle: string;
  role: ProjectChatRole;
  origin?: ProjectChatOrigin;
  joinedAt: string;
  updatedAt: string;
}

export interface ProjectChatPresenceRecord {
  spaceId: string;
  memberId: string;
  state: ProjectChatLivePresenceState;
  lastSeenAt: string;
  expiresAt: string;
}

export interface ProjectChatChannelRecord {
  spaceId: string;
  channelId: string;
  name: string;
  createdAt: string;
}

export interface ProjectChatMessageRecord extends ProjectChatMessage {
  spaceId: string;
  senderMemberId: string;
}

export const systemProjectChatClock: ProjectChatClock = {
  now: () => new Date()
};

export const randomProjectChatIdGenerator: ProjectChatIdGenerator = {
  next: (kind) => `${kind}_${crypto.randomUUID()}`
};
