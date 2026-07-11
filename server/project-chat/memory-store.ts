import type {
  ProjectChatChannelRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatPresenceRecord
} from './contracts';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError,
  type ProjectChatAppendInput,
  type ProjectChatRepository
} from './repository';

interface IdempotencyRecord {
  messageId: string;
  body: string;
  expiresAt: string;
}

export interface ProjectChatMemorySnapshot {
  channels: ProjectChatChannelRecord[];
  members: ProjectChatMemberRecord[];
  presences: ProjectChatPresenceRecord[];
  messages: ProjectChatMessageRecord[];
  channelSequences: Array<[string, number]>;
  cursors: Array<[string, number]>;
  idempotency: Array<[string, IdempotencyRecord]>;
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

function memberKey(spaceId: string, memberId: string) {
  return compoundKey(spaceId, memberId);
}

export class InMemoryProjectChatRepository implements ProjectChatRepository {
  private readonly channels = new Map<string, ProjectChatChannelRecord>();
  private readonly membersById = new Map<string, ProjectChatMemberRecord>();
  private readonly memberIdByActor = new Map<string, string>();
  private readonly memberIdByHandle = new Map<string, string>();
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
    for (const channel of snapshot.channels) {
      this.channels.set(channelKey(channel.spaceId, channel.channelId), copy(channel));
    }
    for (const member of snapshot.members) {
      this.restoreMember(copy(member));
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
      members: [...this.membersById.values()].map(copy),
      presences: [...this.presences.values()].map(copy),
      messages: [...this.messagesById.values()].sort((a, b) => a.sequence - b.sequence).map(copy),
      channelSequences: [...this.channelSequences.entries()],
      cursors: [...this.cursors.entries()],
      idempotency: [...this.idempotency.entries()].map(([key, value]) => [key, copy(value)])
    }));
  }

  async ensureChannel(channel: ProjectChatChannelRecord) {
    return this.exclusive(() => {
      const key = channelKey(channel.spaceId, channel.channelId);
      const existing = this.channels.get(key);
      if (existing) {
        return copy(existing);
      }
      this.channels.set(key, copy(channel));
      this.channelSequences.set(key, this.channelSequences.get(key) ?? 0);
      return copy(channel);
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
    return this.exclusive(() => {
      const actorIndexKey = compoundKey(member.spaceId, member.actorKey);
      const existingId = this.memberIdByActor.get(actorIndexKey);
      const existing = existingId
        ? this.membersById.get(memberKey(member.spaceId, existingId))
        : undefined;
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
    });
  }

  async listMembers(spaceId: string) {
    return this.exclusive(() => [...this.membersById.values()]
      .filter((member) => member.spaceId === spaceId)
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

  private restoreMember(member: ProjectChatMemberRecord) {
    this.membersById.set(memberKey(member.spaceId, member.memberId), member);
    this.memberIdByActor.set(compoundKey(member.spaceId, member.actorKey), member.memberId);
    this.memberIdByHandle.set(compoundKey(member.spaceId, member.handle.toLowerCase()), member.memberId);
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
