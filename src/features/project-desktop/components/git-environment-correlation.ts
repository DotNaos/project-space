import type { DeployedEnvironmentStatus, GitHistoryCommit } from '@/shared/project-space-api';
import { normalizedFullSha } from './deployment-status-model';

export function correlateEnvironments(
  commits: GitHistoryCommit[],
  environments: DeployedEnvironmentStatus[]
) {
  const hashes = new Set(commits.map((commit) => normalizedFullSha(commit.hash)).filter(Boolean));
  const byCommit = new Map<string, DeployedEnvironmentStatus[]>();
  for (const environment of environments) {
    const sha = normalizedFullSha(environment.deployedSha);
    if (!sha) continue;
    const entries = byCommit.get(sha) ?? [];
    entries.push(environment);
    byCommit.set(sha, entries);
  }
  return {
    byCommit,
    outsideHistory: environments.filter((environment) =>
      Boolean(normalizedFullSha(environment.deployedSha)) &&
        !hashes.has(normalizedFullSha(environment.deployedSha))
    )
  };
}

export function commitsBehindRef(
  commits: GitHistoryCommit[],
  deployedSha: string,
  refTipSha: string
) {
  if (deployedSha === refTipSha) return 0;
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const queue: Array<{ distance: number; hash: string }> = [{ distance: 0, hash: refTipSha }];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current.hash)) continue;
    seen.add(current.hash);
    if (current.hash === deployedSha) return current.distance;
    const commit = byHash.get(current.hash);
    for (const parent of commit?.parents ?? []) queue.push({ distance: current.distance + 1, hash: parent });
  }
  return undefined;
}
