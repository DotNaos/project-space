import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

import type { DatabaseQueryClient } from '../server/database/client';
import { runDatabaseMigrations } from '../server/database/migrations';
import type { ProjectChatClock, ProjectChatContext } from '../server/project-chat/contracts';
import { PostgresProjectChatRepository } from '../server/project-chat/postgres-store';
import { ProjectChatService } from '../server/project-chat/service';

const databaseUrl = process.env.PROJECT_CHAT_TEST_DATABASE_URL ?? '';
const postgresTest = databaseUrl ? test : test.skip;

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

async function migrateDatabase(pool: pg.Pool) {
  const connection = await pool.connect();
  const client: DatabaseQueryClient = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      const result = await connection.query(sql, values ? [...values] : undefined);
      return { rowCount: result.rowCount, rows: result.rows as Row[] };
    }
  };
  try {
    await runDatabaseMigrations(client);
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

      const firstService = new ProjectChatService({
        repository: new PostgresProjectChatRepository(firstClient)
      });
      const mira = agentContext('mira');
      const atlas = agentContext('atlas');
      await firstService.join(humanContext);
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
