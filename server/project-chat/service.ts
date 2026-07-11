import {
  PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS,
  PROJECT_CHAT_DEFAULT_RETENTION_MS,
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  ProjectChatError,
  randomProjectChatIdGenerator,
  systemProjectChatClock,
  type ProjectChatAcknowledgeInput,
  type ProjectChatActor,
  type ProjectChatChannelRecord,
  type ProjectChatClock,
  type ProjectChatContext,
  type ProjectChatIdGenerator,
  type ProjectChatJoinInput,
  type ProjectChatMember,
  type ProjectChatMemberRecord,
  type ProjectChatMentionStateInput,
  type ProjectChatMessage,
  type ProjectChatMessageRecord,
  type ProjectChatOrigin,
  type ProjectChatPresenceInput,
  type ProjectChatPresenceRecord,
  type ProjectChatReadInput,
  type ProjectChatSendInput
} from './contracts';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError,
  type ProjectChatRepository
} from './repository';
import {
  InMemoryProjectChatRateLimiter,
  defaultProjectChatRateLimits,
  type ProjectChatRateLimitAction,
  type ProjectChatRateLimiter,
  type ProjectChatRateLimitRule
} from './rate-limit';
import { scanProjectChatText } from './secret-scan';
import {
  normalizeProjectChatHandle,
  parseProjectChatAcknowledgeInput,
  parseProjectChatJoinInput,
  parseProjectChatMentionStateInput,
  parseProjectChatPresenceInput,
  parseProjectChatReadInput,
  parseProjectChatSendInput,
  projectChatActorKey,
  validateProjectChatContext
} from './validation';

export interface ProjectChatServiceOptions {
  repository: ProjectChatRepository;
  clock?: ProjectChatClock;
  idGenerator?: ProjectChatIdGenerator;
  rateLimiter?: ProjectChatRateLimiter;
  rateLimits?: Partial<Record<ProjectChatRateLimitAction, ProjectChatRateLimitRule>>;
  retentionMs?: number;
  presenceTtlMs?: number;
}

export class ProjectChatService {
  private readonly repository: ProjectChatRepository;
  private readonly clock: ProjectChatClock;
  private readonly idGenerator: ProjectChatIdGenerator;
  private readonly rateLimiter: ProjectChatRateLimiter;
  private readonly rateLimits: Record<ProjectChatRateLimitAction, ProjectChatRateLimitRule>;
  private readonly retentionMs: number;
  private readonly presenceTtlMs: number;

  constructor(options: ProjectChatServiceOptions) {
    this.repository = options.repository;
    this.clock = options.clock ?? systemProjectChatClock;
    this.idGenerator = options.idGenerator ?? randomProjectChatIdGenerator;
    this.rateLimiter = options.rateLimiter ?? new InMemoryProjectChatRateLimiter();
    this.rateLimits = {
      join: validRateLimitRule(
        options.rateLimits?.join ?? defaultProjectChatRateLimits.join,
        'join'
      ),
      send: validRateLimitRule(
        options.rateLimits?.send ?? defaultProjectChatRateLimits.send,
        'send'
      ),
      presence: validRateLimitRule(
        options.rateLimits?.presence ?? defaultProjectChatRateLimits.presence,
        'presence'
      )
    };
    this.retentionMs = positiveDuration(
      options.retentionMs ?? PROJECT_CHAT_DEFAULT_RETENTION_MS,
      'retentionMs'
    );
    this.presenceTtlMs = positiveDuration(
      options.presenceTtlMs ?? PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS,
      'presenceTtlMs'
    );
  }

