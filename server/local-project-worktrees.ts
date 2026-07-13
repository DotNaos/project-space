import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ProjectWorktreeRecord } from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);

type WorktreeParserOptions = {
  basePath: string;
  gitCommonDir: string;
  pathHealth?: (path: string, isBase: boolean) => WorktreePathHealth;
  registrationKeys: ReadonlyMap<string, string>;
};

type WorktreePathHealth = 'present' | 'missing' | 'broken' | 'unavailable';

type ParsedWorktreeBlock = {
  branchName?: string;
  detached: boolean;
  headSha?: string;
  lockedReason?: string;
  path?: string;
  prunableReason?: string;
  validBranch: boolean;
};

async function runCommand(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });

  return stdout;
}

function opaqueWorktreeId(gitCommonDir: string, registrationKey: string) {
  const digest = createHash('sha256')
    .update(resolve(gitCommonDir))
    .update('\0')
    .update(registrationKey)
    .digest('hex')
    .slice(0, 24);

  return `wt_${digest}`;
}

async function loadRegistrationKeys(gitCommonDir: string, basePath: string) {
  const registrationKeys = new Map<string, string>([[resolve(basePath), 'main']]);
  const worktreesDirectory = resolve(gitCommonDir, 'worktrees');

  try {
    const entries = await readdir(worktreesDirectory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const registrationDirectory = resolve(worktreesDirectory, entry.name);
          try {
            const gitdirPointer = (await readFile(resolve(registrationDirectory, 'gitdir'), 'utf8')).trim();
            const gitdirPath = gitdirPointer.startsWith(sep)
              ? gitdirPointer
              : resolve(registrationDirectory, gitdirPointer);
            registrationKeys.set(resolve(dirname(gitdirPath)), entry.name);
          } catch {
            // Git porcelain still reports the registration; the opaque fallback remains resolvable.
          }
        })
    );
  } catch {
    // A repository with only its main worktree has no linked-worktree registry directory.
  }

  return registrationKeys;
}

function canonicalProjectsRootFor(projectPath: string, projectName: string) {
  const parentPath = dirname(projectPath);

  if (basename(parentPath) === projectName) {
    return dirname(parentPath);
  }

  return parentPath;
}

function canonicalWorktreesRoot(basePath: string, projectName: string) {
  return resolve(canonicalProjectsRootFor(basePath, projectName), '.worktrees', projectName);
}

