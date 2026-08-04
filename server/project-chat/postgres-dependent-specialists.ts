import type { DatabaseQueryClient } from '../database/client';
import type {
  ProjectChatMemberRecord,
  ProjectChatNameClaimRecord,
  ProjectChatOrigin
} from './contracts';
import { refreshedDependentSpecialistMember } from './dependent-specialist-members';

interface DependentSpecialistRow {
  actor_key: string;
  agent_name: ProjectChatMemberRecord['agentName'] | string | null;
  avatar_url: string | null;
  child_account_id: string;
  child_actor_key: string;
  child_category: ProjectChatNameClaimRecord['category'];
  child_claimed_at: Date | string;
  child_display_name: string;
  child_name_key: string;
  child_parent_thread_id: string;
  child_thread_id: string;
  child_updated_at: Date | string;
  display_name: string;
  handle: string;
  joined_at: Date | string;
  member_id: string;
  origin: ProjectChatOrigin | string | null;
  role: ProjectChatMemberRecord['role'];
  space_id: string;
  updated_at: Date | string;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function json<Value>(value: Value | string): Value {
  return typeof value === 'string' ? JSON.parse(value) as Value : value;
}

export async function findDependentSpecialistMembersForUpdate(
  client: DatabaseQueryClient,
  parent: ProjectChatNameClaimRecord
) {
  const result = await client.query<DependentSpecialistRow>(
    `select member.space_id, member.actor_key, member.member_id,
            member.display_name, member.handle, member.avatar_url, member.role,
            member.origin, member.joined_at, member.updated_at, member.agent_name,
            claim.account_id as child_account_id,
            claim.actor_key as child_actor_key,
            claim.category as child_category,
            claim.claimed_at as child_claimed_at,
            claim.display_name as child_display_name,
            claim.name_key as child_name_key,
            claim.parent_thread_id as child_parent_thread_id,
            claim.thread_id as child_thread_id,
            claim.updated_at as child_updated_at
       from project_chat_name_claims claim
       join project_chat_members member
         on member.space_id = claim.space_id and member.actor_key = claim.actor_key
      where claim.space_id = $1 and claim.account_id = $2
        and claim.parent_thread_id = $3 and member.name_lease_retired_at is null
      order by claim.thread_id
      for update of claim, member`,
    [parent.spaceId, parent.accountId, parent.threadId]
  );
  return result.rows.map((row) => {
    const child: ProjectChatNameClaimRecord = {
      accountId:row.child_account_id,actorKey:row.child_actor_key,
      category:row.child_category,claimedAt:iso(row.child_claimed_at),
      displayName:row.child_display_name,nameKey:row.child_name_key,
      parentThreadId:row.child_parent_thread_id,spaceId:row.space_id,
      threadId:row.child_thread_id,updatedAt:iso(row.child_updated_at)
    };
    const member: ProjectChatMemberRecord = {
      actorKey:row.actor_key,agentName:row.agent_name===null?undefined:json(row.agent_name),
      avatarUrl:row.avatar_url??undefined,displayName:row.display_name,handle:row.handle,
      joinedAt:iso(row.joined_at),memberId:row.member_id,
      origin:row.origin===null?undefined:json(row.origin),role:row.role,
      spaceId:row.space_id,updatedAt:iso(row.updated_at)
    };
    return refreshedDependentSpecialistMember(member, child, parent);
  });
}
