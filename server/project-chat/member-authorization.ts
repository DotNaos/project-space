import {
  ProjectChatError,
  type ProjectChatClock,
  type ProjectChatContext
} from './contracts';
import type { ProjectChatRepository } from './repository';
import { normalizeProjectChatHandle, projectChatActorKey } from './validation';

export async function requireProjectChatMember(
  repository: ProjectChatRepository,
  clock: ProjectChatClock,
  context: ProjectChatContext
) {
  let member = await repository.findMemberByActorKey(
    context.spaceId,
    projectChatActorKey(context.actor)
  );
  if (!member) {
    throw new ProjectChatError('not_member', 'Project Chat membership is required.');
  }
  if (context.actor.kind !== 'agent') return member;

  let claim = await repository.findNameClaimByThread(
    context.spaceId,
    context.actor.accountId,
    context.actor.threadId
  );
  if (!claim) {
    throw new ProjectChatError(
      'forbidden',
      'A current Project Chat registry claim is required.'
    );
  }
  const renewed=await repository.renewNameClaim(claim,clock.now().toISOString());
  if (renewed) claim=renewed;
  else {
    claim=await repository.findNameClaimByThread(
      context.spaceId,context.actor.accountId,context.actor.threadId
    );
    member=await repository.findMemberByActorKey(context.spaceId,projectChatActorKey(context.actor));
  }
  if (!claim) {
    throw new ProjectChatError('forbidden','A current Project Chat registry claim is required.');
  }
  if (!member) throw new ProjectChatError('not_member','Project Chat membership is required.');
  const parent = claim.parentThreadId
    ? await repository.findNameClaimByThread(
        context.spaceId,
        context.actor.accountId,
        claim.parentThreadId
      )
    : null;
  const displayName = parent ? `${parent.displayName}.${claim.displayName}` : claim.displayName;
  if (
    claim.parentThreadId && parent &&
    member.agentName?.name === claim.displayName &&
    member.agentName.category === claim.category &&
    member.agentName.parentThreadId === claim.parentThreadId &&
    (member.displayName !== displayName || member.agentName.displayName !== displayName)
  ) {
    member = await repository.upsertMember({
      ...member,
      displayName,
      handle: normalizeProjectChatHandle(displayName),
      agentName: { ...member.agentName, displayName },
      updatedAt: clock.now().toISOString()
    });
  }
  if (
    member.displayName !== displayName ||
    member.agentName?.name !== claim.displayName ||
    member.agentName.category !== claim.category ||
    member.agentName.displayName !== displayName ||
    member.agentName.parentThreadId !== claim.parentThreadId
  ) {
    throw new ProjectChatError(
      'forbidden',
      'Project Chat membership does not match its registry claim.'
    );
  }
  return member;
}
