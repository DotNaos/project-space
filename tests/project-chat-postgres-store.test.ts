import { describe, expect, test } from 'bun:test';

import type {
  DatabaseQueryClient,
  DatabaseQueryResult
} from '../server/database/client';
import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord,
  ProjectChatNameClaimRecord,
  ProjectChatPresenceRecord
} from '../server/project-chat/contracts';
import { updatePostgresHumanProfile } from '../server/project-chat/postgres-human-profile';
import { PostgresProjectChatRepository } from '../server/project-chat/postgres-store';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError
} from '../server/project-chat/repository';

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

type Response =
  | DatabaseQueryResult<unknown>
  | Error
  | ((call: QueryCall) => DatabaseQueryResult<unknown> | Promise<DatabaseQueryResult<unknown>>);

class RecordingClient implements DatabaseQueryClient {
  readonly calls: QueryCall[] = [];
  readonly events: string[] = [];

  constructor(private readonly responses: Response[]) {}

  async query<Row>(sql: string, values: readonly unknown[] = []) {
    const call = { sql, values };
    this.calls.push(call);
    this.events.push(sql.trim().split(/\s+/, 1)[0] ?? 'query');
    const response = this.responses.shift();
    if (!response) {
      throw new Error(`Unexpected query: ${sql}`);
    }
    if (response instanceof Error) {
      throw response;
    }
    const result = typeof response === 'function' ? await response(call) : response;
    return result as DatabaseQueryResult<Row>;
  }

  async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
    this.events.push('begin');
    try {
      const result = await operation(this);
      this.events.push('commit');
      return result;
    } catch (error) {
      this.events.push('rollback');
      throw error;
    }
  }
}

function rows<Row>(values: Row[], rowCount = values.length): DatabaseQueryResult<Row> {
  return { rowCount, rows: values };
}

const createdAt = '2026-07-11T10:00:00.000Z';
const expiresAt = '2026-07-12T10:00:00.000Z';

function memberRecord(overrides: Partial<ProjectChatMemberRecord> = {}): ProjectChatMemberRecord {
  return {
    actorKey: 'agent:machine-a:thread-a',
    displayName: 'Galileo',
    handle: 'galileo',
    joinedAt: createdAt,
    memberId: 'member-a',
    origin: {
      hostId: 'host-a',
      machineId: 'machine-a',
      taskTitle: 'Postgres repository',
      threadId: 'thread-a'
    },
    role: 'agent',
    spaceId: 'space-a',
    updatedAt: createdAt,
    ...overrides
  };
}

function memberRow(overrides: Record<string, unknown> = {}) {
  const member = memberRecord();
  return {
    actor_key: member.actorKey,
    avatar_url: member.avatarUrl ?? null,
    display_name: member.displayName,
    handle: member.handle,
    joined_at: member.joinedAt,
    member_id: member.memberId,
    origin: member.origin,
    profile_revision: member.profileRevision ?? null,
    role: member.role,
    space_id: member.spaceId,
    updated_at: member.updatedAt,
    ...overrides
  };
}

function humanProfileRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'user-olli',
    avatar_data_url_override: null,
    created_at: createdAt,
    default_avatar_url: 'https://img.clerk.test/olli.png',
    default_display_name: 'Olli Account',
    display_name_override: null,
    revision: 1,
    space_id: 'space-a',
    updated_at: createdAt,
    ...overrides
  };
}

function messageRecord(
  overrides: Partial<ProjectChatMessageRecord> = {}
): ProjectChatMessageRecord {
  return {
    body: 'Hello @olli',
    channelId: 'general',
    createdAt,
    expiresAt,
    id: 'message-a',
    mentions: [{ displayName: 'Olli', handle: 'olli', memberId: 'member-human' }],
    sender: {
      displayName: 'Galileo',
      handle: 'galileo',
      memberId: 'member-a',
      origin: {
        hostId: 'host-a',
        machineId: 'machine-a',
        threadId: 'thread-a'
      },
      role: 'agent'
    },
    senderMemberId: 'member-a',
    sequence: 8,
    spaceId: 'space-a',
    ...overrides
  };
}

function messageRow(overrides: Record<string, unknown> = {}) {
  const message = messageRecord();
  return {
    body: message.body,
    channel_id: message.channelId,
    created_at: message.createdAt,
    expires_at: message.expiresAt,
    id: message.id,
    mentions: message.mentions,
    sender: message.sender,
    sender_member_id: message.senderMemberId,
    sequence: message.sequence,
    space_id: message.spaceId,
    ...overrides
  };
}

