import {
  PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS,
  PROJECT_CHAT_DEFAULT_RETENTION_MS,
  PROJECT_CHAT_GENERAL_CHANNEL_ID,
  ProjectChatError,
  randomProjectChatIdGenerator,
  systemProjectChatClock,
  type ProjectChatAcknowledgeInput,
  type ProjectChatActor,
  type ProjectChatClock,
  type ProjectChatContext,
  type ProjectChatHumanProfile,
  type ProjectChatHumanProfileRecord,
  type ProjectChatIdGenerator,
  type ProjectChatJoinInput,
  type ProjectChatMemberRecord,
  type ProjectChatMentionStateInput,
  type ProjectChatNameClaimInput,
  type ProjectChatMessageRecord,
  type ProjectChatOrigin,
  type ProjectChatPresenceInput,
  type ProjectChatPresenceRecord,
  type ProjectChatProfileUpdateInput,
  type ProjectChatReadInput,
  type ProjectChatSendInput
} from './contracts';
import {
  type ProjectChatRepository
} from './repository';
import {
  mapProjectChatRepositoryError,
  publicProjectChatChannel,
  publicProjectChatMember,
  publicProjectChatMessage,
  resolveProjectChatMentions
} from './service-output';
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
  parseProjectChatProfileUpdateInput,
  parseProjectChatReadInput,
  parseProjectChatSendInput,
  projectChatActorKey,
  validateProjectChatContext
} from './validation';
import { findProjectChatName, projectChatNameCatalog, reservedProjectChatNames, type ProjectChatNameCategory } from './name-registry';
import { ProjectChatNameClaimConflictError } from './repository';
import {
  ProjectChatChannelManager,
  type ProjectChatProjectProvider
} from './channel-manager';

export interface ProjectChatServiceOptions {
  repository: ProjectChatRepository;
  clock?: ProjectChatClock;
  idGenerator?: ProjectChatIdGenerator;
  rateLimiter?: ProjectChatRateLimiter;
  rateLimits?: Partial<Record<ProjectChatRateLimitAction, ProjectChatRateLimitRule>>;
  retentionMs?: number;
  presenceTtlMs?: number;
  listProjects?: ProjectChatProjectProvider;
  nameLeaseMs?: number;
}

export const PROJECT_CHAT_NAME_LEASE_MS = 48 * 60 * 60 * 1_000;

