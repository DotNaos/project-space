import { basename, dirname, resolve } from 'node:path';

import type { ProjectWorktreeRecord } from '../../../src/shared/electron-api';

export function normalizeRepoName(remoteUrl: string) {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const httpsMatch = trimmed.match(/^https:\/\/[^/]+\/[^/]+\/([^/]+)$/i);

  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  const sshMatch = trimmed.match(/^[^:]+:[^/]+\/([^/]+)$/i);

  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  return '';
}

interface InferProjectNameFromGitDataOptions {
  fallbackPath: string;
  gitCommonDir?: string;
  remoteUrl?: string;
  topLevelPath?: string;
}

export function inferProjectNameFromGitData({
  fallbackPath,
  gitCommonDir,
  remoteUrl,
  topLevelPath
}: InferProjectNameFromGitDataOptions) {
  const remoteName = remoteUrl ? normalizeRepoName(remoteUrl) : '';

  if (remoteName) {
    return remoteName;
  }

  if (gitCommonDir) {
    const normalizedGitCommonDir = gitCommonDir.trim().replace(/\/+$/, '');
    const worktreeSplit = normalizedGitCommonDir.split('/.git/worktrees/');

    if (worktreeSplit.length > 1 && worktreeSplit[0]) {
      return basename(worktreeSplit[0]);
    }

    if (normalizedGitCommonDir.endsWith('/.git')) {
      return basename(dirname(normalizedGitCommonDir));
    }

    return basename(dirname(normalizedGitCommonDir));
  }

  if (topLevelPath) {
    return basename(topLevelPath.trim());
  }

  return basename(resolve(fallbackPath));
}

interface CreateWorktreeRecordOptions {
  branchRef?: string;
  isBase: boolean;
  path: string;
  status: ProjectWorktreeRecord['status'];
}

export function createWorktreeRecord({
  branchRef,
  isBase,
  path,
  status
}: CreateWorktreeRecordOptions): ProjectWorktreeRecord {
  const resolvedPath = resolve(path);
  const trimmedBranchRef = branchRef?.trim();
  const branchName = trimmedBranchRef?.replace('refs/heads/', '') || undefined;

  return {
    branchName,
    id: resolvedPath,
    ideaIds: [],
    isBase,
    name: branchName || basename(resolvedPath),
    path: resolvedPath,
    status
  };
}

export function parseWorktreeListOutput(output: string, basePath: string): ProjectWorktreeRecord[] {
  const normalizedBasePath = resolve(basePath);
  const parsedEntries = output
    .trim()
    .split('\n\n')
    .reduce<ProjectWorktreeRecord[]>((entries, block) => {
      const lines = block.split('\n').filter(Boolean);
      const worktreeLine = lines.find((line) => line.startsWith('worktree '));

      if (!worktreeLine) {
        return entries;
      }

      const worktreePath = resolve(worktreeLine.slice('worktree '.length));
      const branchLine = lines.find((line) => line.startsWith('branch '));
      const branchRef = branchLine?.slice('branch '.length);

      entries.push(
        createWorktreeRecord({
          branchRef,
          isBase: worktreePath === normalizedBasePath,
          path: worktreePath,
          status: 'ready'
        })
      );

      return entries;
    }, []);
  const normalizedEntries =
    parsedEntries.length > 0 && !parsedEntries.some((entry) => entry.isBase)
      ? parsedEntries.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                isBase: true
              }
            : entry
        )
      : parsedEntries;

  return normalizedEntries.sort((left, right) => {
      if (left.isBase !== right.isBase) {
        return left.isBase ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}