function appendInput(body = 'Hello @olli') {
  const { sequence: _sequence, ...message } = messageRecord({ body });
  return { idempotencyKey: 'request-a', message };
}

function databaseConflict(constraint: string) {
  return Object.assign(new Error('unique violation'), { code: '23505', constraint });
}

function nameClaimRow(overrides:Record<string,unknown>={}) {
  return {
    account_id:'account-a',
    actor_key:'agent:machine-a:thread-a',
    category:'mythology',
    claimed_at:'2026-07-11T10:00:00.000Z',
    display_name:'Athena',
    name_key:'athena',
    parent_thread_id:null,
    space_id:'space-a',
    thread_id:'thread-a',
    updated_at:'2026-07-11T10:00:00.000Z',
    ...overrides
  };
}

describe('PostgresProjectChatRepository', () => {
  test('renews an idempotent name lease without changing its original claim time',async()=>{
    const renewedAt='2026-07-12T10:00:00.000Z';
    const client=new RecordingClient([
      rows([nameClaimRow()]),
      rows([nameClaimRow({updated_at:renewedAt})])
    ]);
    const repository=new PostgresProjectChatRepository(client);
    const claim:ProjectChatNameClaimRecord={
      accountId:'account-a',actorKey:'agent:machine-a:thread-a',category:'mythology',
      claimedAt:renewedAt,displayName:'Athena',nameKey:'athena',spaceId:'space-a',
      threadId:'thread-a',updatedAt:renewedAt
    };

    await expect(repository.claimName(claim)).resolves.toMatchObject({
      claimedAt:'2026-07-11T10:00:00.000Z',updatedAt:renewedAt
    });
    expect(client.calls[1]?.sql).toContain('updated_at = $9');
    expect(client.calls[1]?.values[8]).toBe(renewedAt);
    expect(client.events).toEqual(['begin','select','update','commit']);
  });

  test('persists provider defaults separately from human profile overrides', async () => {
    const baseRow = humanProfileRow();
    const client = new RecordingClient([
      rows([baseRow]),
      rows([baseRow]),
      rows([{
        ...baseRow,
        avatar_data_url_override: 'data:image/webp;base64,avatar',
        display_name_override: 'Olli Chat'
      }])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.ensureHumanProfile({
      accountId: 'user-olli',
      createdAt,
      defaultAvatarUrl: 'https://img.clerk.test/olli.png',
      defaultDisplayName: 'Olli Account',
      revision: 1,
      spaceId: 'space-a',
      updatedAt: createdAt
    }, { refreshDefaults: false })).resolves.toMatchObject({
      defaultDisplayName: 'Olli Account',
      displayNameOverride: undefined
    });
    await expect(repository.findHumanProfile('space-a', 'user-olli')).resolves.toMatchObject({
      accountId: 'user-olli',
      spaceId: 'space-a'
    });
    await expect(updatePostgresHumanProfile(client, {
      accountId: 'user-olli',
      avatarDataUrlOverride: 'data:image/webp;base64,avatar',
      displayNameOverride: 'Olli Chat',
      spaceId: 'space-a',
      updatedAt: createdAt
    })).resolves.toMatchObject({
      avatarDataUrlOverride: 'data:image/webp;base64,avatar',
      displayNameOverride: 'Olli Chat'
    });

    expect(client.calls[0]?.sql).toContain('on conflict (space_id, account_id)');
    expect(client.calls[0]?.values.at(-1)).toBe(false);
    expect(client.calls[1]?.values).toEqual(['space-a', 'user-olli']);
    expect(client.calls[2]?.values).toEqual([
      'space-a', 'user-olli', true, 'Olli Chat', true,
      'data:image/webp;base64,avatar', createdAt
    ]);
  });

  test('reads a human profile and member under one locked transaction snapshot', async () => {
    const client = new RecordingClient([
      rows([humanProfileRow({ default_display_name: 'Current Account', revision: 3 })]),
      rows([memberRow({
        actor_key: '["human","user-olli"]',
        display_name: 'Current Account',
        handle: 'current-handle',
        profile_revision: 3,
        role: 'human'
      })])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.findHumanProfileAndMember(
      'space-a',
      'user-olli',
      '["human","user-olli"]'
    )).resolves.toMatchObject({
      member: { handle: 'current-handle', profileRevision: 3 },
      profile: { defaultDisplayName: 'Current Account', revision: 3 }
    });
    expect(client.events).toEqual(['begin', 'select', 'select', 'commit']);
    expect(client.calls[0]?.sql).toContain('for share');
    expect(client.calls[1]?.sql).toContain('for share');
  });

  test('updates a human profile and visible member in one transaction', async () => {
    const profileRow = humanProfileRow({
      avatar_data_url_override: 'data:image/webp;base64,avatar',
      display_name_override: 'Olli Chat',
      revision: 2
    });
    const humanMember = memberRecord({
      actorKey: '["human","user-olli"]',
      avatarUrl: 'https://img.clerk.test/olli.png',
      displayName: 'Olli Account',
      handle: 'olli',
      origin: undefined,
      profileRevision: 1,
      role: 'human'
    });
    const updatedMemberRow = memberRow({
      actor_key: humanMember.actorKey,
      avatar_url: 'data:image/webp;base64,avatar',
      display_name: 'Olli Chat',
      handle: 'olli',
      origin: null,
      profile_revision: 2,
      role: 'human'
    });
    const input = {
      accountId: 'user-olli',
      avatarDataUrlOverride: 'data:image/webp;base64,avatar',
      displayNameOverride: 'Olli Chat',
      spaceId: 'space-a',
      updatedAt: createdAt
    };
    const client = new RecordingClient([rows([profileRow]), rows([updatedMemberRow])]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.updateHumanProfileAndMember(input, humanMember)).resolves.toEqual({
      member: expect.objectContaining({
        avatarUrl: 'data:image/webp;base64,avatar',
        displayName: 'Olli Chat',
        profileRevision: 2,
        role: 'human'
      }),
      profile: expect.objectContaining({
        avatarDataUrlOverride: 'data:image/webp;base64,avatar',
        displayNameOverride: 'Olli Chat',
        revision: 2
      })
    });
    expect(client.events).toEqual(['begin', 'update', 'update', 'commit']);
    expect(client.calls[1]?.values).toEqual([
      'space-a', humanMember.actorKey, 'Olli Chat',
      'data:image/webp;base64,avatar', 2, createdAt
    ]);

    const failure = new Error('forced member update failure');
    const failingClient = new RecordingClient([rows([profileRow]), failure]);
    const failingRepository = new PostgresProjectChatRepository(failingClient);
    await expect(
      failingRepository.updateHumanProfileAndMember(input, humanMember)
    ).rejects.toBe(failure);
    expect(failingClient.events).toEqual(['begin', 'update', 'update', 'rollback']);
  });

  test('maps channel, member, and presence rows while keeping JSON parameterized', async () => {
    const member = memberRecord();
    const presence: ProjectChatPresenceRecord = {
      expiresAt,
      lastSeenAt: createdAt,
      memberId: member.memberId,
      spaceId: member.spaceId,
      state: 'working'
    };
    const client = new RecordingClient([
      rows([{
        account_id: null,
        channel_id: 'general',
        created_at: createdAt,
        kind: 'general',
        last_sequence: 0,
        name: 'General',
        project_id: null,
        space_id: 'space-a'
      }]),
      rows([memberRow()]),
      rows([{
        expires_at: expiresAt,
        last_seen_at: createdAt,
        member_id: member.memberId,
        space_id: member.spaceId,
        state: 'working'
      }])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.ensureChannel({
      channelId: 'general',
      createdAt,
      kind: 'general',
      name: 'General',
      spaceId: 'space-a'
    })).resolves.toEqual({
      channelId: 'general',
      createdAt,
      kind: 'general',
      name: 'General',
      spaceId: 'space-a'
    });
    await expect(repository.upsertMember(member)).resolves.toEqual(member);
    await expect(repository.setPresence(presence)).resolves.toEqual(presence);

    expect(client.calls[1]?.sql).toContain('$8::jsonb');
    expect(client.calls[1]?.values[7]).toBe(JSON.stringify(member.origin));
    expect(client.calls.every((call) => !call.sql.includes(member.displayName))).toBe(true);
  });

  test('upserts project channels by stable project identity and reads them by opaque channel id', async () => {
    const row = {
      account_id: 'account-1',
      channel_id: 'channel-opaque',
      created_at: createdAt,
      kind: 'project',
      last_sequence: 0,
      name: 'Renamed project',
      project_id: 'github:123',
      space_id: 'space-a'
    };
    const client = new RecordingClient([rows([row]), rows([row])]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.ensureChannel({
      accountId: 'account-1',
      channelId: 'channel-racing-id',
      createdAt,
      kind: 'project',
      name: 'Renamed project',
      projectId: 'github:123',
      spaceId: 'space-a'
    })).resolves.toMatchObject({
      channelId: 'channel-opaque',
      name: 'Renamed project',
      projectId: 'github:123'
    });
    await expect(repository.findChannel('space-a', 'channel-opaque')).resolves.toMatchObject({
      accountId: 'account-1',
      channelId: 'channel-opaque',
      kind: 'project',
      name: 'Renamed project',
      projectId: 'github:123',
      spaceId: 'space-a'
    });
    expect(client.calls[0]?.sql).toContain("on conflict (space_id, account_id, project_id) where kind = 'project'");
    expect(client.calls[0]?.values).toContain('github:123');
    expect(client.calls[1]?.sql).toContain('where space_id = $1 and channel_id = $2');
  });

  test('returns the newer human member when a stale profile revision loses the upsert', async () => {
    const currentRow = memberRow({
      actor_key: '["human","user-olli"]',
      avatar_url: 'data:image/webp;base64,current',
      display_name: 'Current Human',
      handle: 'olli',
      origin: null,
      profile_revision: 2,
      role: 'human'
    });
    const client = new RecordingClient([
      rows([], 0),
      rows([currentRow])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.upsertMember(memberRecord({
      actorKey: '["human","user-olli"]',
      avatarUrl: undefined,
      displayName: 'Stale Human',
      handle: 'olli',
      origin: undefined,
      profileRevision: 1,
      role: 'human'
    }))).resolves.toMatchObject({
      avatarUrl: 'data:image/webp;base64,current',
      displayName: 'Current Human',
      profileRevision: 2,
      role: 'human'
    });

    expect(client.calls[0]?.sql).toContain(
      'excluded.profile_revision >= project_chat_members.profile_revision'
    );
    expect(client.calls[1]?.sql).toContain('where space_id = $1 and actor_key = $2');
  });

  test('maps only the named handle constraint to a domain conflict', async () => {
    const client = new RecordingClient([
      databaseConflict('project_chat_members_space_handle_unique')
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.upsertMember(memberRecord())).rejects.toBeInstanceOf(
      ProjectChatHandleConflictError
    );
  });

  test('appends atomically after idempotency lock and allocates one channel sequence', async () => {
    const client = new RecordingClient([
      rows([]),
      rows([]),
      rows([{ last_sequence: '8' }]),
      rows([]),
      rows([]),
      rows([])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.appendMessage(appendInput())).resolves.toEqual({
      inserted: true,
      message: messageRecord()
    });

    expect(client.events).toEqual([
      'begin', 'select', 'select', 'update', 'insert', 'insert', 'insert', 'commit'
    ]);
    expect(client.calls[0]?.sql).toContain('pg_advisory_xact_lock');
    expect(client.calls[1]?.values).toEqual(['space-a', 'general', 'member-a', 'request-a']);
    expect(client.calls[2]?.sql).toContain('last_sequence = last_sequence + 1');
    expect(client.calls[2]?.values).toEqual(['space-a', 'general']);
    expect(client.calls[3]?.values).toEqual([
      'space-a',
      'general',
      'message-a',
      8,
      'Hello @olli',
      JSON.stringify(messageRecord().sender),
      'member-a',
      JSON.stringify(messageRecord().mentions),
      createdAt,
      expiresAt
    ]);
    expect(client.calls[4]?.values).toEqual(['space-a', 'message-a', ['member-human']]);
  });

  test('replays identical idempotent appends and rejects changed content', async () => {
    const replayClient = new RecordingClient([
      rows([]),
      rows([{ ...messageRow(), idempotency_body: 'Hello @olli' }])
    ]);
    const replayRepository = new PostgresProjectChatRepository(replayClient);

    await expect(replayRepository.appendMessage(appendInput())).resolves.toEqual({
      inserted: false,
      message: messageRecord()
    });
    expect(replayClient.events).toEqual(['begin', 'select', 'select', 'commit']);

    const conflictClient = new RecordingClient([
      rows([]),
      rows([{ ...messageRow(), idempotency_body: 'original body' }])
    ]);
    const conflictRepository = new PostgresProjectChatRepository(conflictClient);
    await expect(conflictRepository.appendMessage(appendInput('changed body'))).rejects.toBeInstanceOf(
      ProjectChatIdempotencyConflictError
    );
    expect(conflictClient.events.at(-1)).toBe('rollback');
  });

  test('maps the named idempotency unique constraint after rolling back', async () => {
    const client = new RecordingClient([
      rows([]),
      rows([]),
      rows([{ last_sequence: 8 }]),
      rows([]),
      rows([]),
      databaseConflict('project_chat_idempotency_identity_unique')
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.appendMessage(appendInput())).rejects.toBeInstanceOf(
      ProjectChatIdempotencyConflictError
    );
    expect(client.events.at(-1)).toBe('rollback');
  });

  test('captures the channel head before reading and bounds the page to that snapshot', async () => {
    const client = new RecordingClient([
      rows([{ last_sequence: '12' }]),
      rows([
        messageRow({ id: 'message-9', sequence: 9 }),
        messageRow({ id: 'message-10', sequence: 10 }),
        messageRow({ id: 'message-11', sequence: 11 })
      ])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    const page = await repository.readMessages({
      afterSequence: 8,
      channelId: 'general',
      limit: 2,
      now: createdAt,
      spaceId: 'space-a'
    });

    expect(page.latestSequence).toBe(12);
    expect(page.hasMore).toBe(true);
    expect(page.messages.map((message) => message.sequence)).toEqual([9, 10]);
    expect(client.calls[0]?.sql).toContain('from project_chat_channels');
    expect(client.calls[1]?.sql).toContain('messages.sequence <= $4');
    expect(client.calls[1]?.values).toEqual(['space-a', 'general', 8, 12, createdAt, 3]);
    expect(client.events).toEqual(['begin', 'select', 'select', 'commit']);
  });

  test('scopes member and mention reads across every join by space', async () => {
    const client = new RecordingClient([
      rows([memberRow({ space_id: 'space-b' })]),
      rows([{ ...messageRow({ space_id: 'space-b' }), unread_count: '1' }])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await repository.findMemberByActorKey('space-b', 'actor-b');
    const mentions = await repository.listUnreadMentions({
      afterSequence: 0,
      channelId: 'general',
      limit: 20,
      memberId: 'member-b',
      now: createdAt,
      spaceId: 'space-b'
    });

    expect(client.calls[0]?.values).toEqual(['space-b', 'actor-b']);
    expect(client.calls[1]?.sql).toContain('messages.space_id = message_mentions.space_id');
    expect(client.calls[1]?.sql).toContain('message_mentions.space_id = $1');
    expect(client.calls[1]?.values).toEqual([
      'space-b', 'member-b', 'general', 0, createdAt, 20
    ]);
    expect(mentions.unreadCount).toBe(1);
  });

  test('acknowledges monotonically after a transactional range check', async () => {
    const client = new RecordingClient([
      rows([{ last_sequence: 12 }]),
      rows([{ sequence: 9 }])
    ]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.acknowledgeCursor({
      channelId: 'general',
      memberId: 'member-a',
      spaceId: 'space-a',
      throughSequence: 7,
      updatedAt: createdAt
    })).resolves.toBe(9);
    expect(client.calls[0]?.sql).toContain('for share');
    expect(client.calls[1]?.sql).toContain('greatest(project_chat_cursors.sequence');
    expect(client.events).toEqual(['begin', 'select', 'insert', 'commit']);

    const invalidClient = new RecordingClient([rows([{ last_sequence: 4 }])]);
    const invalidRepository = new PostgresProjectChatRepository(invalidClient);
    await expect(invalidRepository.acknowledgeCursor({
      channelId: 'general',
      memberId: 'member-a',
      spaceId: 'space-a',
      throughSequence: 5,
      updatedAt: createdAt
    })).rejects.toBeInstanceOf(ProjectChatCursorOutOfRangeError);
    expect(invalidClient.events).toEqual(['begin', 'select', 'rollback']);
  });

  test('purges expired messages without changing channel sequence state', async () => {
    const client = new RecordingClient([rows([{ id: 'one' }, { id: 'two' }], 2)]);
    const repository = new PostgresProjectChatRepository(client);

    await expect(repository.purgeExpired(createdAt)).resolves.toBe(2);
    expect(client.calls[0]?.sql).toContain('delete from project_chat_messages');
    expect(client.calls[0]?.sql).not.toContain('project_chat_channels');
    expect(client.calls[0]?.values).toEqual([createdAt]);
  });

  test('reaps expired name leases while retiring members and protecting fresh specialists',async()=>{
    const client=new RecordingClient([rows([{removed:'2'}])]);
    const repository=new PostgresProjectChatRepository(client);
    const boundary='2026-07-13T10:00:00.000Z';

    await expect(repository.reapExpiredNameClaims('space-a',boundary)).resolves.toBe(2);
    expect(client.calls[0]?.sql).toContain('claim.updated_at <= $2::timestamptz');
    expect(client.calls[0]?.sql).toContain('child.updated_at > $2::timestamptz');
    expect(client.calls[0]?.sql).toContain('name_lease_retired_at = $2::timestamptz');
    expect(client.calls[0]?.values).toEqual(['space-a',boundary]);
  });
});
