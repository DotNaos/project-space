export const PROJECT_CHAT_GENERAL_CHANNEL_ID = 'general' as const;
export const PROJECT_CHAT_MAX_BODY_LENGTH = 4_000;

export type ProjectChatChannelId = string;
export type ProjectChatRole = 'agent' | 'human' | 'system';
export type ProjectChatPresenceState = 'working' | 'idle' | 'offline';

export interface ProjectChatOriginRecord {
  hostId: string;
  machineId: string;
  taskTitle?: string;
  threadId: string;
}

export interface ProjectChatPresenceRecord {
  expiresAt?: string;
  lastSeenAt: string;
  state: ProjectChatPresenceState;
}

export interface ProjectChatChannelRecord {
  channelId: ProjectChatChannelId;
  description: string;
  displayName: string;
}

export interface ProjectChatMemberRecord {
  avatarUrl?: string;
  displayName: string;
  handle: string;
  memberId: string;
  origin?: ProjectChatOriginRecord;
  presence: ProjectChatPresenceRecord;
  role: ProjectChatRole;
}

export interface ProjectChatHumanProfileRecord {
  avatarSource: 'account' | 'custom' | 'none';
  avatarUrl?: string;
  defaultAvatarUrl?: string;
  defaultDisplayName: string;
  displayName: string;
  handle: string;
  revision: number;
  updatedAt: string;
}

export interface ProjectChatProfileUpdateRequest {
  avatarDataUrl?: string | null;
  displayName?: string | null;
}

export interface ProjectChatProfileResult {
  profile: ProjectChatHumanProfileRecord;
}

export interface ProjectChatProfileUpdateResult extends ProjectChatProfileResult {
  member: ProjectChatMemberRecord;
}

export interface ProjectChatSenderRecord {
  displayName: string;
  handle: string;
  memberId: string;
  origin?: ProjectChatOriginRecord;
  role: ProjectChatRole;
}

export interface ProjectChatMentionRecord {
  displayName: string;
  handle: string;
  memberId: string;
}

export interface ProjectChatMessageRecord {
  body: string;
  channelId: ProjectChatChannelId;
  createdAt: string;
  expiresAt: string;
  id: string;
  mentions: ProjectChatMentionRecord[];
  sender: ProjectChatSenderRecord;
  sequence: number;
}

export interface ProjectChatJoinRequest {
  displayName?: string;
  taskTitle?: string;
}

export interface ProjectChatJoinResult {
  channel: ProjectChatChannelRecord;
  member: ProjectChatMemberRecord;
}

export interface ProjectChatPresenceRequest {
  state: Exclude<ProjectChatPresenceState, 'offline'>;
  taskTitle?: string | null;
}

export interface ProjectChatSendRequest {
  body: string;
  channelId: ProjectChatChannelId;
  idempotencyKey: string;
}

export interface ProjectChatSendResult {
  message: ProjectChatMessageRecord;
}

export interface ProjectChatReadRequest {
  afterSequence?: number;
  channelId?: ProjectChatChannelId;
  limit?: number;
}

export interface ProjectChatReadResult {
  afterSequence: number;
  channelId: ProjectChatChannelId;
  hasMore: boolean;
  latestSequence: number;
  messages: ProjectChatMessageRecord[];
  nextSequence: number;
}

export interface ProjectChatMemberListResult {
  members: ProjectChatMemberRecord[];
}

export interface ProjectChatMentionListRequest {
  channelId?: ProjectChatChannelId;
  limit?: number;
}

export interface ProjectChatMentionListResult {
  channelId: ProjectChatChannelId;
  messages: ProjectChatMessageRecord[];
  unreadCount: number;
}

export interface ProjectChatAcknowledgeRequest {
  channelId: ProjectChatChannelId;
  throughSequence: number;
}

export interface ProjectChatAcknowledgeResult {
  channelId: ProjectChatChannelId;
  sequence: number;
  updatedAt: string;
}

export interface ProjectChatApiErrorPayload {
  error: {
    code: string;
    message: string;
    retryAfterMs?: number;
  };
}

export interface ProjectChatClient {
  acknowledge(request: ProjectChatAcknowledgeRequest): Promise<ProjectChatAcknowledgeResult>;
  getProfile(): Promise<ProjectChatProfileResult>;
  join(request?: ProjectChatJoinRequest): Promise<ProjectChatJoinResult>;
  listMembers(): Promise<ProjectChatMemberListResult>;
  listMentions(request?: ProjectChatMentionListRequest): Promise<ProjectChatMentionListResult>;
  read(request?: ProjectChatReadRequest): Promise<ProjectChatReadResult>;
  send(request: ProjectChatSendRequest): Promise<ProjectChatSendResult>;
  updateProfile(request: ProjectChatProfileUpdateRequest): Promise<ProjectChatProfileUpdateResult>;
  updatePresence(request: ProjectChatPresenceRequest): Promise<ProjectChatMemberRecord>;
}
