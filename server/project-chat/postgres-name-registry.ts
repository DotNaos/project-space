import type { DatabaseQueryClient } from '../database/client';
import type { ProjectChatNameClaimRecord } from './contracts';
import { ProjectChatNameClaimConflictError } from './repository';

interface NameClaimRow {
  account_id: string;
  actor_key: string;
  category: ProjectChatNameClaimRecord['category'];
  claimed_at: Date | string;
  display_name: string;
  name_key: string;
  parent_thread_id: string | null;
  space_id: string;
  thread_id: string;
  updated_at: Date | string;
}

const selectNameClaim = `
  select space_id, account_id, thread_id, actor_key, name_key, display_name,
         category, parent_thread_id, claimed_at, updated_at
    from project_chat_name_claims
`;

function mapNameClaim(row: NameClaimRow): ProjectChatNameClaimRecord {
  return {
    accountId: row.account_id,
    actorKey: row.actor_key,
    category: row.category,
    claimedAt: new Date(row.claimed_at).toISOString(),
    displayName: row.display_name,
    nameKey: row.name_key,
    ...(row.parent_thread_id ? { parentThreadId: row.parent_thread_id } : {}),
    spaceId: row.space_id,
    threadId: row.thread_id,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function listPostgresNameClaims(
  client: DatabaseQueryClient,
  spaceId: string
) {
  const result = await client.query<NameClaimRow>(
    `${selectNameClaim} where space_id = $1 order by claimed_at, name_key`,
    [spaceId]
  );
  return result.rows.map(mapNameClaim);
}

export async function findPostgresNameClaim(
  client: DatabaseQueryClient,
  spaceId: string,
  accountId: string,
  threadId: string
) {
  const result = await client.query<NameClaimRow>(
    `${selectNameClaim}
      where space_id = $1 and account_id = $2 and thread_id = $3`,
    [spaceId, accountId, threadId]
  );
  return result.rows[0] ? mapNameClaim(result.rows[0]) : null;
}

export async function claimPostgresName(
  client: DatabaseQueryClient,
  claim: ProjectChatNameClaimRecord
) {
  try {
    return await runTransaction(client, async (transaction) => {
      const existingResult = await transaction.query<NameClaimRow>(
        `${selectNameClaim}
          where space_id = $1 and account_id = $2 and thread_id = $3
          for update`,
        [claim.spaceId, claim.accountId, claim.threadId]
      );
      const existing = existingResult.rows[0];
      if (existing?.name_key === claim.nameKey) {
        return mapNameClaim(existing);
      }

      const stored = existing
        ? await updateNameClaim(transaction, claim)
        : await insertNameClaim(transaction, claim);
      if (!stored) {
        throw new Error('Project Chat name claim could not be stored.');
      }
      return mapNameClaim(stored);
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === '23505') {
      throw new ProjectChatNameClaimConflictError('name_claimed');
    }
    throw error;
  }
}

export async function restorePostgresNameClaim(
  client: DatabaseQueryClient,
  current: ProjectChatNameClaimRecord,
  previous: ProjectChatNameClaimRecord | null
) {
  await runTransaction(client, async (transaction) => {
    const deleted = await transaction.query(
      `delete from project_chat_name_claims
        where space_id = $1 and account_id = $2 and thread_id = $3
          and name_key = $4 and updated_at = $5`,
      [current.spaceId, current.accountId, current.threadId, current.nameKey, current.updatedAt]
    );
    if ((deleted.rowCount ?? 0) === 0 || !previous) return;
    await insertNameClaim(transaction, previous);
  });
}

async function updateNameClaim(
  client: DatabaseQueryClient,
  claim: ProjectChatNameClaimRecord
) {
  const result = await client.query<NameClaimRow>(
    `update project_chat_name_claims
        set name_key = $4, display_name = $5, category = $6,
            parent_thread_id = $7, actor_key = $8, updated_at = $9
      where space_id = $1 and account_id = $2 and thread_id = $3
      returning space_id, account_id, thread_id, actor_key, name_key,
                display_name, category, parent_thread_id, claimed_at, updated_at`,
    [
      claim.spaceId, claim.accountId, claim.threadId, claim.nameKey,
      claim.displayName, claim.category, claim.parentThreadId ?? null,
      claim.actorKey, claim.updatedAt
    ]
  );
  return result.rows[0];
}

async function insertNameClaim(
  client: DatabaseQueryClient,
  claim: ProjectChatNameClaimRecord
) {
  const result = await client.query<NameClaimRow>(
    `insert into project_chat_name_claims (
       space_id, account_id, thread_id, actor_key, name_key, display_name,
       category, parent_thread_id, claimed_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     returning space_id, account_id, thread_id, actor_key, name_key,
               display_name, category, parent_thread_id, claimed_at, updated_at`,
    [
      claim.spaceId, claim.accountId, claim.threadId, claim.actorKey,
      claim.nameKey, claim.displayName, claim.category,
      claim.parentThreadId ?? null, claim.claimedAt, claim.updatedAt
    ]
  );
  return result.rows[0];
}

async function runTransaction<Result>(
  client: DatabaseQueryClient,
  operation: (client: DatabaseQueryClient) => Promise<Result>
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
