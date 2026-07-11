import type { DatabaseQueryClient } from '../database/client';
import type {
  ProjectChatChannelRecord, ProjectChatMemberRecord, ProjectChatMessageRecord,
  ProjectChatOrigin, ProjectChatPresenceRecord, ProjectChatSender, ProjectChatMention
} from './contracts';
import {
  ProjectChatCursorOutOfRangeError,
  ProjectChatHandleConflictError,
  ProjectChatIdempotencyConflictError,
  type ProjectChatAppendInput,
  type ProjectChatRepository
} from './repository';

interface ChannelRow {
  channel_id: string; created_at: Date | string; last_sequence: number | string;
  name: string; space_id: string;
}

interface MemberRow {
  actor_key: string; display_name: string; handle: string;
  joined_at: Date | string; member_id: string;
  origin: ProjectChatOrigin | string | null;
  role: ProjectChatMemberRecord['role']; space_id: string; updated_at: Date | string;
}

interface PresenceRow {
  expires_at: Date | string; last_seen_at: Date | string;
  member_id: string; space_id: string; state: ProjectChatPresenceRecord['state'];
}

interface MessageRow {
  body: string; channel_id: string; created_at: Date | string; expires_at: Date | string;
  id: string; mentions: ProjectChatMention[] | string; sender: ProjectChatSender | string;
  sender_member_id: string; sequence: number | string; space_id: string;
}

interface IdempotencyMessageRow extends MessageRow {
  idempotency_body: string;
}

interface MentionMessageRow extends MessageRow {
  unread_count: number | string;
}

interface DatabaseError {
  code?: unknown;
  constraint?: unknown;
}

const handleConstraintName = 'project_chat_members_space_handle_unique';
const idempotencyConstraintName = 'project_chat_idempotency_identity_unique';

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonValue<Value>(value: Value | string): Value {
  return typeof value === 'string' ? JSON.parse(value) as Value : value;
}

function mapChannel(row: ChannelRow): ProjectChatChannelRecord {
  return {
    channelId: row.channel_id,
    createdAt: toIsoString(row.created_at),
    name: row.name,
    spaceId: row.space_id
  };
}

