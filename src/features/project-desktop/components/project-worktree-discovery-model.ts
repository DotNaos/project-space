import type { ProjectWorktreeDiscoveryState } from '@/shared/project-space-api';

export function projectWorktreeDiscoverySummary(
  discovery: ProjectWorktreeDiscoveryState,
  serverCount: number
) {
  if (discovery.state === 'checking') return 'Checking worktrees';
  if (discovery.state === 'blocked') return 'Discovery blocked';
  return `${discovery.worktrees.length} worktrees · ${serverCount} servers`;
}
