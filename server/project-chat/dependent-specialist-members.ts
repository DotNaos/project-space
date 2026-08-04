import type { ProjectChatMemberRecord, ProjectChatNameClaimRecord } from './contracts';
import { ProjectChatHandleConflictError, memberForNameClaim } from './repository';
import { normalizeProjectChatHandle } from './validation';

export function isMythologyParentRename(
  existing: ProjectChatNameClaimRecord | null | undefined,
  next: ProjectChatNameClaimRecord
) {
  return existing?.category === 'mythology' && next.category === 'mythology' &&
    existing.nameKey !== next.nameKey;
}

export function refreshedDependentSpecialistMember(
  member: ProjectChatMemberRecord,
  child: ProjectChatNameClaimRecord,
  parent: ProjectChatNameClaimRecord
) {
  const refreshed = memberForNameClaim(member, child, parent);
  return {
    ...refreshed,
    handle: normalizeProjectChatHandle(refreshed.displayName),
    updatedAt: parent.updatedAt
  };
}

export function dependentSpecialistMemberUpdates(input: {
  claims: Iterable<ProjectChatNameClaimRecord>;
  existing: ProjectChatNameClaimRecord | null | undefined;
  findMember: (claim: ProjectChatNameClaimRecord) => ProjectChatMemberRecord | undefined;
  parent: ProjectChatNameClaimRecord;
}) {
  if (!isMythologyParentRename(input.existing, input.parent)) return [];
  return [...input.claims].flatMap((child) => {
    if (
      child.spaceId !== input.parent.spaceId || child.accountId !== input.parent.accountId ||
      child.parentThreadId !== input.parent.threadId
    ) return [];
    const member = input.findMember(child);
    return member ? [refreshedDependentSpecialistMember(member, child, input.parent)] : [];
  });
}

export function validateProjectChatMemberHandleUpdates(
  members: ProjectChatMemberRecord[],
  currentHandleOwner: (spaceId: string, handle: string) => string | undefined,
  currentActorMember: (spaceId: string, actorKey: string) => string | undefined
) {
  const targetOwner = new Map<string, string>();
  for (const member of members) {
    const handle = member.handle.toLowerCase();
    const key = JSON.stringify([member.spaceId, handle]);
    const memberId = currentActorMember(member.spaceId, member.actorKey) ?? member.memberId;
    const queuedOwner = targetOwner.get(key);
    const handleOwner = currentHandleOwner(member.spaceId, handle);
    if (
      (queuedOwner && queuedOwner !== memberId) ||
      (handleOwner && handleOwner !== memberId)
    ) throw new ProjectChatHandleConflictError();
    targetOwner.set(key, memberId);
  }
}
