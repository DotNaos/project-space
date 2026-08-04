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

export async function findPostgresNameClaimForUpdate(
  client: DatabaseQueryClient,
  spaceId: string,
  accountId: string,
  threadId: string
) {
  const result=await client.query<NameClaimRow>(
    `${selectNameClaim}
      where space_id = $1 and account_id = $2 and thread_id = $3
      for update`,
    [spaceId,accountId,threadId]
  );
  return result.rows[0] ? mapNameClaim(result.rows[0]) : null;
}

export async function claimPostgresName(
  client: DatabaseQueryClient,
  claim: ProjectChatNameClaimRecord
) {
  try {
    return await runTransaction(client, (transaction) =>
      claimPostgresNameInTransaction(transaction,claim)
    );
  } catch (error) {
    if ((error as { code?: unknown })?.code === '23505') {
      throw new ProjectChatNameClaimConflictError('name_claimed');
    }
    throw error;
  }
}

export async function renewPostgresNameClaim(
  client:DatabaseQueryClient,
  claim:ProjectChatNameClaimRecord,
  updatedAt:string
) {
  const result=await client.query<NameClaimRow>(
    `update project_chat_name_claims
        set updated_at = $6
      where space_id = $1 and account_id = $2 and thread_id = $3
        and name_key = $4 and updated_at = $5::timestamptz
      returning space_id, account_id, thread_id, actor_key, name_key,
                display_name, category, parent_thread_id, claimed_at, updated_at`,
    [claim.spaceId,claim.accountId,claim.threadId,claim.nameKey,claim.updatedAt,updatedAt]
  );
  return result.rows[0] ? mapNameClaim(result.rows[0]) : null;
}

export async function claimPostgresNameInTransaction(
  client: DatabaseQueryClient,
  claim: ProjectChatNameClaimRecord
) {
  const existing=await findPostgresNameClaimForUpdate(client,claim.spaceId,claim.accountId,claim.threadId);
  if (existing?.nameKey === claim.nameKey) {
    const renewed=await updateNameClaim(client,{
      ...claim,
      claimedAt:existing.claimedAt
    });
    if (!renewed) throw new Error('Project Chat name lease could not be renewed.');
    return mapNameClaim(renewed);
  }
  const stored=existing
    ? await updateNameClaim(client,claim)
    : await insertNameClaim(client,claim);
  if (!stored) throw new Error('Project Chat name claim could not be stored.');
  return mapNameClaim(stored);
}

export async function reapExpiredPostgresNameClaims(
  client: DatabaseQueryClient,
  spaceId: string,
  expiresAtOrBefore: string
) {
  const result = await client.query<{ removed: number | string }>(
    `with expired as (
       delete from project_chat_name_claims claim
        where claim.space_id = $1
          and claim.updated_at <= $2::timestamptz
          and (
            claim.category <> 'mythology'
            or not exists (
              select 1
                from project_chat_name_claims child
               where child.space_id = claim.space_id
                 and child.account_id = claim.account_id
                 and child.parent_thread_id = claim.thread_id
                 and child.updated_at > $2::timestamptz
            )
          )
       returning space_id, actor_key
     ), retired_members as (
       update project_chat_members member
          set agent_name = null,
              name_lease_retired_at = $2::timestamptz,
              updated_at = greatest(member.updated_at, $2::timestamptz)
         from expired
        where member.space_id = expired.space_id
          and member.actor_key = expired.actor_key
       returning member.member_id
     )
     select count(*)::bigint as removed from expired`,
    [spaceId, expiresAtOrBefore]
  );
  return Number(result.rows[0]?.removed ?? 0);
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