  async join(context: ProjectChatContext, input: ProjectChatJoinInput = {}) {
    validateProjectChatContext(context);
    const now = this.clock.now();
    await this.consumeRateLimit(context, 'join', now);
    const profile = parseProjectChatJoinInput(context.actor, input);
    rejectSensitiveMetadata(profile.displayName, profile.taskTitle);

    const actorKey = projectChatActorKey(context.actor);
    const existing = await this.repository.findMemberByActorKey(context.spaceId, actorKey);
    const identity = memberIdentity(context.actor, profile);
    const record: ProjectChatMemberRecord = {
      spaceId: context.spaceId,
      actorKey,
      memberId: existing?.memberId ?? this.idGenerator.next('member'),
      displayName: identity.displayName,
      handle: identity.handle,
      role: identity.role,
      origin: identity.origin,
      joinedAt: existing?.joinedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    const channelRecord: ProjectChatChannelRecord = {
      spaceId: context.spaceId,
      channelId: PROJECT_CHAT_GENERAL_CHANNEL_ID,
      name: 'General',
      createdAt: now.toISOString()
    };

    try {
      const channel = await this.repository.ensureChannel(channelRecord);
      const member = await this.repository.upsertMember(record);
      const presence = await this.repository.setPresence(this.presenceRecord(
        context.spaceId,
        member.memberId,
        'working',
        now
      ));
      return {
        channel: publicChannel(channel),
        member: publicMember(member, presence, now)
      };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async updatePresence(context: ProjectChatContext, input: ProjectChatPresenceInput) {
    validateProjectChatContext(context);
    const now = this.clock.now();
    await this.consumeRateLimit(context, 'presence', now);
    const update = parseProjectChatPresenceInput(context.actor, input);
    rejectSensitiveMetadata(update.taskTitle ?? undefined);
    let member = await this.requireMember(context);

    if (context.actor.kind === 'agent' && update.taskTitle !== undefined && member.origin) {
      member = await this.repository.upsertMember({
        ...member,
        origin: { ...member.origin, taskTitle: update.taskTitle ?? undefined },
        updatedAt: now.toISOString()
      });
    }
    const presence = await this.repository.setPresence(this.presenceRecord(
      context.spaceId,
      member.memberId,
      update.state,
      now
    ));
    return publicMember(member, presence, now);
  }

  async sendMessage(context: ProjectChatContext, input: ProjectChatSendInput) {
    validateProjectChatContext(context);
    const now = this.clock.now();
    await this.consumeRateLimit(context, 'send', now);
    const request = parseProjectChatSendInput(input);
    if (!scanProjectChatText(request.body).safe) {
      throw new ProjectChatError(
        'content_rejected',
        'This message could not be sent because it may contain sensitive information.'
      );
    }

    const sender = await this.requireMember(context);
    await this.repository.purgeExpired(now.toISOString());
    const members = await this.repository.listMembers(context.spaceId);
    const mentions = resolveMentions(request.body, members);
    const message: Omit<ProjectChatMessageRecord, 'sequence'> = {
      spaceId: context.spaceId,
      senderMemberId: sender.memberId,
      id: this.idGenerator.next('message'),
      channelId: request.channelId ?? PROJECT_CHAT_GENERAL_CHANNEL_ID,
      body: request.body,
      sender: {
        memberId: sender.memberId,
        displayName: sender.displayName,
        handle: sender.handle,
        role: sender.role,
        origin: sender.origin
      },
      mentions,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.retentionMs).toISOString()
    };

    try {
      const result = await this.repository.appendMessage({
        idempotencyKey: request.idempotencyKey,
        message
      });
      return publicMessage(result.message);
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async readMessages(context: ProjectChatContext, input: ProjectChatReadInput = {}) {
    validateProjectChatContext(context);
    const request = parseProjectChatReadInput(input);
    const member = await this.requireMember(context);
    const now = this.clock.now();
    await this.repository.purgeExpired(now.toISOString());
    const afterSequence = request.afterSequence
      ?? await this.repository.getCursor(context.spaceId, member.memberId, request.channelId!);

    try {
      const page = await this.repository.readMessages({
        spaceId: context.spaceId,
        channelId: request.channelId!,
        afterSequence,
        limit: request.limit!,
        now: now.toISOString()
      });
      const lastSequence = page.messages.at(-1)?.sequence ?? afterSequence;
      return {
        channelId: request.channelId!,
        messages: page.messages.map(publicMessage),
        afterSequence,
        nextSequence: page.hasMore ? lastSequence : page.latestSequence,
        latestSequence: page.latestSequence,
        hasMore: page.hasMore
      };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async acknowledge(context: ProjectChatContext, input: ProjectChatAcknowledgeInput) {
    validateProjectChatContext(context);
    const request = parseProjectChatAcknowledgeInput(input);
    const member = await this.requireMember(context);
    const updatedAt = this.clock.now().toISOString();
    try {
      const sequence = await this.repository.acknowledgeCursor({
        spaceId: context.spaceId,
        memberId: member.memberId,
        channelId: request.channelId!,
        throughSequence: request.throughSequence,
        updatedAt
      });
      return { channelId: request.channelId!, sequence, updatedAt };
    } catch (error) {
      throw mapRepositoryError(error);
    }
  }

  async listMembers(context: ProjectChatContext) {
    validateProjectChatContext(context);
    await this.requireMember(context);
    const now = this.clock.now();
    const [members, presences] = await Promise.all([
      this.repository.listMembers(context.spaceId),
      this.repository.listPresences(context.spaceId)
    ]);
    const presenceByMember = new Map(presences.map((presence) => [presence.memberId, presence]));
    return members.map((member) => publicMember(member, presenceByMember.get(member.memberId), now));
  }

  async getMentionState(context: ProjectChatContext, input: ProjectChatMentionStateInput = {}) {
    validateProjectChatContext(context);
    const request = parseProjectChatMentionStateInput(input);
    const member = await this.requireMember(context);
    const now = this.clock.now();
    await this.repository.purgeExpired(now.toISOString());
    const afterSequence = await this.repository.getCursor(
      context.spaceId,
      member.memberId,
      request.channelId!
    );
    const result = await this.repository.listUnreadMentions({
      spaceId: context.spaceId,
      channelId: request.channelId!,
      memberId: member.memberId,
      afterSequence,
      limit: request.limit!,
      now: now.toISOString()
    });
    return {
      channelId: request.channelId!,
      unreadCount: result.unreadCount,
      messages: result.messages.map(publicMessage)
    };
  }

  async purgeExpired() {
    return this.repository.purgeExpired(this.clock.now().toISOString());
  }

  private async requireMember(context: ProjectChatContext) {
    const member = await this.repository.findMemberByActorKey(
      context.spaceId,
      projectChatActorKey(context.actor)
    );
    if (!member) {
      throw new ProjectChatError('not_member', 'Project Chat membership is required.');
    }
    return member;
  }

  private async consumeRateLimit(
    context: ProjectChatContext,
    action: ProjectChatRateLimitAction,
    now: Date
  ) {
    const rule = this.rateLimits[action];
    const result = await this.rateLimiter.consume({
      action,
      key: JSON.stringify([context.spaceId, stableRateLimitActorKey(context.actor)]),
      limit: rule.limit,
      windowMs: rule.windowMs,
      nowMs: now.getTime()
    });
    if (!result.allowed) {
      throw new ProjectChatError(
        'rate_limited',
        'Too many Project Chat requests. Try again shortly.',
        result.retryAfterMs
      );
    }
  }

  private presenceRecord(
    spaceId: string,
    memberId: string,
    state: 'working' | 'idle',
    now: Date
  ): ProjectChatPresenceRecord {
    return {
      spaceId,
      memberId,
      state,
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.presenceTtlMs).toISOString()
    };
  }
}

function stableRateLimitActorKey(actor: ProjectChatActor) {
  switch (actor.kind) {
    case 'human':
      return ['human', actor.accountId];
    case 'agent':
      return ['agent-machine', actor.accountId, actor.machineId];
    case 'system':
      return ['system', actor.serviceId];
  }
}

function rejectSensitiveMetadata(...values: Array<string | undefined>) {
  if (values.some((value) => value !== undefined && !scanProjectChatText(value).safe)) {
    throw new ProjectChatError(
      'content_rejected',
      'This metadata could not be stored because it may contain sensitive information.'
    );
  }
}

function positiveDuration(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function validRateLimitRule(rule: ProjectChatRateLimitRule, action: ProjectChatRateLimitAction) {
  if (!Number.isSafeInteger(rule.limit) || rule.limit <= 0 ||
    !Number.isSafeInteger(rule.windowMs) || rule.windowMs <= 0) {
    throw new Error(`${action} rate limit must use positive integer values.`);
  }
  return { ...rule };
}

function memberIdentity(actor: ProjectChatActor, profile: ProjectChatJoinInput) {
  switch (actor.kind) {
    case 'human':
      return { displayName: actor.displayName, handle: actor.handle, role: 'human' as const };
    case 'agent': {
      const displayName = profile.displayName!;
      const origin: ProjectChatOrigin = {
        threadId: actor.threadId,
        hostId: actor.hostId,
        machineId: actor.machineId,
        taskTitle: profile.taskTitle
      };
      return {
        displayName,
        handle: normalizeProjectChatHandle(displayName),
        role: 'agent' as const,
        origin
      };
    }
    case 'system':
      return { displayName: actor.displayName, handle: actor.handle, role: 'system' as const };
  }
}

function resolveMentions(body: string, members: ProjectChatMemberRecord[]) {
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

function publicChannel(record: ProjectChatChannelRecord) {
  return {
    channelId: record.channelId,
    displayName: record.name,
    description: 'Human and agent coordination',
    createdAt: record.createdAt
  };
}

function publicMessage(record: ProjectChatMessageRecord): ProjectChatMessage {
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

function publicMember(
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
    role: member.role,
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

function mapRepositoryError(error: unknown): unknown {
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
