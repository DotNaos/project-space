import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ProjectWorktreeRecord } from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);

async function runCommand(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    windowsHide: true
  });

  return stdout;
}

async function listDirectoryEntries(path: string) {
  try {
    return await readdir(path, {
      withFileTypes: true
    });
  } catch {
    return [];
  }
}

function createBaseWorktree(projectPath: string): ProjectWorktreeRecord {
  const resolvedPath = resolve(projectPath);

  return {
    id: resolvedPath,
    name: basename(resolvedPath),
    path: resolvedPath,
    isBase: true,
    status: 'ready'
  };
}

function parseWorktreeList(output: string, basePath: string): ProjectWorktreeRecord[] {
  const normalizedBasePath = resolve(basePath);

  return output
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
      const branchRef = branchLine?.slice('branch '.length).trim();

      entries.push({
        branchName: branchRef?.replace('refs/heads/', ''),
        id: worktreePath,
        isBase: worktreePath === normalizedBasePath,
        name: basename(worktreePath),
        path: worktreePath,
        status: 'ready'
      });

      return entries;
    }, [])
    .sort((left, right) => {
      if (left.isBase !== right.isBase) {
        return left.isBase ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function scanProjectContainerWorktrees(projectPath: string): Promise<ProjectWorktreeRecord[]> {
  const entries = await listDirectoryEntries(projectPath);

  return entries
    .filter((entry) => entry.isDirectory())
    .reduce<ProjectWorktreeRecord[]>((worktrees, entry) => {
      const worktreePath = resolve(projectPath, entry.name);
      const gitPath = join(worktreePath, '.git');

      if (!existsSync(gitPath)) {
        return worktrees;
      }

      let status: ProjectWorktreeRecord['status'] = 'ready';

      try {
        const gitPointer = readFileSync(gitPath, 'utf-8').trim();

        if (gitPointer.startsWith('gitdir:')) {
          const gitDirPath = gitPointer.slice('gitdir:'.length).trim();
          const resolvedGitDir = gitDirPath.startsWith('/')
            ? gitDirPath
            : resolve(worktreePath, gitDirPath);

          if (!existsSync(resolvedGitDir)) {
            status = 'broken';
          }
        }
      } catch {
        status = 'ready';
      }

      worktrees.push({
        id: worktreePath,
        isBase: entry.name === 'base',
        name: entry.name,
        path: worktreePath,
        status
      });

      return worktrees;
    }, [])
    .sort((left, right) => {
      if (left.isBase !== right.isBase) {
        return left.isBase ? -1 : 1;
      }

      if (left.status !== right.status) {
        return left.status === 'ready' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

async function readWorktreeBranchName(worktreePath: string) {
  try {
    const branch = (
      await runCommand('git', ['-C', worktreePath, 'branch', '--show-current'])
    ).trim();

    return branch || undefined;
  } catch {
    return undefined;
  }
}

function canonicalProjectsRootFor(projectPath: string, projectName: string) {
  const parentPath = dirname(projectPath);

  if (basename(parentPath) === projectName) {
    return dirname(parentPath);
  }

  return parentPath;
}

function canonicalProjectPaths(projectPath: string, projectName: string) {
  const projectsRoot = canonicalProjectsRootFor(projectPath, projectName);

  return {
    mainPath: resolve(projectsRoot, projectName),
    projectsRoot,
    worktreesRoot: resolve(projectsRoot, '.worktrees', projectName)
  };
}

function isPathInside(parentPath: string, childPath: string) {
  const relativePath = relative(resolve(parentPath), resolve(childPath));

  return Boolean(relativePath) && !relativePath.startsWith('..') && !relativePath.startsWith('/');
}

async function scanCanonicalWorktrees(
  projectPath: string,
  projectName: string
): Promise<ProjectWorktreeRecord[]> {
  const { worktreesRoot } = canonicalProjectPaths(projectPath, projectName);
  const entries = await listDirectoryEntries(worktreesRoot);

  const worktrees: Array<ProjectWorktreeRecord | undefined> = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const worktreePath = resolve(worktreesRoot, entry.name);
        const gitPath = join(worktreePath, '.git');

        if (!existsSync(gitPath)) {
          return undefined;
        }

        let status: ProjectWorktreeRecord['status'] = 'ready';

        try {
          const gitPointer = readFileSync(gitPath, 'utf-8').trim();

          if (gitPointer.startsWith('gitdir:')) {
            const gitDirPath = gitPointer.slice('gitdir:'.length).trim();
            const resolvedGitDir = gitDirPath.startsWith('/')
              ? gitDirPath
              : resolve(worktreePath, gitDirPath);

            if (!existsSync(resolvedGitDir)) {
              status = 'broken';
            }
          }
        } catch {
          status = 'ready';
        }

        return {
          branchName: await readWorktreeBranchName(worktreePath),
          id: worktreePath,
          isBase: false,
          name: entry.name,
          path: worktreePath,
          status
        } satisfies ProjectWorktreeRecord;
      })
  );

  return worktrees
    .filter((entry): entry is ProjectWorktreeRecord => entry !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mergeWorktreeRecords(worktrees: ProjectWorktreeRecord[]) {
  const recordsByPath = new Map<string, ProjectWorktreeRecord>();

  for (const worktree of worktrees) {
    recordsByPath.set(resolve(worktree.path), worktree);
  }

  return Array.from(recordsByPath.values()).sort((left, right) => {
    if (left.isBase !== right.isBase) {
      return left.isBase ? -1 : 1;
    }

    if (left.status !== right.status) {
      return left.status === 'ready' ? -1 : 1;
    }

    return (left.branchName || left.name).localeCompare(right.branchName || right.name);
  });
}

export async function loadLocalProjectWorktrees(
  projectPath: string
): Promise<ProjectWorktreeRecord[]> {
  const resolvedProjectPath = resolve(projectPath);

  try {
    const gitCommonDir = (
      await runCommand('git', [
        '-C',
        resolvedProjectPath,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir'
      ])
    ).trim();
    const basePath = dirname(gitCommonDir);
    const worktreeList = await runCommand('git', [
      '-C',
      resolvedProjectPath,
      'worktree',
      'list',
      '--porcelain'
    ]);
    const parsedWorktrees = parseWorktreeList(worktreeList, basePath);
    const projectName = basename(basePath);
    const { mainPath, worktreesRoot } = canonicalProjectPaths(basePath, projectName);
    const canonicalParsedWorktrees = parsedWorktrees.filter((worktree) => {
      if (worktree.isBase) {
        return resolve(worktree.path) === mainPath;
      }

      return isPathInside(worktreesRoot, worktree.path);
    });
    const canonicalWorktrees = await scanCanonicalWorktrees(basePath, projectName);

    return mergeWorktreeRecords([
      ...canonicalParsedWorktrees,
      ...(canonicalParsedWorktrees.length === 0 && resolve(basePath) === mainPath
        ? [createBaseWorktree(basePath)]
        : []),
      ...canonicalWorktrees
    ]);
  } catch {
    const scannedWorktrees = await scanProjectContainerWorktrees(resolvedProjectPath);
    const canonicalWorktrees = await scanCanonicalWorktrees(
      resolvedProjectPath,
      basename(resolvedProjectPath)
    );

    return mergeWorktreeRecords([...scannedWorktrees, ...canonicalWorktrees]);
  }
}