function mapMember(row: MemberRow): ProjectChatMemberRecord {
  return {
    actorKey: row.actor_key,
    displayName: row.display_name,
    handle: row.handle,
    joinedAt: toIsoString(row.joined_at),
    memberId: row.member_id,
    origin: row.origin === null ? undefined : jsonValue(row.origin),
    role: row.role,
    spaceId: row.space_id,
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapPresence(row: PresenceRow): ProjectChatPresenceRecord {
  return {
    expiresAt: toIsoString(row.expires_at),
    lastSeenAt: toIsoString(row.last_seen_at),
    memberId: row.member_id,
    spaceId: row.space_id,
    state: row.state
  };
}

function mapMessage(row: MessageRow): ProjectChatMessageRecord {
  return {
    body: row.body,
    channelId: row.channel_id,
    createdAt: toIsoString(row.created_at),
    expiresAt: toIsoString(row.expires_at),
    id: row.id,
    mentions: jsonValue(row.mentions),
    sender: jsonValue(row.sender),
    senderMemberId: row.sender_member_id,
    sequence: Number(row.sequence),
    spaceId: row.space_id
  };
}

function isConstraint(error: unknown, constraint: string) {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const databaseError = error as DatabaseError;
  return databaseError.code === '23505' && databaseError.constraint === constraint;
}

async function runTransaction<Result>(
  client: DatabaseQueryClient,
  operation: (transaction: DatabaseQueryClient) => Promise<Result>
) {
  if (client.transaction) {
    return client.transaction(operation);
  }
  await client.query('begin');
  try {
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export class PostgresProjectChatRepository implements ProjectChatRepository {
  constructor(private readonly client: DatabaseQueryClient) {}

  async ensureChannel(channel: ProjectChatChannelRecord) {
    const result = await this.client.query<ChannelRow>(
      `insert into project_chat_channels (
         space_id, channel_id, name, last_sequence, created_at
       ) values ($1, $2, $3, 0, $4)
       on conflict (space_id, channel_id) do update
         set name = project_chat_channels.name
       returning space_id, channel_id, name, last_sequence, created_at`,
      [channel.spaceId, channel.channelId, channel.name, channel.createdAt]
    );
    return mapChannel(requireRow(result.rows[0], 'Project Chat channel'));
  }

  async findMemberByActorKey(spaceId: string, actorKey: string) {
    const result = await this.client.query<MemberRow>(
      `${memberSelect} where space_id = $1 and actor_key = $2`,
      [spaceId, actorKey]
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  }

  async findMemberById(spaceId: string, memberId: string) {
    const result = await this.client.query<MemberRow>(
      `${memberSelect} where space_id = $1 and member_id = $2`,
      [spaceId, memberId]
    );
    return result.rows[0] ? mapMember(result.rows[0]) : null;
  }

  async upsertMember(member: ProjectChatMemberRecord) {
    try {
      const result = await this.client.query<MemberRow>(
        `insert into project_chat_members (
           space_id, actor_key, member_id, display_name, handle, role, origin,
           joined_at, updated_at
         ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         on conflict (space_id, actor_key) do update set
           display_name = excluded.display_name,
           handle = excluded.handle,
           role = excluded.role,
           origin = excluded.origin,
           updated_at = excluded.updated_at
         returning space_id, actor_key, member_id, display_name, handle, role,
                   origin, joined_at, updated_at`,
        [
          member.spaceId,
          member.actorKey,
          member.memberId,
          member.displayName,
          member.handle,
          member.role,
          member.origin ? JSON.stringify(member.origin) : null,
          member.joinedAt,
          member.updatedAt
        ]
      );
      return mapMember(requireRow(result.rows[0], 'Project Chat member'));
    } catch (error) {
      if (isConstraint(error, handleConstraintName)) {
        throw new ProjectChatHandleConflictError();
      }
      throw error;
    }
  }

  async listMembers(spaceId: string) {
    const result = await this.client.query<MemberRow>(
      `${memberSelect} where space_id = $1 order by joined_at, member_id`,
      [spaceId]
    );
    return result.rows.map(mapMember);
  }

  async setPresence(presence: ProjectChatPresenceRecord) {
    const result = await this.client.query<PresenceRow>(
      `insert into project_chat_presences (
         space_id, member_id, state, last_seen_at, expires_at
       ) values ($1, $2, $3, $4, $5)
       on conflict (space_id, member_id) do update set
         state = excluded.state,
         last_seen_at = excluded.last_seen_at,
         expires_at = excluded.expires_at
       returning space_id, member_id, state, last_seen_at, expires_at`,
      [presence.spaceId, presence.memberId, presence.state, presence.lastSeenAt, presence.expiresAt]
    );
    return mapPresence(requireRow(result.rows[0], 'Project Chat presence'));
  }

  async getPresence(spaceId: string, memberId: string) {
    const result = await this.client.query<PresenceRow>(
      `${presenceSelect} where space_id = $1 and member_id = $2`,
      [spaceId, memberId]
    );
    return result.rows[0] ? mapPresence(result.rows[0]) : null;
  }

  async listPresences(spaceId: string) {
    const result = await this.client.query<PresenceRow>(
      `${presenceSelect} where space_id = $1 order by member_id`,
      [spaceId]
    );
    return result.rows.map(mapPresence);
  }

  async appendMessage(input: ProjectChatAppendInput) {
    try {
      return await runTransaction(this.client, async (transaction) => {
        const { message } = input;
        const lockKey = JSON.stringify([
          message.spaceId,
          message.channelId,
          message.senderMemberId,
          input.idempotencyKey
        ]);
        await transaction.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);

        const previous = await transaction.query<IdempotencyMessageRow>(
          `${messageSelect}, idempotency.body as idempotency_body
             from project_chat_idempotency idempotency
             join project_chat_messages messages
               on messages.space_id = idempotency.space_id
              and messages.channel_id = idempotency.channel_id
              and messages.id = idempotency.message_id
            where idempotency.space_id = $1
              and idempotency.channel_id = $2
              and idempotency.sender_member_id = $3
              and idempotency.idempotency_key = $4`,
          [message.spaceId, message.channelId, message.senderMemberId, input.idempotencyKey]
        );
        const existing = previous.rows[0];
        if (existing) {
          if (existing.idempotency_body !== message.body) {
            throw new ProjectChatIdempotencyConflictError();
          }
          return { inserted: false, message: mapMessage(existing) };
        }

        const channel = await transaction.query<{ last_sequence: number | string }>(
          `update project_chat_channels
              set last_sequence = last_sequence + 1
            where space_id = $1 and channel_id = $2
            returning last_sequence`,
          [message.spaceId, message.channelId]
        );
        const sequence = Number(requireRow(channel.rows[0], 'Project Chat channel').last_sequence);
        const record = { ...message, sequence };

        await transaction.query(
          `insert into project_chat_messages (
             space_id, channel_id, id, sequence, body, sender, sender_member_id,
             mentions, created_at, expires_at
           ) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10)`,
          [
            record.spaceId,
            record.channelId,
            record.id,
            record.sequence,
            record.body,
            JSON.stringify(record.sender),
            record.senderMemberId,
            JSON.stringify(record.mentions),
            record.createdAt,
            record.expiresAt
          ]
        );
        await transaction.query(
          `insert into project_chat_message_mentions (space_id, message_id, member_id)
           select $1, $2, mention_id
             from unnest($3::text[]) as mention_id
           on conflict do nothing`,
          [record.spaceId, record.id, record.mentions.map((mention) => mention.memberId)]
        );
        await transaction.query(
          `insert into project_chat_idempotency (
             space_id, channel_id, sender_member_id, idempotency_key,
             message_id, body, expires_at
           ) values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            record.spaceId,
            record.channelId,
            record.senderMemberId,
            input.idempotencyKey,
            record.id,
            record.body,
            record.expiresAt
          ]
        );
        return { inserted: true, message: record };
      });
    } catch (error) {
      if (isConstraint(error, idempotencyConstraintName)) {
        throw new ProjectChatIdempotencyConflictError();
      }
      throw error;
    }
  }

  async readMessages(input: {
    spaceId: string;
    channelId: string;
    afterSequence: number;
    limit: number;
    now: string;
  }) {
    return runTransaction(this.client, async (transaction) => {
      const latestSequence = await readChannelHead(transaction, input.spaceId, input.channelId);
      if (input.afterSequence > latestSequence) {
        throw new ProjectChatCursorOutOfRangeError();
      }
      const result = await transaction.query<MessageRow>(
        `${messageSelect}
           from project_chat_messages messages
          where messages.space_id = $1
            and messages.channel_id = $2
            and messages.sequence > $3
            and messages.sequence <= $4
            and messages.expires_at > $5
          order by messages.sequence
          limit $6`,
        [
          input.spaceId,
          input.channelId,
          input.afterSequence,
          latestSequence,
          input.now,
          input.limit + 1
        ]
      );
      return {
        hasMore: result.rows.length > input.limit,
        latestSequence,
        messages: result.rows.slice(0, input.limit).map(mapMessage)
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
    const result = await this.client.query<MentionMessageRow>(
      `${messageSelect}, count(*) over () as unread_count
         from project_chat_message_mentions message_mentions
         join project_chat_messages messages
           on messages.space_id = message_mentions.space_id
          and messages.id = message_mentions.message_id
        where message_mentions.space_id = $1
          and message_mentions.member_id = $2
          and messages.channel_id = $3
          and messages.sequence > $4
          and messages.expires_at > $5
        order by messages.sequence
        limit $6`,
      [input.spaceId, input.memberId, input.channelId, input.afterSequence, input.now, input.limit]
    );
    return {
      messages: result.rows.map(mapMessage),
      unreadCount: Number(result.rows[0]?.unread_count ?? 0)
    };
  }

  async getChannelSequence(spaceId: string, channelId: string) {
    return readChannelHead(this.client, spaceId, channelId);
  }

  async getCursor(spaceId: string, memberId: string, channelId: string) {
    const result = await this.client.query<{ sequence: number | string }>(
      `select sequence from project_chat_cursors
        where space_id = $1 and member_id = $2 and channel_id = $3`,
      [spaceId, memberId, channelId]
    );
    return Number(result.rows[0]?.sequence ?? 0);
  }

  async acknowledgeCursor(input: {
    spaceId: string;
    memberId: string;
    channelId: string;
    throughSequence: number;
    updatedAt: string;
  }) {
    return runTransaction(this.client, async (transaction) => {
      const latestSequence = await readChannelHead(
        transaction,
        input.spaceId,
        input.channelId,
        ' for share'
      );
      if (input.throughSequence > latestSequence) {
        throw new ProjectChatCursorOutOfRangeError();
      }
      const result = await transaction.query<{ sequence: number | string }>(
        `insert into project_chat_cursors (
           space_id, member_id, channel_id, sequence, updated_at
         ) values ($1, $2, $3, $4, $5)
         on conflict (space_id, member_id, channel_id) do update set
           sequence = greatest(project_chat_cursors.sequence, excluded.sequence),
           updated_at = case
             when excluded.sequence >= project_chat_cursors.sequence then excluded.updated_at
             else project_chat_cursors.updated_at
           end
         returning sequence`,
        [
          input.spaceId,
          input.memberId,
          input.channelId,
          input.throughSequence,
          input.updatedAt
        ]
      );
      return Number(requireRow(result.rows[0], 'Project Chat cursor').sequence);
    });
  }

  async purgeExpired(now: string) {
    const result = await this.client.query<{ id: string }>(
      `delete from project_chat_messages
        where expires_at <= $1
        returning id`,
      [now]
    );
    return result.rowCount ?? result.rows.length;
  }
}

const memberSelect = `select space_id, actor_key, member_id, display_name, handle,
                             role, origin, joined_at, updated_at
                        from project_chat_members`;
const presenceSelect = `select space_id, member_id, state, last_seen_at, expires_at
                          from project_chat_presences`;
const messageSelect = `select messages.space_id, messages.channel_id, messages.id,
                              messages.sequence, messages.body, messages.sender,
                              messages.sender_member_id, messages.mentions,
                              messages.created_at, messages.expires_at`;

async function readChannelHead(
  client: DatabaseQueryClient,
  spaceId: string,
  channelId: string,
  lockClause = ''
) {
  const result = await client.query<{ last_sequence: number | string }>(
    `select last_sequence from project_chat_channels
      where space_id = $1 and channel_id = $2${lockClause}`,
    [spaceId, channelId]
  );
  return Number(result.rows[0]?.last_sequence ?? 0);
}

function requireRow<Row>(row: Row | undefined, label: string): Row {
  if (!row) {
    throw new Error(`${label} could not be stored.`);
  }
  return row;
}
