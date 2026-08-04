import {
  ProjectChatError,
  type ProjectChatClock,
  type ProjectChatContext
} from './contracts';
import type { ProjectChatRepository } from './repository';
import { projectChatActorKey } from './validation';

export async function requireProjectChatMember(
  repository: ProjectChatRepository,
  clock: ProjectChatClock,
  context: ProjectChatContext
) {
  const member = await repository.findMemberByActorKey(
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
  claim = await repository.claimName({ ...claim, updatedAt: clock.now().toISOString() });
  const parent = claim.parentThreadId
    ? await repository.findNameClaimByThread(
        context.spaceId,
        context.actor.accountId,
        claim.parentThreadId
      )
    : null;
  const displayName = parent ? `${parent.displayName}.${claim.displayName}` : claim.displayName;
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
