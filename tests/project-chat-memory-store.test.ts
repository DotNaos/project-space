import { describe, expect, test } from 'bun:test';
import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '../server/project-chat/contracts';
import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError
} from '../server/project-chat/repository';

const spaceId = 'space-test';
const channelId = 'general';
const createdAt = '2026-07-11T00:00:00.000Z';
const expiresAt = '2026-07-12T00:00:00.000Z';

function member(overrides: Partial<ProjectChatMemberRecord> = {}): ProjectChatMemberRecord {
  return {
    spaceId,
    actorKey: '["agent","account","machine","thread"]',
    memberId: 'member-1',
    displayName: 'Mira',
    handle: 'mira',
    role: 'agent',
    origin: {
      hostId: 'host-1',
      machineId: 'machine-1',
      threadId: 'thread-1'
    },
    joinedAt: createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

function message(
  id: string,
  body = id,
  expiration = expiresAt
): Omit<ProjectChatMessageRecord, 'sequence'> {
  return {
    spaceId,
    senderMemberId: 'member-1',
    id,
    channelId,
    body,
    sender: {
      memberId: 'member-1',
      displayName: 'Mira',
      handle: 'mira',
      role: 'agent'
    },
    mentions: [],
    createdAt,
    expiresAt: expiration
  };
}

async function readyStore() {
  const store = new InMemoryProjectChatRepository();
  await store.ensureChannel({
    spaceId,
    channelId,
    kind: 'general',
    name: 'General',
    createdAt
  });
  await store.upsertMember(member());
  return store;
}

describe('in-memory Project Chat repository', () => {
  test('keeps one project channel across repeated ensures, rename, and snapshot restore', async () => {
    const store = new InMemoryProjectChatRepository();
    const first = await store.ensureChannel({
      accountId: 'account-1',
      channelId: 'channel-project-a',
      createdAt,
      kind: 'project',
      name: 'Original name',
      projectId: 'project-a',
      spaceId
    });
    const renamed = await store.ensureChannel({
      accountId: 'account-1',
      channelId: 'channel-project-a-race',
      createdAt,
      kind: 'project',
      name: 'Renamed project',
      projectId: 'project-a',
      spaceId
    });
    expect(renamed).toMatchObject({
      channelId: first.channelId,
      name: 'Renamed project',
      projectId: 'project-a'
    });

    const restored = new InMemoryProjectChatRepository(await store.snapshot());
    expect(await restored.findChannel(spaceId, first.channelId)).toMatchObject({
      channelId: first.channelId,
      name: 'Renamed project',
      projectId: 'project-a'
    });
  });

  test('serializes 100 concurrent appends into one monotonic channel sequence', async () => {
    const store = await readyStore();
    const writes = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      store.appendMessage({
        idempotencyKey: `request-${index}`,
        message: message(`message-${index}`)
      })));

    expect(writes.map((write) => write.message.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1)
    );
    const page = await store.readMessages({
      spaceId,
      channelId,
      afterSequence: 0,
      limit: 100,
      now: createdAt
    });
    expect(page.messages).toHaveLength(100);
    expect(new Set(page.messages.map((entry) => entry.id)).size).toBe(100);
    expect(page.latestSequence).toBe(100);
    expect(page.hasMore).toBe(false);
  });

  test('deduplicates matching request keys and rejects conflicting reuse', async () => {
    const store = await readyStore();
    const first = await store.appendMessage({
      idempotencyKey: 'same-request',
      message: message('message-1', 'Hello')
    });
    const retry = await store.appendMessage({
      idempotencyKey: 'same-request',
      message: message('message-2', 'Hello')
    });

    expect(first.inserted).toBe(true);
    expect(retry.inserted).toBe(false);
    expect(retry.message).toEqual(first.message);
    await expect(store.appendMessage({
      idempotencyKey: 'same-request',
      message: message('message-3', 'Different')
    })).rejects.toBeInstanceOf(ProjectChatIdempotencyConflictError);
    expect(await store.getChannelSequence(spaceId, channelId)).toBe(1);
  });

  test('persists monotonic cursors and sequences through a snapshot restore', async () => {
    const store = await readyStore();
    await store.appendMessage({ idempotencyKey: 'one', message: message('message-1') });
    await store.appendMessage({ idempotencyKey: 'two', message: message('message-2') });
    expect(await store.acknowledgeCursor({
      spaceId,
      memberId: 'member-1',
      channelId,
      throughSequence: 2,
      updatedAt: createdAt
    })).toBe(2);
    expect(await store.acknowledgeCursor({
      spaceId,
      memberId: 'member-1',
      channelId,
      throughSequence: 1,
      updatedAt: createdAt
    })).toBe(2);

    const restored = new InMemoryProjectChatRepository(await store.snapshot());
    expect(await restored.getCursor(spaceId, 'member-1', channelId)).toBe(2);
    const next = await restored.appendMessage({
      idempotencyKey: 'three',
      message: message('message-3')
    });
    expect(next.message.sequence).toBe(3);
    await expect(restored.acknowledgeCursor({
      spaceId,
      memberId: 'member-1',
      channelId,
      throughSequence: 4,
      updatedAt: createdAt
    })).rejects.toBeInstanceOf(ProjectChatCursorOutOfRangeError);
  });

  test('filters expired messages before purge and removes their idempotency state', async () => {
    const store = await readyStore();
    await store.appendMessage({
      idempotencyKey: 'expired',
      message: message('message-old', 'old', '2026-07-11T01:00:00.000Z')
    });
    await store.appendMessage({
      idempotencyKey: 'fresh',
      message: message('message-new', 'new', '2026-07-11T03:00:00.000Z')
    });
    const now = '2026-07-11T02:00:00.000Z';
    const page = await store.readMessages({
      spaceId,
      channelId,
      afterSequence: 0,
      limit: 10,
      now
    });
    expect(page.messages.map((entry) => entry.body)).toEqual(['new']);
    expect(page.latestSequence).toBe(2);
    expect(await store.purgeExpired(now)).toBe(1);

    const replacement = await store.appendMessage({
      idempotencyKey: 'expired',
      message: message('message-reused', 'replacement', '2026-07-11T04:00:00.000Z')
    });
    expect(replacement.inserted).toBe(true);
    expect(replacement.message.sequence).toBe(3);
  });

  test('enforces a unique case-insensitive mention handle per space', async () => {
    const store = await readyStore();
    await expect(store.upsertMember(member({
      actorKey: 'other-actor',
      memberId: 'member-2',
      displayName: 'MIRA',
      handle: 'MIRA'
    }))).rejects.toBeInstanceOf(ProjectChatHandleConflictError);
  });

  test('keeps the stored human handle during a profile-only update', async () => {
    const store = await readyStore();
    await store.ensureHumanProfile({
      accountId: 'user-olli',
      createdAt,
      defaultDisplayName: 'Olli Account',
      revision: 1,
      spaceId,
      updatedAt: createdAt
    });
    const human = member({
      actorKey: '["human","user-olli"]',
      displayName: 'Olli Account',
      handle: 'olli',
      memberId: 'member-human',
      origin: undefined,
      profileRevision: 1,
      role: 'human'
    });
    await store.upsertMember(human);
    await store.upsertMember(member({
      actorKey: 'other-agent',
      displayName: 'Taken',
      handle: 'taken',
      memberId: 'member-taken'
    }));

    await expect(store.updateHumanProfileAndMember({
      accountId: 'user-olli',
      displayNameOverride: 'Olli Chat',
      spaceId,
      updatedAt: '2026-07-11T00:01:00.000Z'
    }, {
      ...human,
      handle: 'taken'
    })).resolves.toMatchObject({
      member: {
        displayName: 'Olli Chat',
        handle: 'olli',
        memberId: 'member-human'
      },
      profile: {
        displayNameOverride: 'Olli Chat',
        revision: 2
      }
    });

    expect(await store.findMemberByActorKey(spaceId, 'other-agent')).toMatchObject({
      handle: 'taken',
      memberId: 'member-taken'
    });
  });

  test('returns defensive copies instead of mutable store state', async () => {
    const store = await readyStore();
    const stored = await store.appendMessage({
      idempotencyKey: 'copy',
      message: message('message-copy', 'original')
    });
    stored.message.body = 'tampered';
    const page = await store.readMessages({
      spaceId,
      channelId,
      afterSequence: 0,
      limit: 10,
      now: createdAt
    });
    expect(page.messages[0].body).toBe('original');
  });
});