export class ProjectChatService {
  private readonly repository: ProjectChatRepository;
  private readonly clock: ProjectChatClock;
  private readonly idGenerator: ProjectChatIdGenerator;
  private readonly rateLimiter: ProjectChatRateLimiter;
  private readonly rateLimits: Record<ProjectChatRateLimitAction, ProjectChatRateLimitRule>;
  private readonly retentionMs: number;
  private readonly presenceTtlMs: number;
  private readonly nameLeaseMs: number;
  private readonly channels: ProjectChatChannelManager;

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
    this.nameLeaseMs = positiveDuration(
      options.nameLeaseMs ?? PROJECT_CHAT_NAME_LEASE_MS,
      'nameLeaseMs'
    );
    this.channels = new ProjectChatChannelManager(
      this.repository,
      this.clock,
      this.idGenerator,
      options.listProjects ?? (async () => [])
    );
  }

  async listChannels(context: ProjectChatContext, projectId?: string) {
    validateProjectChatContext(context);
    await this.requireMember(context);
    return this.channels.list(context, projectId);
  }

  async listNames(context: ProjectChatContext) {
    validateProjectChatContext(context);
    if (context.actor.kind === 'system') throw new ProjectChatError('forbidden', 'System actors cannot use the name registry.');
    if (context.actor.kind === 'human') await this.requireMember(context);
    await this.reapExpiredNameClaims(context.spaceId, this.clock.now());
    const claims = await this.repository.listNameClaims(context.spaceId);
    const claimsByName = new Map(claims.map((claim) => [claim.nameKey, claim]));
    const currentAccountId = context.actor.accountId;
    const currentThreadId = context.actor.kind === 'agent' ? context.actor.threadId : undefined;
    const current = currentThreadId ? claims.find((claim) => claim.accountId === currentAccountId && claim.threadId === currentThreadId) : undefined;
    const groups = (['mythology','artist','science','detective'] as ProjectChatNameCategory[]).map((category) => ({
      category,
      names: [
        ...projectChatNameCatalog.filter((entry) => entry[2] === category),
        ...(current?.category === category && !projectChatNameCatalog.some(([key]) => key === current.nameKey)
          ? [[current.nameKey,current.displayName,current.category] as const]
          : [])
      ].map(([key,name]) => {
        const claim = claimsByName.get(key);
        return { name, category, state: reservedProjectChatNames.has(key) ? 'reserved' as const : claim ? 'claimed' as const : 'available' as const, ...(current?.nameKey === key ? {claimedByCurrentThread:true}: {}), ...(claim ? {claimedByThreadId:claim.threadId,displayName:claim.displayName}: {}) };
      })
    }));
    return { groups };
  }

  async claimName(context: ProjectChatContext, input: ProjectChatNameClaimInput) {
    validateProjectChatContext(context);
    if (context.actor.kind !== 'agent') throw new ProjectChatError('forbidden', 'Only agents can claim registry names.');
    if (!input || typeof input.name !== 'string' || typeof input.category !== 'string') throw new ProjectChatError('invalid_request','A registry name and category are required.');
    const nowDate = this.clock.now();
    await this.reapExpiredNameClaims(context.spaceId, nowDate);
    const entry = findProjectChatName(input.name);
    if (!entry || entry[2] !== input.category || reservedProjectChatNames.has(entry[0])) throw new ProjectChatError('invalid_request','This registry name is unavailable.');
    const parentThreadId = typeof input.parentThreadId === 'string' ? input.parentThreadId : undefined;
    if (entry[2] === 'mythology') {
      if (parentThreadId) throw new ProjectChatError('invalid_request','Main-agent names cannot have a parent.');
    } else {
      if (!parentThreadId) throw new ProjectChatError('invalid_request','Specialist names require a parent thread.');
      if (parentThreadId === context.actor.threadId) throw new ProjectChatError('invalid_request','A specialist cannot be its own parent.');
      const parent = await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, parentThreadId);
      if (!parent || parent.category !== 'mythology') throw new ProjectChatError('forbidden','The parent must be a mythology main agent in this account.');
    }
    const now = nowDate.toISOString();
    const previousClaim = await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, context.actor.threadId);
    let claim;
    try { claim = await this.repository.claimName({spaceId:context.spaceId,accountId:context.actor.accountId,threadId:context.actor.threadId,actorKey:projectChatActorKey(context.actor),nameKey:entry[0],displayName:entry[1],category:entry[2],...(parentThreadId?{parentThreadId}:{}),claimedAt:now,updatedAt:now}); }
    catch (error) { if (error instanceof ProjectChatNameClaimConflictError) throw new ProjectChatError('name_conflict',error.message); throw error; }
    const parent = claim.parentThreadId ? await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, claim.parentThreadId) : null;
    const displayName = parent ? `${parent.displayName}.${claim.displayName}` : claim.displayName;
    let joined;
    try {
      joined = await this.join(context, {displayName});
    } catch (error) {
      await this.repository.restoreNameClaim(claim, previousClaim);
      throw error;
    }
    return { claim:{name:claim.displayName,displayName,category:claim.category,threadId:claim.threadId,...(claim.parentThreadId?{parentThreadId:claim.parentThreadId}:{})}, member:joined.member };
  }

  async join(context: ProjectChatContext, input: ProjectChatJoinInput = {}) {
    validateProjectChatContext(context);
    const now = this.clock.now();
    await this.consumeRateLimit(context, 'join', now);
    let profile = parseProjectChatJoinInput(context.actor, input);
    rejectSensitiveMetadata(profile.displayName, profile.taskTitle);

    const actorKey = projectChatActorKey(context.actor);
    let agentClaim;
    if (context.actor.kind === 'agent') {
      agentClaim = await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, context.actor.threadId);
      if (!agentClaim) throw new ProjectChatError('forbidden', 'Claim a Project Chat registry name before joining.');
      const parent = agentClaim.parentThreadId ? await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, agentClaim.parentThreadId) : null;
      const claimedDisplayName = parent ? `${parent.displayName}.${agentClaim.displayName}` : agentClaim.displayName;
      if (profile.displayName !== claimedDisplayName) throw new ProjectChatError('forbidden', 'The joined name must match the registry claim.');
      profile = {...profile, displayName: claimedDisplayName};
    }
    const existing = await this.repository.findMemberByActorKey(context.spaceId, actorKey);
    const humanProfile = context.actor.kind === 'human'
      ? this.humanProfileRecord(context, now)
      : undefined;
    const identity = memberIdentity(context.actor, profile, humanProfile);
    const record: ProjectChatMemberRecord = {
      spaceId: context.spaceId,
      actorKey,
      memberId: existing?.memberId ?? this.idGenerator.next('member'),
      displayName: identity.displayName,
      handle: identity.handle,
      avatarUrl: identity.avatarUrl,
      profileRevision: humanProfile?.revision,
      role: identity.role,
      agentName: agentClaim ? {name:agentClaim.displayName,category:agentClaim.category,displayName:profile.displayName!,...(agentClaim.parentThreadId?{parentThreadId:agentClaim.parentThreadId}:{})}:undefined,
      origin: identity.origin,
      joinedAt: existing?.joinedAt ?? now.toISOString(),
      updatedAt: now.toISOString()
    };
    try {
      const { channel, project } = await this.channels.ensureSelected(
        context,
        profile.projectId
      );
      const member = humanProfile
        ? (await this.repository.ensureHumanProfileAndMember(humanProfile, record, {
            refreshDefaults: context.actor.kind === 'human'
              && context.actor.profileDefaultsResolved !== false
          })).member
        : await this.repository.upsertMember(record);
      const presence = await this.repository.setPresence(this.presenceRecord(
        context.spaceId,
        member.memberId,
        'working',
        now
      ));
      return {
        channel: publicProjectChatChannel(channel, project),
        member: publicProjectChatMember(member, presence, now)
      };
    } catch (error) {
      throw mapProjectChatRepositoryError(error);
    }
  }

  async getProfile(context: ProjectChatContext): Promise<ProjectChatHumanProfile> {
    validateProjectChatContext(context);
    const actor = requireHumanActor(context);
    const existing = await this.repository.findHumanProfileAndMember(
      context.spaceId,
      actor.accountId,
      projectChatActorKey(context.actor)
    );
    if (!existing.member) {
      throw new ProjectChatError('not_member', 'Project Chat membership is required.');
    }
    const state = existing.profile
      ? { member: existing.member, profile: existing.profile }
      : await this.repository.ensureHumanProfileAndMember(
          this.humanProfileRecord(context, this.clock.now()),
          existing.member,
          { refreshDefaults: actor.profileDefaultsResolved !== false }
        );
    return publicHumanProfile(state.member.handle, state.profile);
  }

  async updateProfile(
    context: ProjectChatContext,
    input: ProjectChatProfileUpdateInput
  ) {
    validateProjectChatContext(context);
    const actor = requireHumanActor(context);
    const now = this.clock.now();
    await this.consumeRateLimit(context, 'join', now);
    const update = parseProjectChatProfileUpdateInput(input);
    rejectSensitiveMetadata(update.displayName ?? undefined);
    const existing = await this.repository.findHumanProfileAndMember(
      context.spaceId,
      actor.accountId,
      projectChatActorKey(context.actor)
    );
    if (!existing.member) {
      throw new ProjectChatError('not_member', 'Project Chat membership is required.');
    }
    if (!existing.profile) {
      throw new Error('Project Chat human profile is unavailable.');
    }

    const { member: updatedMember, profile } = await this.repository.updateHumanProfileAndMember({
      accountId: actor.accountId,
      ...(update.avatarDataUrl === undefined
        ? {}
        : { avatarDataUrlOverride: update.avatarDataUrl }),
      ...(update.displayName === undefined
        ? {}
        : { displayNameOverride: update.displayName }),
      spaceId: context.spaceId,
      updatedAt: now.toISOString()
    }, {
      ...existing.member,
      handle: actor.handle,
      origin: undefined,
      role: 'human',
      updatedAt: now.toISOString()
    });
    const presence = await this.repository.getPresence(context.spaceId, updatedMember.memberId);
    return {
      member: publicProjectChatMember(updatedMember, presence, now),
      profile: publicHumanProfile(updatedMember.handle, profile)
    };
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
    return publicProjectChatMember(member, presence, now);
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
    const channel = await this.channels.require(
      context,
      request.channelId ?? PROJECT_CHAT_GENERAL_CHANNEL_ID
    );
    await this.repository.purgeExpired(now.toISOString());
    const members = this.channels.membersForChannel(
      context,
      channel,
      await this.repository.listMembers(context.spaceId)
    );
    const mentions = resolveProjectChatMentions(request.body, members);
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
        agentName: sender.agentName,
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
      return publicProjectChatMessage(result.message);
    } catch (error) {
      throw mapProjectChatRepositoryError(error);
    }
  }

  async readMessages(context: ProjectChatContext, input: ProjectChatReadInput = {}) {
    validateProjectChatContext(context);
    const request = parseProjectChatReadInput(input);
    const member = await this.requireMember(context);
    await this.channels.require(context, request.channelId!);
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
        messages: page.messages.map(publicProjectChatMessage),
        afterSequence,
        nextSequence: page.hasMore ? lastSequence : page.latestSequence,
        latestSequence: page.latestSequence,
        hasMore: page.hasMore
      };
    } catch (error) {
      throw mapProjectChatRepositoryError(error);
    }
  }

  async acknowledge(context: ProjectChatContext, input: ProjectChatAcknowledgeInput) {
    validateProjectChatContext(context);
    const request = parseProjectChatAcknowledgeInput(input);
    const member = await this.requireMember(context);
    await this.channels.require(context, request.channelId!);
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
      throw mapProjectChatRepositoryError(error);
    }
  }

  async listMembers(context: ProjectChatContext, input: ProjectChatReadInput = {}) {
    validateProjectChatContext(context);
    await this.requireMember(context);
    const request = parseProjectChatReadInput(input);
    const channel = await this.channels.require(context, request.channelId!);
    const now = this.clock.now();
    const [members, presences] = await Promise.all([
      this.repository.listMembers(context.spaceId),
      this.repository.listPresences(context.spaceId)
    ]);
    const presenceByMember = new Map(presences.map((presence) => [presence.memberId, presence]));
    return this.channels.membersForChannel(context, channel, members).map((member) => publicProjectChatMember(
      member,
      presenceByMember.get(member.memberId),
      now
    ));
  }

  async getMentionState(context: ProjectChatContext, input: ProjectChatMentionStateInput = {}) {
    validateProjectChatContext(context);
    const request = parseProjectChatMentionStateInput(input);
    const member = await this.requireMember(context);
    await this.channels.require(context, request.channelId!);
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
      messages: result.messages.map(publicProjectChatMessage)
    };
  }

  async purgeExpired() {
    return this.repository.purgeExpired(this.clock.now().toISOString());
  }

  private reapExpiredNameClaims(spaceId: string, now: Date) {
    return this.repository.reapExpiredNameClaims(
      spaceId,
      new Date(now.getTime() - this.nameLeaseMs).toISOString()
    );
  }

  private async requireMember(context: ProjectChatContext) {
    const member = await this.repository.findMemberByActorKey(
      context.spaceId,
      projectChatActorKey(context.actor)
    );
    if (!member) {
      throw new ProjectChatError('not_member', 'Project Chat membership is required.');
    }
    if (context.actor.kind === 'agent') {
      const claim = await this.repository.findNameClaimByThread(
        context.spaceId,
        context.actor.accountId,
        context.actor.threadId
      );
      if (!claim) {
        throw new ProjectChatError('forbidden', 'A current Project Chat registry claim is required.');
      }
      const parent = claim.parentThreadId
        ? await this.repository.findNameClaimByThread(context.spaceId, context.actor.accountId, claim.parentThreadId)
        : null;
      const displayName = parent ? `${parent.displayName}.${claim.displayName}` : claim.displayName;
      if (
        member.displayName !== displayName ||
        member.agentName?.name !== claim.displayName ||
        member.agentName.category !== claim.category ||
        member.agentName.displayName !== displayName ||
        member.agentName.parentThreadId !== claim.parentThreadId
      ) {
        throw new ProjectChatError('forbidden', 'Project Chat membership does not match its registry claim.');
      }
    }
    return member;
  }

  private humanProfileRecord(context: ProjectChatContext, now: Date) {
    const actor = requireHumanActor(context);
    return {
      accountId: actor.accountId,
      createdAt: now.toISOString(),
      defaultAvatarUrl: actor.avatarUrl,
      defaultDisplayName: actor.displayName,
      revision: 1,
      spaceId: context.spaceId,
      updatedAt: now.toISOString()
    } satisfies ProjectChatHumanProfileRecord;
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

function memberIdentity(
  actor: ProjectChatActor,
  profile: ProjectChatJoinInput,
  humanProfile?: ProjectChatHumanProfileRecord
) {
  switch (actor.kind) {
    case 'human': {
      if (!humanProfile) {
        throw new Error('Project Chat human profile is unavailable.');
      }
      return {
        avatarUrl: humanProfile.avatarDataUrlOverride ?? humanProfile.defaultAvatarUrl,
        displayName: humanProfile.displayNameOverride ?? humanProfile.defaultDisplayName,
        handle: actor.handle,
        role: 'human' as const
      };
    }
    case 'agent': {
      const displayName = profile.displayName!;
      const origin: ProjectChatOrigin = {
        threadId: actor.threadId,
        hostId: actor.hostId,
        machineId: actor.machineId,
        taskTitle: profile.taskTitle
      };
      return {
        avatarUrl: undefined,
        displayName,
        handle: normalizeProjectChatHandle(displayName),
        role: 'agent' as const,
        origin
      };
    }
    case 'system':
      return {
        avatarUrl: undefined,
        displayName: actor.displayName,
        handle: actor.handle,
        role: 'system' as const
      };
  }
}

function publicHumanProfile(
  handle: string,
  profile: ProjectChatHumanProfileRecord
): ProjectChatHumanProfile {
  const avatarUrl = profile.avatarDataUrlOverride ?? profile.defaultAvatarUrl;
  return {
    avatarSource: profile.avatarDataUrlOverride
      ? 'custom'
      : profile.defaultAvatarUrl
        ? 'account'
        : 'none',
    ...(avatarUrl ? { avatarUrl } : {}),
    ...(profile.defaultAvatarUrl ? { defaultAvatarUrl: profile.defaultAvatarUrl } : {}),
    defaultDisplayName: profile.defaultDisplayName,
    displayName: profile.displayNameOverride ?? profile.defaultDisplayName,
    handle,
    revision: profile.revision,
    updatedAt: profile.updatedAt
  };
}

function requireHumanActor(context: ProjectChatContext) {
  if (context.actor.kind !== 'human') {
    throw new ProjectChatError('forbidden', 'Only the authenticated human can edit this profile.');
  }
  return context.actor;
}
