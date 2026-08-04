import {
  ProjectChatError,
  type ProjectChatAutomaticNameClaimInput,
  type ProjectChatContext,
  type ProjectChatNameClaimInput
} from './contracts';
import {
  automaticProjectChatNameCount,
  automaticProjectChatNameForThread,
  findProjectChatName
} from './name-registry';
import type { ProjectChatRepository } from './repository';

interface AutomaticNameAllocationOptions<Result> {
  claimName: (input: ProjectChatNameClaimInput) => Promise<Result>;
  context: ProjectChatContext;
  input: ProjectChatAutomaticNameClaimInput;
  now: () => Date;
  reapExpired: (spaceId: string, now: Date) => Promise<number>;
  repository: ProjectChatRepository;
}

export async function claimAutomaticProjectChatName<Result>(
  options: AutomaticNameAllocationOptions<Result>
) {
  const { context, input, repository } = options;
  if (context.actor.kind !== 'agent') {
    throw new ProjectChatError('forbidden', 'Only agents can claim automatic names.');
  }
  const actor = context.actor;
  const excluded = automaticNameExclusions(input);
  const preferred = automaticNamePreference(input,excluded);

  for (let round = 0; round < 8; round += 1) {
    const now = options.now();
    await options.reapExpired(context.spaceId, now);
    const claims = await repository.listNameClaims(context.spaceId);
    const current = claims.find((claim) =>
      claim.accountId === actor.accountId && claim.threadId === actor.threadId
    );
    if (current && !excluded.has(current.nameKey)) {
      return options.claimName({
        name: current.displayName,
        category: current.category,
        ...(current.parentThreadId ? { parentThreadId: current.parentThreadId } : {})
      });
    }
    const unavailable = new Set([...claims.map((claim) => claim.nameKey), ...excluded]);
    let candidate=preferred && !unavailable.has(preferred[0]) ? preferred : undefined;
    for (let attempt = 0; !candidate && attempt < automaticProjectChatNameCount; attempt += 1) {
      const entry = automaticProjectChatNameForThread(actor.threadId, attempt);
      if (!unavailable.has(entry[0])) {
        candidate = entry;
        break;
      }
    }
    if (!candidate) {
      throw new ProjectChatError(
        'name_conflict',
        'No automatic Project Chat name remains available.'
      );
    }
    try {
      return await options.claimName({ name: candidate[1], category: candidate[2] });
    } catch (error) {
      if (!(error instanceof ProjectChatError) || error.code !== 'name_conflict') throw error;
    }
  }
  throw new ProjectChatError(
    'name_conflict',
    'Automatic Project Chat allocation remained contended.'
  );
}

function automaticNamePreference(
  input:ProjectChatAutomaticNameClaimInput,
  excluded:Set<string>
) {
  if(input.preferredName===undefined) return undefined;
  if(typeof input.preferredName!=='string' || input.preferredName.length>128) {
    throw new ProjectChatError('invalid_request','The preferred automatic name is invalid.');
  }
  const entry=findProjectChatName(input.preferredName);
  if(!entry || entry[2]!=='mythology' || excluded.has(entry[0])) return undefined;
  return entry;
}

function automaticNameExclusions(input: ProjectChatAutomaticNameClaimInput) {
  if (!input || (input.excludedNames !== undefined && !Array.isArray(input.excludedNames))) {
    throw new ProjectChatError('invalid_request', 'Automatic name exclusions must be a list.');
  }
  if ((input.excludedNames?.length ?? 0) > automaticProjectChatNameCount) {
    throw new ProjectChatError('invalid_request', 'Too many automatic name exclusions.');
  }
  return new Set((input.excludedNames ?? []).map((name) => {
    if (typeof name !== 'string' || name.length > 128) {
      throw new ProjectChatError('invalid_request', 'Automatic name exclusions are invalid.');
    }
    return name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  }));
}
