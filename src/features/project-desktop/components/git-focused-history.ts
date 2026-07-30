import type { GitHistoryCommit } from '@/shared/project-space-api';

export interface GitHistoryFocus {
  defaultBranch: string;
  headBranch: string;
  requestId: number;
}

function compareCommits(
  left: GitHistoryCommit,
  right: GitHistoryCommit,
  inputOrder: Map<string, number>
) {
  const dateDifference =
    Date.parse(right.date) - Date.parse(left.date);

  if (Number.isFinite(dateDifference) && dateDifference !== 0) {
    return dateDifference;
  }

  return (
    (inputOrder.get(left.hash) ?? Number.MAX_SAFE_INTEGER) -
    (inputOrder.get(right.hash) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function mergeFocusedGitHistories(
  histories: GitHistoryCommit[][]
): GitHistoryCommit[] {
  const commits = new Map<string, GitHistoryCommit>();
  const inputOrder = new Map<string, number>();

  for (const history of histories) {
    for (const commit of history) {
      if (!inputOrder.has(commit.hash)) {
        inputOrder.set(commit.hash, inputOrder.size);
      }
      const current = commits.get(commit.hash);
      commits.set(commit.hash, current
        ? {
            ...commit,
            refs: Array.from(new Set([...current.refs, ...commit.refs]))
          }
        : commit);
    }
  }

  const childCount = new Map<string, number>();
  for (const hash of commits.keys()) {
    childCount.set(hash, 0);
  }
  for (const commit of commits.values()) {
    for (const parent of commit.parents) {
      if (commits.has(parent)) {
        childCount.set(parent, (childCount.get(parent) ?? 0) + 1);
      }
    }
  }

  const ready = Array.from(commits.values())
    .filter((commit) => childCount.get(commit.hash) === 0)
    .sort((left, right) => compareCommits(left, right, inputOrder));
  const ordered: GitHistoryCommit[] = [];

  while (ready.length > 0) {
    const commit = ready.shift();
    if (!commit) break;
    ordered.push(commit);

    for (const parent of commit.parents) {
      if (!commits.has(parent)) continue;
      const remainingChildren = (childCount.get(parent) ?? 0) - 1;
      childCount.set(parent, remainingChildren);
      if (remainingChildren === 0) {
        const parentCommit = commits.get(parent);
        if (parentCommit) {
          ready.push(parentCommit);
          ready.sort((left, right) => compareCommits(left, right, inputOrder));
        }
      }
    }
  }

  if (ordered.length === commits.size) {
    return ordered;
  }

  const orderedHashes = new Set(ordered.map((commit) => commit.hash));
  return [
    ...ordered,
    ...Array.from(commits.values())
      .filter((commit) => !orderedHashes.has(commit.hash))
      .sort((left, right) => compareCommits(left, right, inputOrder))
  ];
}