function isPathInside(parentPath: string, childPath: string) {
  const relativePath = relative(resolve(parentPath), resolve(childPath));

  return (
    Boolean(relativePath) &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function isCodexStylePath(worktreePath: string, projectName: string, worktreesRoot: string) {
  const resolvedPath = resolve(worktreePath);
  const pathParts = resolvedPath.split(sep).filter(Boolean);
  const codexDirectoryIndex = pathParts.lastIndexOf('.codex');

  if (pathParts.includes('.codex-worktrees')) {
    return true;
  }
  if (codexDirectoryIndex >= 0 && pathParts[codexDirectoryIndex + 1] === 'worktrees') {
    return true;
  }

  const tokenDirectory = dirname(resolvedPath);
  return (
    basename(resolvedPath) === projectName &&
    basename(dirname(tokenDirectory)) === '.worktrees' &&
    resolve(tokenDirectory) !== resolve(worktreesRoot)
  );
}

function classifyWorktree(
  worktreePath: string,
  basePath: string,
  projectName: string,
  isBase: boolean
): ProjectWorktreeRecord['kind'] {
  if (isBase || isPathInside(canonicalWorktreesRoot(basePath, projectName), worktreePath)) {
    return 'project-managed';
  }
  if (
    isCodexStylePath(
      worktreePath,
      projectName,
      canonicalWorktreesRoot(basePath, projectName)
    )
  ) {
    return 'codex';
  }
  return 'external';
}

function worktreeStatus(
  block: ParsedWorktreeBlock,
  pathHealth: WorktreePathHealth,
  identityAvailable: boolean
): Pick<ProjectWorktreeRecord, 'status' | 'statusReason'> {
  if (!identityAvailable) {
    return { status: 'unavailable', statusReason: 'Git registration identity is unavailable.' };
  }
  if (pathHealth === 'unavailable') {
    return { status: 'unavailable', statusReason: 'The registered worktree could not be inspected.' };
  }
  if (pathHealth === 'missing') {
    return { status: 'missing', statusReason: 'The registered worktree path is missing.' };
  }
  if (pathHealth === 'broken') {
    return { status: 'broken', statusReason: 'The registered worktree Git pointer is broken.' };
  }
  if (!block.headSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(block.headSha)) {
    return { status: 'broken', statusReason: 'Git did not report a valid HEAD commit.' };
  }
  if (!block.validBranch || block.detached === Boolean(block.branchName)) {
    return { status: 'broken', statusReason: 'Git reported contradictory branch state.' };
  }
  if (block.prunableReason !== undefined) {
    return {
      status: 'prunable',
      statusReason: block.prunableReason || 'Git reports this registration as prunable.'
    };
  }
  if (block.lockedReason !== undefined) {
    return {
      status: 'locked',
      statusReason: block.lockedReason || 'Git has locked this worktree.'
    };
  }
  return { status: 'ready' };
}

function registeredPathHealth(worktreePath: string, isBase: boolean): WorktreePathHealth {
  try {
    if (!existsSync(worktreePath)) return 'missing';
    const gitPointerPath = resolve(worktreePath, '.git');
    const gitPointerStat = lstatSync(gitPointerPath);

    if (gitPointerStat.isDirectory()) return isBase ? 'present' : 'broken';
    if (!gitPointerStat.isFile()) return 'broken';

    const gitPointer = readFileSync(gitPointerPath, 'utf8').trim();
    if (!gitPointer.startsWith('gitdir:')) return 'broken';
    const gitDirectory = gitPointer.slice('gitdir:'.length).trim();
    const resolvedGitDirectory = isAbsolute(gitDirectory)
      ? gitDirectory
      : resolve(worktreePath, gitDirectory);
    return existsSync(resolvedGitDirectory) ? 'present' : 'broken';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'broken' : 'unavailable';
  }
}

function detachedLabel(
  kind: ProjectWorktreeRecord['kind'],
  worktreePath: string,
  headSha?: string
) {
  const shortHead = headSha?.slice(0, 7) || 'unknown';

  if (kind === 'codex') {
    return `Codex · ${basename(dirname(worktreePath))} · ${shortHead}`;
  }
  if (kind === 'external') {
    return `External · ${basename(dirname(worktreePath))}/${basename(worktreePath)} · ${shortHead}`;
  }
  return `Detached · ${basename(worktreePath)} · ${shortHead}`;
}

function parseBlock(fields: string[]): ParsedWorktreeBlock {
  const block: ParsedWorktreeBlock = { detached: false, validBranch: true };

  for (const field of fields) {
    const separatorIndex = field.indexOf(' ');
    const key = separatorIndex < 0 ? field : field.slice(0, separatorIndex);
    const value = separatorIndex < 0 ? '' : field.slice(separatorIndex + 1);

    if (key === 'worktree') block.path = value;
    if (key === 'HEAD') block.headSha = value || undefined;
    if (key === 'branch') {
      block.validBranch = value.startsWith('refs/heads/');
      block.branchName = block.validBranch ? value.slice('refs/heads/'.length) || undefined : undefined;
    }
    if (key === 'detached') block.detached = true;
    if (key === 'locked') block.lockedReason = value;
    if (key === 'prunable') block.prunableReason = value;
  }

  return block;
}

function splitPorcelainBlocks(output: string) {
  const fields = output.includes('\0') ? output.split('\0') : output.split('\n');
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const field of fields) {
    if (field) {
      current.push(field);
      continue;
    }
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

export function parseGitWorktreePorcelain(
  output: string,
  options: WorktreeParserOptions
): ProjectWorktreeRecord[] {
  const basePath = resolve(options.basePath);
  const pathHealth = options.pathHealth ?? registeredPathHealth;
  const parsedBlocks = splitPorcelainBlocks(output).map(parseBlock);
  const projectName = basename(basePath);

  return parsedBlocks
    .reduce<ProjectWorktreeRecord[]>((records, block, index) => {
      if (!block.path) return records;

      const worktreePath = resolve(block.path);
      const isBase = worktreePath === basePath;
      const kind = classifyWorktree(worktreePath, basePath, projectName, isBase);
      const registrationKey = options.registrationKeys.get(worktreePath);
      const detached = block.detached;

      records.push({
        branchName: block.branchName,
        detached,
        headSha: block.headSha,
        id: opaqueWorktreeId(options.gitCommonDir, registrationKey || `unavailable:${index}`),
        isBase,
        kind,
        locked: block.lockedReason !== undefined,
        lockedReason: block.lockedReason || undefined,
        name:
          block.branchName || detachedLabel(kind, worktreePath, block.headSha),
        path: worktreePath,
        prunable: block.prunableReason !== undefined,
        prunableReason: block.prunableReason || undefined,
        ...worktreeStatus(block, pathHealth(worktreePath, isBase), Boolean(registrationKey))
      });
      return records;
    }, [])
    .sort((left, right) => {
      if (left.isBase !== right.isBase) return left.isBase ? -1 : 1;
      if (left.status !== right.status) return left.status === 'ready' ? -1 : 1;
      return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
    });
}

export async function loadLocalProjectWorktrees(
  projectPath: string
): Promise<ProjectWorktreeRecord[]> {
  const resolvedProjectPath = resolve(projectPath);
  const gitCommonDir = (
    await runCommand('git', [
      '-C',
      resolvedProjectPath,
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir'
    ])
  ).trim();
  const worktreeList = await runCommand('git', [
    '-C',
    resolvedProjectPath,
    'worktree',
    'list',
    '--porcelain',
    '-z',
    '--expire=now'
  ]);
  const basePath = dirname(gitCommonDir);
  const registrationKeys = await loadRegistrationKeys(gitCommonDir, basePath);

  return parseGitWorktreePorcelain(worktreeList, {
    basePath,
    gitCommonDir,
    registrationKeys
  });
}

export async function resolveLocalProjectWorktree(
  projectPath: string,
  worktreeId: string,
  options: { expectedHeadSha?: string } = {}
): Promise<ProjectWorktreeRecord> {
  if (!/^wt_[a-f0-9]{24}$/.test(worktreeId)) {
    throw new Error('The worktree ID is invalid.');
  }
  const worktrees = await loadLocalProjectWorktrees(projectPath);
  const worktree = worktrees.find((entry) => entry.id === worktreeId);

  if (!worktree) {
    throw new Error('The worktree is no longer registered for this project.');
  }
  if (worktree.status !== 'ready') {
    throw new Error(`The worktree is ${worktree.status} and cannot be used.`);
  }
  if (options.expectedHeadSha && worktree.headSha !== options.expectedHeadSha) {
    throw new Error('The worktree HEAD changed before the action could start.');
  }
  return worktree;
}
