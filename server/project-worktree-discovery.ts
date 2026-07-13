import type {
  ProjectWorktreeDiscoveryResult,
  ProjectWorktreeRecord
} from '../src/shared/project-space-api';

interface DiscoverProjectWorktreesOptions {
  projectPath: string;
  scan(): Promise<ProjectWorktreeRecord[]>;
}

function messageFor(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Git worktree discovery failed.';
}

function reasonFor(error: unknown): 'connector-update-required' | 'scan-failed' {
  const message = messageFor(error).toLowerCase();
  return message.includes('update or restart') || message.includes('incompatible worktree')
    ? 'connector-update-required'
    : 'scan-failed';
}

export async function discoverProjectWorktrees({
  projectPath,
  scan
}: DiscoverProjectWorktreesOptions): Promise<ProjectWorktreeDiscoveryResult> {
  try {
    const worktrees = await scan();
    const evidence = {
      checkedAt: new Date().toISOString(),
      projectPath,
      source: 'git-worktree-list' as const
    };

    return worktrees.length > 0
      ? {
          evidence,
          state: 'ready',
          worktrees: worktrees as [ProjectWorktreeRecord, ...ProjectWorktreeRecord[]]
        }
      : { evidence, state: 'proven-empty', worktrees: [] };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      message: messageFor(error),
      reason: reasonFor(error),
      state: 'blocked'
    };
  }
}

export function reconcileProjectWorktreeDiscovery(
  discovery: ProjectWorktreeDiscoveryResult,
  hasValidCheckoutEvidence: boolean
): ProjectWorktreeDiscoveryResult {
  if (discovery.state !== 'proven-empty' || !hasValidCheckoutEvidence) {
    return discovery;
  }

  return {
    checkedAt: discovery.evidence.checkedAt,
    message:
      'Project discovery found a valid Git checkout, but its authoritative worktree scan returned no registrations.',
    reason: 'source-disagreement',
    state: 'blocked'
  };
}
