import type {
  ProjectChatChannelRecord,
  ProjectChatHumanProfileRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatNameClaimRecord,
  ProjectChatPresenceRecord
} from './contracts';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError,
  ProjectChatNameClaimConflictError,
  memberWithHumanProfile,
  type ProjectChatAppendInput,
  type ProjectChatHumanProfileUpdate,
  type ProjectChatRepository
} from './repository';

interface IdempotencyRecord {
  messageId: string;
  body: string;
  expiresAt: string;
}

export interface ProjectChatMemorySnapshot {
  nameClaims?: ProjectChatNameClaimRecord[];
  channels: ProjectChatChannelRecord[];
  humanProfiles?: ProjectChatHumanProfileRecord[];
  members: ProjectChatMemberRecord[];
  presences: ProjectChatPresenceRecord[];
  messages: ProjectChatMessageRecord[];
  channelSequences: Array<[string, number]>;
  cursors: Array<[string, number]>;
  idempotency: Array<[string, IdempotencyRecord]>;
  retiredNameLeaseMemberIds?: string[];
}

function compoundKey(...parts: string[]) {
  return JSON.stringify(parts);
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function channelKey(spaceId: string, channelId: string) {
  return compoundKey(spaceId, channelId);
}

function projectChannelKey(spaceId: string, accountId: string, projectId: string) {
  return compoundKey(spaceId, accountId, projectId);
}

function memberKey(spaceId: string, memberId: string) {
  return compoundKey(spaceId, memberId);
}

export class InMemoryProjectChatRepository implements ProjectChatRepository {
  private readonly nameClaims = new Map<string, ProjectChatNameClaimRecord>();
  private readonly channels = new Map<string, ProjectChatChannelRecord>();
  private readonly channelIdByProject = new Map<string, string>();
  private readonly humanProfiles = new Map<string, ProjectChatHumanProfileRecord>();
  private readonly membersById = new Map<string, ProjectChatMemberRecord>();
  private readonly memberIdByActor = new Map<string, string>();
  private readonly memberIdByHandle = new Map<string, string>();
  private readonly retiredNameLeaseMemberIds = new Set<string>();
  private readonly presences = new Map<string, ProjectChatPresenceRecord>();
  private readonly messagesByChannel = new Map<string, ProjectChatMessageRecord[]>();
  private readonly messagesById = new Map<string, ProjectChatMessageRecord>();
  private readonly channelSequences = new Map<string, number>();
  private readonly cursors = new Map<string, number>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private queue: Promise<void> = Promise.resolve();

  constructor(snapshot?: ProjectChatMemorySnapshot) {
    if (!snapshot) {
      return;
    }
    for (const claim of snapshot.nameClaims ?? []) this.nameClaims.set(compoundKey(claim.spaceId, claim.nameKey), copy(claim));
    for (const channel of snapshot.channels) {
      const restored = copy(channel);
      this.channels.set(channelKey(channel.spaceId, channel.channelId), restored);
      if (restored.kind === 'project' && restored.accountId && restored.projectId) {
        this.channelIdByProject.set(
          projectChannelKey(restored.spaceId, restored.accountId, restored.projectId),
          restored.channelId
        );
      }
    }
    for (const profile of snapshot.humanProfiles ?? []) {
      this.humanProfiles.set(compoundKey(profile.spaceId, profile.accountId), copy({
        ...profile,
        revision: profile.revision ?? 1
      }));
    }
    for (const member of snapshot.members) {
      this.restoreMember(copy(member));
    }
    for (const memberId of snapshot.retiredNameLeaseMemberIds ?? []) {
      const stored = snapshot.members.find((candidate) => candidate.memberId === memberId);
      const member = stored
        ? this.membersById.get(memberKey(stored.spaceId, memberId))
        : undefined;
      if (member) {
        this.retiredNameLeaseMemberIds.add(memberId);
        this.memberIdByHandle.delete(compoundKey(member.spaceId, member.handle.toLowerCase()));
      }
    }
    for (const presence of snapshot.presences) {
      this.presences.set(memberKey(presence.spaceId, presence.memberId), copy(presence));
    }
    for (const message of snapshot.messages) {
      const record = copy(message);
      const key = channelKey(record.spaceId, record.channelId);
      const messages = this.messagesByChannel.get(key) ?? [];
      messages.push(record);
      this.messagesByChannel.set(key, messages);
      this.messagesById.set(record.id, record);
    }
    for (const [key, sequence] of snapshot.channelSequences) {
      this.channelSequences.set(key, sequence);
    }
    for (const [key, sequence] of snapshot.cursors) {
      this.cursors.set(key, sequence);
    }
    for (const [key, record] of snapshot.idempotency) {
      this.idempotency.set(key, copy(record));
    }
  }

  async snapshot(): Promise<ProjectChatMemorySnapshot> {
    return this.exclusive(() => ({
      channels: [...this.channels.values()].map(copy),
      nameClaims: [...this.nameClaims.values()].map(copy),
      humanProfiles: [...this.humanProfiles.values()].map(copy),
      members: [...this.membersById.values()].map(copy),
      presences: [...this.presences.values()].map(copy),
      messages: [...this.messagesById.values()].sort((a, b) => a.sequence - b.sequence).map(copy),
      channelSequences: [...this.channelSequences.entries()],
      cursors: [...this.cursors.entries()],
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, copy(value)]),
      retiredNameLeaseMemberIds: [...this.retiredNameLeaseMemberIds]
    }));
  }

  async listNameClaims(spaceId: string) {
    return [...this.nameClaims.values()].filter((c) => c.spaceId === spaceId).map(copy);
  }

  async findNameClaimByThread(spaceId: string, accountId: string, threadId: string) {
    return copy([...this.nameClaims.values()].find((c) => c.spaceId === spaceId && c.accountId === accountId && c.threadId === threadId) ?? null);
  }

  async claimName(claim: ProjectChatNameClaimRecord) {
    return this.exclusive(() => {
      const existingThread = [...this.nameClaims.values()].find((c) => c.spaceId === claim.spaceId && c.accountId === claim.accountId && c.threadId === claim.threadId);
      if (existingThread) {
        if (existingThread.nameKey === claim.nameKey) {
          const renewed = { ...claim, claimedAt: existingThread.claimedAt };
          this.nameClaims.set(compoundKey(renewed.spaceId, renewed.nameKey), copy(renewed));
          return copy(renewed);
        }
        const targetKey = compoundKey(claim.spaceId, claim.nameKey);
        if (this.nameClaims.has(targetKey)) throw new ProjectChatNameClaimConflictError('name_claimed');
        this.nameClaims.delete(compoundKey(existingThread.spaceId, existingThread.nameKey));
        const renamed = {...claim, claimedAt:existingThread.claimedAt};
        this.nameClaims.set(targetKey, copy(renamed));
        return copy(renamed);
      }
      const key = compoundKey(claim.spaceId, claim.nameKey);
      if (this.nameClaims.has(key)) throw new ProjectChatNameClaimConflictError('name_claimed');
      this.nameClaims.set(key, copy(claim));
      return copy(claim);
    });
  }

  async restoreNameClaim(current: ProjectChatNameClaimRecord, previous: ProjectChatNameClaimRecord | null) {
    return this.exclusive(() => {
      const key=compoundKey(current.spaceId,current.nameKey);
      const stored=this.nameClaims.get(key);
      if (!stored || stored.accountId!==current.accountId || stored.threadId!==current.threadId || stored.updatedAt!==current.updatedAt) return;
      this.nameClaims.delete(key);
      if (previous) this.nameClaims.set(compoundKey(previous.spaceId,previous.nameKey),copy(previous));
    });
  }

  async reapExpiredNameClaims(spaceId: string, expiresAtOrBefore: string) {
    return this.exclusive(() => {
      const claims = [...this.nameClaims.values()].filter((claim) => claim.spaceId === spaceId);
      const expired = claims.filter((claim) =>
        claim.updatedAt <= expiresAtOrBefore &&
        (claim.category !== 'mythology' || !claims.some((child) =>
          child.parentThreadId === claim.threadId && child.updatedAt > expiresAtOrBefore
        ))
      );
      for (const claim of expired) {
        this.nameClaims.delete(compoundKey(claim.spaceId, claim.nameKey));
        const memberId = this.memberIdByActor.get(compoundKey(claim.spaceId, claim.actorKey));
        const member = memberId
          ? this.membersById.get(memberKey(claim.spaceId, memberId))
          : undefined;
        if (member) {
          this.memberIdByHandle.delete(compoundKey(member.spaceId, member.handle.toLowerCase()));
          this.retiredNameLeaseMemberIds.add(member.memberId);
          this.membersById.set(memberKey(member.spaceId, member.memberId), {
            ...member,
            agentName: undefined,
            updatedAt: expiresAtOrBefore
          });
        }
      }
      return expired.length;
    });
  }

  async ensureHumanProfile(
    profile: ProjectChatHumanProfileRecord,
    options: { refreshDefaults?: boolean } = {}
  ) {
    return this.exclusive(() => this.ensureHumanProfileRecord(profile, options));
  }

  async ensureHumanProfileAndMember(
    profile: ProjectChatHumanProfileRecord,
    member: ProjectChatMemberRecord,
    options: { refreshDefaults?: boolean } = {}
  ) {
    return this.exclusive(() => {
      const profileKey = compoundKey(profile.spaceId, profile.accountId);
      const previousProfile = this.humanProfiles.get(profileKey);
      const storedProfile = this.ensureHumanProfileRecord(profile, options);
      try {
        const existingMemberId = this.memberIdByActor.get(
          compoundKey(member.spaceId, member.actorKey)
        );
        const existingMember = existingMemberId
          ? this.membersById.get(memberKey(member.spaceId, existingMemberId))
          : undefined;
        const defaultsWereStale = options.refreshDefaults !== false
          && profile.updatedAt < storedProfile.updatedAt;
        if (defaultsWereStale && existingMember?.role === 'human') {
          return { member: copy(existingMember), profile: storedProfile };
        }
        const updatedMember = this.upsertMemberRecord(
          memberWithHumanProfile(member, storedProfile)
        );
        return { member: updatedMember, profile: storedProfile };
      } catch (error) {
        if (previousProfile) {
          this.humanProfiles.set(profileKey, previousProfile);
        } else {
          this.humanProfiles.delete(profileKey);
        }
        throw error;
      }
    });
  }

  async findHumanProfile(spaceId: string, accountId: string) {
    return this.exclusive(() => {
      const profile = this.humanProfiles.get(compoundKey(spaceId, accountId));
      return profile ? copy(profile) : null;
    });
  }

  async findHumanProfileAndMember(spaceId: string, accountId: string, actorKey: string) {
    return this.exclusive(() => {
      const profile = this.humanProfiles.get(compoundKey(spaceId, accountId));
      const memberId = this.memberIdByActor.get(compoundKey(spaceId, actorKey));
      const member = memberId ? this.membersById.get(memberKey(spaceId, memberId)) : undefined;
      return {
        member: member ? copy(member) : null,
        profile: profile ? copy(profile) : null
      };
    });
  }

  async updateHumanProfileAndMember(
    input: ProjectChatHumanProfileUpdate,
    member: ProjectChatMemberRecord
  ) {
    return this.exclusive(() => {
      const profileKey = compoundKey(input.spaceId, input.accountId);
      const previousProfile = this.humanProfiles.get(profileKey);
      const existingMemberId = this.memberIdByActor.get(
        compoundKey(member.spaceId, member.actorKey)
      );
      const existingMember = existingMemberId
        ? this.membersById.get(memberKey(member.spaceId, existingMemberId))
        : undefined;
      const profile = this.updateHumanProfileRecord(input);
      try {
        const memberIdentity = existingMember?.role === 'human'
          ? existingMember
          : member;
        const updatedMember = this.upsertMemberRecord(
          memberWithHumanProfile(memberIdentity, profile)
        );
        return { member: updatedMember, profile };
      } catch (error) {
        if (previousProfile) {
          this.humanProfiles.set(profileKey, previousProfile);
        } else {
          this.humanProfiles.delete(profileKey);
        }
        throw error;
      }
    });
  }

  async ensureChannel(channel: ProjectChatChannelRecord) {
    return this.exclusive(() => {
      if (channel.kind === 'project' && channel.accountId && channel.projectId) {
        const projectKey = projectChannelKey(channel.spaceId, channel.accountId, channel.projectId);
        const existingChannelId = this.channelIdByProject.get(projectKey);
        const existingProjectChannel = existingChannelId
          ? this.channels.get(channelKey(channel.spaceId, existingChannelId))
          : undefined;
        if (existingProjectChannel) {
          const updated = { ...existingProjectChannel, name: channel.name };
          this.channels.set(channelKey(updated.spaceId, updated.channelId), updated);
          return copy(updated);
        }
        this.channelIdByProject.set(projectKey, channel.channelId);
      }
      const key = channelKey(channel.spaceId, channel.channelId);
      const existing = this.channels.get(key);
      if (existing) {
        const updated = { ...existing, name: channel.name };
        this.channels.set(key, updated);
        return copy(updated);
      }
      this.channels.set(key, copy(channel));
      this.channelSequences.set(key, this.channelSequences.get(key) ?? 0);
      return copy(channel);
    });
  }

  async findChannel(spaceId: string, channelId: string) {
    return this.exclusive(() => {
      const channel = this.channels.get(channelKey(spaceId, channelId));
      return channel ? copy(channel) : null;
    });
  }

  async findMemberByActorKey(spaceId: string, actorKey: string) {
    return this.exclusive(() => {
      const id = this.memberIdByActor.get(compoundKey(spaceId, actorKey));
      const member = id ? this.membersById.get(memberKey(spaceId, id)) : undefined;
      return member ? copy(member) : null;
    });
  }

  async findMemberById(spaceId: string, memberId: string) {
    return this.exclusive(() => {
      const member = this.membersById.get(memberKey(spaceId, memberId));
      return member ? copy(member) : null;
    });
  }

  async upsertMember(member: ProjectChatMemberRecord) {
    return this.exclusive(() => this.upsertMemberRecord(member));
  }

  async listMembers(spaceId: string) {
    return this.exclusive(() => [...this.membersById.values()]
      .filter((member) =>
        member.spaceId === spaceId && !this.retiredNameLeaseMemberIds.has(member.memberId)
      )
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt) || a.memberId.localeCompare(b.memberId))
      .map(copy));
  }

  async setPresence(presence: ProjectChatPresenceRecord) {
    return this.exclusive(() => {
      this.presences.set(memberKey(presence.spaceId, presence.memberId), copy(presence));
      return copy(presence);
    });
  }

  async getPresence(spaceId: string, memberId: string) {
    return this.exclusive(() => {
      const presence = this.presences.get(memberKey(spaceId, memberId));
      return presence ? copy(presence) : null;
    });
  }

  async listPresences(spaceId: string) {
    return this.exclusive(() => [...this.presences.values()]
      .filter((presence) => presence.spaceId === spaceId)
      .map(copy));
  }

  async appendMessage(input: ProjectChatAppendInput) {
    return this.exclusive(() => {
      const { message } = input;
      const key = channelKey(message.spaceId, message.channelId);
      if (!this.channels.has(key)) {
        throw new Error('Project Chat channel has not been created.');
      }
      const idempotencyKey = compoundKey(
        message.spaceId,
        message.channelId,
        message.senderMemberId,
        input.idempotencyKey
      );
      const previous = this.idempotency.get(idempotencyKey);
      if (previous) {
        if (previous.body !== message.body) {
          throw new ProjectChatIdempotencyConflictError();
        }
        const existing = this.messagesById.get(previous.messageId);
        if (existing) {
          return { inserted: false, message: copy(existing) };
        }
        this.idempotency.delete(idempotencyKey);
      }
      const sequence = (this.channelSequences.get(key) ?? 0) + 1;
      const record = { ...copy(message), sequence };
      this.channelSequences.set(key, sequence);
      this.messagesById.set(record.id, record);
      this.messagesByChannel.set(key, [...(this.messagesByChannel.get(key) ?? []), record]);
      this.idempotency.set(idempotencyKey, {
        body: record.body,
        expiresAt: record.expiresAt,
        messageId: record.id
      });
      return { inserted: true, message: copy(record) };
    });
  }

  async readMessages(input: {
    spaceId: string;
    channelId: string;
    afterSequence: number;
    limit: number;
    now: string;
  }) {
    return this.exclusive(() => {
      const key = channelKey(input.spaceId, input.channelId);
      const latestSequence = this.channelSequences.get(key) ?? 0;
      if (input.afterSequence > latestSequence) {
        throw new ProjectChatCursorOutOfRangeError();
      }
      const eligible = (this.messagesByChannel.get(key) ?? []).filter(
        (message) => message.sequence > input.afterSequence && message.expiresAt > input.now
      );
      return {
        messages: eligible.slice(0, input.limit).map(copy),
        latestSequence,
        hasMore: eligible.length > input.limit
      };
    });
  }

  async listUnreadMentions(input: {
    spaceId: string;
    channelId: string;
    memberId: string;
    afterSequence: number;
    limit: number;
    now: string;
  }) {
    return this.exclusive(() => {
      const messages = (this.messagesByChannel.get(channelKey(input.spaceId, input.channelId)) ?? [])
        .filter((message) =>
          message.sequence > input.afterSequence
          && message.expiresAt > input.now
          && message.mentions.some((mention) => mention.memberId === input.memberId)
        );
      return { messages: messages.slice(0, input.limit).map(copy), unreadCount: messages.length };
    });
  }

  async getChannelSequence(spaceId: string, channelId: string) {
    return this.exclusive(() => this.channelSequences.get(channelKey(spaceId, channelId)) ?? 0);
  }

  async getCursor(spaceId: string, memberId: string, channelId: string) {
    return this.exclusive(() => this.cursors.get(compoundKey(spaceId, memberId, channelId)) ?? 0);
  }

  async acknowledgeCursor(input: {
    spaceId: string;
    memberId: string;
    channelId: string;
    throughSequence: number;
    updatedAt: string;
  }) {
    return this.exclusive(() => {
      const latest = this.channelSequences.get(channelKey(input.spaceId, input.channelId)) ?? 0;
      if (input.throughSequence > latest) {
        throw new ProjectChatCursorOutOfRangeError();
      }
      const key = compoundKey(input.spaceId, input.memberId, input.channelId);
      const sequence = Math.max(this.cursors.get(key) ?? 0, input.throughSequence);
      this.cursors.set(key, sequence);
      return sequence;
    });
  }

  async purgeExpired(now: string) {
    return this.exclusive(() => {
      let removed = 0;
      for (const [key, messages] of this.messagesByChannel) {
        const retained = messages.filter((message) => {
          if (message.expiresAt > now) {
            return true;
          }
          removed += 1;
          this.messagesById.delete(message.id);
          return false;
        });
        this.messagesByChannel.set(key, retained);
      }
      for (const [key, record] of this.idempotency) {
        if (record.expiresAt <= now || !this.messagesById.has(record.messageId)) {
          this.idempotency.delete(key);
        }
      }
      return removed;
    });
  }

  private ensureHumanProfileRecord(
    profile: ProjectChatHumanProfileRecord,
    options: { refreshDefaults?: boolean }
  ) {
    const key = compoundKey(profile.spaceId, profile.accountId);
    const existing = this.humanProfiles.get(key);
    const refreshDefaults = options.refreshDefaults !== false
      && (!existing || profile.updatedAt >= existing.updatedAt);
    const next = existing
      ? {
          ...existing,
          ...(refreshDefaults
            ? {
                defaultAvatarUrl: profile.defaultAvatarUrl,
                defaultDisplayName: profile.defaultDisplayName,
                revision: existing.revision + 1
              }
              : {}),
          updatedAt: refreshDefaults ? profile.updatedAt : existing.updatedAt
        }
      : copy(profile);
    this.humanProfiles.set(key, copy(next));
    return copy(next);
  }

  private updateHumanProfileRecord(input: ProjectChatHumanProfileUpdate) {
    const key = compoundKey(input.spaceId, input.accountId);
    const existing = this.humanProfiles.get(key);
    if (!existing) {
      throw new Error('Project Chat human profile has not been created.');
    }
    const next = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: input.updatedAt > existing.updatedAt ? input.updatedAt : existing.updatedAt
    };
    if (Object.hasOwn(input, 'displayNameOverride')) {
      if (input.displayNameOverride === null) {
        delete next.displayNameOverride;
      } else if (input.displayNameOverride !== undefined) {
        next.displayNameOverride = input.displayNameOverride;
      }
    }
    if (Object.hasOwn(input, 'avatarDataUrlOverride')) {
      if (input.avatarDataUrlOverride === null) {
        delete next.avatarDataUrlOverride;
      } else if (input.avatarDataUrlOverride !== undefined) {
        next.avatarDataUrlOverride = input.avatarDataUrlOverride;
      }
    }
    this.humanProfiles.set(key, copy(next));
    return copy(next);
  }

  private upsertMemberRecord(member: ProjectChatMemberRecord) {
    const actorIndexKey = compoundKey(member.spaceId, member.actorKey);
    const existingId = this.memberIdByActor.get(actorIndexKey);
    const existing = existingId
      ? this.membersById.get(memberKey(member.spaceId, existingId))
      : undefined;
    if (
      existing?.role === 'human' &&
      member.role === 'human' &&
      (existing.profileRevision ?? 0) > (member.profileRevision ?? 0)
    ) {
      return copy(existing);
    }
    const handleIndexKey = compoundKey(member.spaceId, member.handle.toLowerCase());
    const handleOwner = this.memberIdByHandle.get(handleIndexKey);
    if (handleOwner && handleOwner !== existing?.memberId) {
      throw new ProjectChatHandleConflictError();
    }
    const next = existing
      ? { ...member, joinedAt: existing.joinedAt, memberId: existing.memberId }
      : member;
    if (existing && existing.handle.toLowerCase() !== next.handle.toLowerCase()) {
      this.memberIdByHandle.delete(compoundKey(member.spaceId, existing.handle.toLowerCase()));
    }
    this.restoreMember(copy(next));
    return copy(next);
  }

  private restoreMember(member: ProjectChatMemberRecord) {
    this.retiredNameLeaseMemberIds.delete(member.memberId);
    this.membersById.set(memberKey(member.spaceId, member.memberId), member);
    this.memberIdByActor.set(compoundKey(member.spaceId, member.actorKey), member.memberId);
    if (!this.retiredNameLeaseMemberIds.has(member.memberId)) {
      this.memberIdByHandle.set(compoundKey(member.spaceId, member.handle.toLowerCase()), member.memberId);
    }
  }

  private async exclusive<T>(operation: () => T | Promise<T>) {
    const previous = this.queue;
    let release = () => {};
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
