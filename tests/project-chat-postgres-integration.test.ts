import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import type { DatabaseQueryClient } from '../server/database/client';
import {
  databaseMigrations,
  runDatabaseMigrations,
  type DatabaseMigration
} from '../server/database/migrations';
import type { ProjectChatClock, ProjectChatContext } from '../server/project-chat/contracts';
import { PostgresProjectChatRepository } from '../server/project-chat/postgres-store';
import { ProjectChatService } from '../server/project-chat/service';
import { projectChatActorKey } from '../server/project-chat/validation';

const databaseUrl = process.env.PROJECT_CHAT_TEST_DATABASE_URL ?? '';
const postgresTest = databaseUrl ? test : test.skip;
const customAvatar = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89';

function databaseClient(pool: pg.Pool): DatabaseQueryClient {
  return {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await pool.query(sql, values ? [...values] : undefined);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    },
    async transaction<Result>(operation: (client: DatabaseQueryClient) => Promise<Result>) {
      const connection = await pool.connect();
      const client: DatabaseQueryClient = {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const result = await connection.query(sql, values ? [...values] : undefined);
          return { rowCount: result.rowCount, rows: result.rows as Row[] };
        }
      };
      try {
        await client.query('begin');
        const result = await operation(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        connection.release();
      }
    }
  };
}

async function migrateDatabase(
  pool: pg.Pool,
  migrations: readonly DatabaseMigration[] = databaseMigrations
) {
  const connection = await pool.connect();
  const client: DatabaseQueryClient = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await connection.query(sql, values ? [...values] : undefined);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    }
  };
  try {
    await runDatabaseMigrations(client, migrations);
  } finally {
    connection.release();
  }
}

const humanContext: ProjectChatContext = {
  actor: {
    accountId: 'user-olli',
    displayName: 'Olli',
    handle: 'olli',
    kind: 'human'
  },
  spaceId: 'postgres-integration-space'
};

function agentContext(name: string): ProjectChatContext {
  const threadId = name === 'mira'
    ? '019f4f2b-e97e-7180-9122-4187159dbe51'
    : '019f4b93-5703-7692-ad6e-101e32fc4be0';
  return {
    actor: {
      accountId: 'user-olli',
      hostId: `host-${name}`,
      kind: 'agent',
      machineId: `machine-${name}`,
      threadId
    },
    spaceId: humanContext.spaceId
  };
}

describe('Project Chat PostgreSQL integration', () => {
  postgresTest('backfills existing human members before enforcing profile revisions', async () => {
    const schema = `project_chat_migration_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`create schema "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema}`
    });
    try {
      await migrateDatabase(
        pool,
        databaseMigrations.filter((migration) => migration.id < '0009_project_chat_human_profiles')
      );
      await pool.query(
        `insert into project_chat_members (
           space_id, actor_key, member_id, display_name, handle, role, origin,
           joined_at, updated_at
         ) values
           ('legacy-space', $1, 'legacy-human', 'Legacy Human', 'legacy-human',
            'human', null, '2026-07-11T00:00:00Z', '2026-07-11T00:01:00Z'),
           ('legacy-space', $2, 'legacy-agent', 'Legacy Agent', 'legacy-agent',
            'agent', $3::jsonb, '2026-07-11T00:00:00Z', '2026-07-11T00:01:00Z')`,
        [
          JSON.stringify(['human', 'legacy-user']),
          JSON.stringify(['agent', 'legacy-user', 'legacy-machine', '019f503f-f91d-72e3-a8fb-86f167209b9f']),
          JSON.stringify({
            hostId: 'legacy-host',
            machineId: 'legacy-machine',
            threadId: '019f503f-f91d-72e3-a8fb-86f167209b9f'
          })
        ]
      );

      await migrateDatabase(pool);

      const members = await pool.query<{
        avatar_url: string | null;
        profile_revision: string | null;
        role: string;
      }>(
        `select role, avatar_url, profile_revision
           from project_chat_members
          order by role desc`
      );
      expect(members.rows).toEqual([
        { avatar_url: null, profile_revision: '1', role: 'human' },
        { avatar_url: null, profile_revision: null, role: 'agent' }
      ]);
      const profiles = await pool.query<{
        account_id: string;
        default_display_name: string;
        revision: string;
      }>(
        `select account_id, default_display_name, revision
           from project_chat_human_profiles`
      );
      expect(profiles.rows).toEqual([{
        account_id: 'legacy-user',
        default_display_name: 'Legacy Human',
        revision: '1'
      }]);
    } finally {
      await pool.end();
      await adminPool.query(`drop schema "${schema}" cascade`);
      await adminPool.end();
    }
  }, 30_000);

  postgresTest('keeps legacy General history attached to General through migration 0013', async () => {
    const schema = `project_chat_channel_migration_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`create schema "${schema}"`);
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schema}`
    });
    try {
      await migrateDatabase(
        pool,
        databaseMigrations.filter(
          (migration) => migration.id <= '0012_project_chat_name_registry'
        )
      );
      await pool.query(
        `insert into project_chat_human_profiles (
           space_id, account_id, default_display_name, revision, created_at, updated_at
         ) values ('legacy-space', 'legacy-user', 'Legacy User', 1,
                   '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z');
         insert into project_chat_members (
           space_id, actor_key, member_id, display_name, handle, role, origin,
           profile_revision, joined_at, updated_at
         ) values ('legacy-space', '["human","legacy-user"]', 'legacy-member',
                   'Legacy User', 'legacy-user', 'human', null, 1,
                   '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z');
         insert into project_chat_channels (
           space_id, channel_id, name, last_sequence, created_at
         ) values ('legacy-space', 'general', 'General', 1, '2026-07-11T00:00:00Z');
         insert into project_chat_messages (
           space_id, channel_id, id, sequence, body, sender, sender_member_id,
           mentions, created_at, expires_at
         ) values ('legacy-space', 'general', 'legacy-message', 1, 'Legacy General message',
                   '{"memberId":"legacy-member","displayName":"Legacy User","handle":"legacy-user","role":"human"}'::jsonb,
                   'legacy-member', '[]'::jsonb,
                   '2026-07-11T00:00:00Z', '2027-07-11T00:00:00Z')`
      );

      await migrateDatabase(pool);

      const channel = await pool.query(
        `select channel_id, kind, account_id, project_id
           from project_chat_channels
          where space_id = 'legacy-space'`
      );
      expect(channel.rows).toEqual([{
        account_id: null,
        channel_id: 'general',
        kind: 'general',
        project_id: null
      }]);
      const messages = await pool.query(
        `select channel_id, body from project_chat_messages where space_id = 'legacy-space'`
      );
      expect(messages.rows).toEqual([{
        body: 'Legacy General message',
        channel_id: 'general'
      }]);
    } finally {
      await pool.end();
      await adminPool.query(`drop schema "${schema}" cascade`);
      await adminPool.end();
    }
  }, 30_000);

  postgresTest('survives reconnects with monotonic concurrent appends, cursors, and mentions', async () => {
    const schema = `project_chat_test_${randomUUID().replaceAll('-', '')}`;
    const adminPool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`create schema "${schema}"`);
    const poolOptions = {
      connectionString: databaseUrl,
      max: 12,
      options: `-c search_path=${schema}`
    };
    const firstPool = new pg.Pool(poolOptions);
    let firstPoolClosed = false;
    let secondPool: pg.Pool | undefined;
    try {
      const firstClient = databaseClient(firstPool);
      await migrateDatabase(firstPool);
      await migrateDatabase(firstPool);

      const firstRepository = new PostgresProjectChatRepository(firstClient);
      const firstService = new ProjectChatService({ repository: firstRepository });
      const mira = agentContext('mira');
      const atlas = agentContext('atlas');

      const orderingContext: ProjectChatContext = {
        actor: {
          accountId: 'user-ordering',
          displayName: 'Initial Account',
          handle: 'ordering',
          kind: 'human'
        },
        spaceId: 'profile-default-ordering-space'
      };
      const orderingService = new ProjectChatService({
        clock: { now: () => new Date('2026-07-11T09:00:00.000Z') },
        repository: firstRepository
      });
      await orderingService.join(orderingContext);
      const orderingMember = await firstRepository.findMemberByActorKey(
        orderingContext.spaceId,
        projectChatActorKey(orderingContext.actor)
      );
      if (!orderingMember) {
        throw new Error('PostgreSQL integration did not create the ordering member.');
      }
      const newerDefaults = await firstRepository.ensureHumanProfileAndMember({
        accountId: 'user-ordering',
        createdAt: '2026-07-11T09:00:00.000Z',
        defaultAvatarUrl: 'https://img.clerk.test/newer.png',
        defaultDisplayName: 'Newer Account',
        revision: 1,
        spaceId: orderingContext.spaceId,
        updatedAt: '2026-07-11T09:02:00.000Z'
      }, {
        ...orderingMember,
        handle: 'newer-handle'
      }, { refreshDefaults: true });
      const delayedSave = await firstRepository.updateHumanProfileAndMember({
        accountId: 'user-ordering',
        displayNameOverride: 'Delayed Custom',
        spaceId: orderingContext.spaceId,
        updatedAt: '2026-07-11T09:01:00.000Z'
      }, {
        ...newerDefaults.member,
        handle: 'older-save-handle',
        updatedAt: '2026-07-11T09:01:00.000Z'
      });
      expect(delayedSave.profile).toMatchObject({
        defaultDisplayName: 'Newer Account',
        displayNameOverride: 'Delayed Custom',
        updatedAt: '2026-07-11T09:02:00.000Z'
      });
      expect(delayedSave.member).toMatchObject({
        displayName: 'Delayed Custom',
        handle: 'newer-handle',
        updatedAt: '2026-07-11T09:02:00.000Z'
      });
      const delayedOlderDefaults = await firstRepository.ensureHumanProfileAndMember({
        accountId: 'user-ordering',
        createdAt: '2026-07-11T09:00:00.000Z',
        defaultAvatarUrl: 'https://img.clerk.test/older.png',
        defaultDisplayName: 'Older Account',
        revision: 1,
        spaceId: orderingContext.spaceId,
        updatedAt: '2026-07-11T09:01:30.000Z'
      }, {
        ...delayedSave.member,
        handle: 'older-handle'
      }, { refreshDefaults: true });
      expect(delayedOlderDefaults.profile).toEqual(delayedSave.profile);
      expect(delayedOlderDefaults.member).toMatchObject({
        avatarUrl: 'https://img.clerk.test/newer.png',
        displayName: 'Delayed Custom',
        handle: 'newer-handle',
        profileRevision: delayedSave.profile.revision,
        updatedAt: '2026-07-11T09:02:00.000Z'
      });

      await firstService.join(humanContext);
      const staleHumanMember = await firstRepository.findMemberByActorKey(
        humanContext.spaceId,
        projectChatActorKey(humanContext.actor)
      );
      if (!staleHumanMember) {
        throw new Error('PostgreSQL integration did not create the human member.');
      }
      const profileBeforeFailure = await firstRepository.findHumanProfile(
        humanContext.spaceId,
        humanContext.actor.accountId
      );
      await firstPool.query(`
        create function reject_project_chat_human_member_update()
        returns trigger language plpgsql as $$
        begin
          raise exception 'forced Project Chat member update failure';
        end
        $$;
        create trigger reject_project_chat_human_member_update
          before update on project_chat_members
          for each row when (new.role = 'human')
          execute function reject_project_chat_human_member_update();
      `);
      try {
        await expect(firstService.updateProfile(humanContext, {
          displayName: 'Must Roll Back'
        })).rejects.toThrow();
      } finally {
        await firstPool.query(`
          drop trigger reject_project_chat_human_member_update on project_chat_members;
          drop function reject_project_chat_human_member_update();
        `);
      }
      await expect(firstRepository.findHumanProfile(
        humanContext.spaceId,
        humanContext.actor.accountId
      )).resolves.toEqual(profileBeforeFailure);
      await expect(firstRepository.findMemberByActorKey(
        humanContext.spaceId,
        projectChatActorKey(humanContext.actor)
      )).resolves.toEqual(staleHumanMember);

      await firstService.updateProfile(humanContext, {
        avatarDataUrl: customAvatar,
        displayName: 'Olli Chat'
      });
      await firstRepository.upsertMember({
        ...staleHumanMember,
        avatarUrl: undefined,
        displayName: 'Stale Account Name',
        updatedAt: new Date(Date.parse(staleHumanMember.updatedAt) + 10_000).toISOString()
      });
      await expect(firstRepository.findMemberByActorKey(
        humanContext.spaceId,
        projectChatActorKey(humanContext.actor)
      )).resolves.toMatchObject({
        avatarUrl: customAvatar,
        displayName: 'Olli Chat'
      });
      await firstService.join(mira, { displayName: 'Mira', taskTitle: 'Project Chat' });
      await firstService.join(atlas, { displayName: 'Atlas', taskTitle: 'Review' });

      const concurrent = await Promise.all(
        Array.from({ length: 50 }, (_, index) => {
          const context = index % 2 === 0 ? mira : atlas;
          return firstService.sendMessage(context, {
            body: `Concurrent message ${index + 1}`,
            channelId: 'general',
            idempotencyKey: `concurrent-${index + 1}`
          });
        })
      );
      expect(concurrent.map((message) => message.sequence).sort((left, right) => left - right))
        .toEqual(Array.from({ length: 50 }, (_, index) => index + 1));

      const idempotent = await Promise.all(
        Array.from({ length: 8 }, () => firstService.sendMessage(mira, {
          body: 'One retried message',
          channelId: 'general',
          idempotencyKey: 'same-retry-key'
        }))
      );
      expect(new Set(idempotent.map((message) => message.id)).size).toBe(1);
      expect(new Set(idempotent.map((message) => message.sequence))).toEqual(new Set([51]));

      const mention = await firstService.sendMessage(atlas, {
        body: 'The database restart is ready for @olli.',
        channelId: 'general',
        idempotencyKey: 'mention-olli'
      });
      expect(mention.sequence).toBe(52);
      expect(mention.mentions.map((entry) => entry.handle)).toEqual(['olli']);
      await firstService.acknowledge(humanContext, {
        channelId: 'general',
        throughSequence: 25
      });
      await firstPool.end();
      firstPoolClosed = true;

      secondPool = new pg.Pool({ ...poolOptions, max: 4 });
      const secondClient = databaseClient(secondPool);
      await migrateDatabase(secondPool);
      const secondRepository = new PostgresProjectChatRepository(secondClient);
      const secondService = new ProjectChatService({ repository: secondRepository });
      await expect(secondService.getProfile(humanContext)).resolves.toMatchObject({
        avatarSource: 'custom',
        avatarUrl: customAvatar,
        displayName: 'Olli Chat'
      });
      const afterRestart = await secondService.readMessages(humanContext);
      expect(afterRestart.messages[0]?.sequence).toBe(26);
      expect(afterRestart.messages.at(-1)?.sequence).toBe(52);
      expect(afterRestart.latestSequence).toBe(52);

      const mentionState = await secondService.getMentionState(humanContext);
      expect(mentionState.unreadCount).toBe(1);
      expect(mentionState.messages[0]?.id).toBe(mention.id);
      await secondService.acknowledge(humanContext, {
        channelId: 'general',
        throughSequence: 52
      });
      expect((await secondService.getMentionState(humanContext)).unreadCount).toBe(0);

      let now = new Date();
      const clock: ProjectChatClock = { now: () => now };
      const expiringService = new ProjectChatService({
        clock,
        repository: secondRepository,
        retentionMs: 1_000
      });
      const expiring = await expiringService.sendMessage(mira, {
        body: 'Short-lived integration message',
        channelId: 'general',
        idempotencyKey: 'short-lived'
      });
      expect(expiring.sequence).toBe(53);
      now = new Date(now.getTime() + 1_001);
      expect(await expiringService.purgeExpired()).toBe(1);
      const afterExpiry = await expiringService.readMessages(humanContext, {
        afterSequence: 52,
        channelId: 'general'
      });
      expect(afterExpiry.messages).toEqual([]);
      expect(afterExpiry.latestSequence).toBe(53);
    } finally {
      if (!firstPoolClosed) {
        await firstPool.end().catch(() => undefined);
      }
      await secondPool?.end().catch(() => undefined);
      await adminPool.query(`drop schema "${schema}" cascade`);
      await adminPool.end();
    }
  }, 30_000);
});
