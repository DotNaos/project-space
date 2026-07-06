import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { runCommand } from './local-command-runner';
import type {
  GitActionResult,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitHistoryCommit,
  GitHistoryRequest,
  GitHistoryResult,
  GitStageRequest,
  GitStatusEntry,
  GitStatusResult
} from '../src/shared/project-space-api';

const FIELD_SEPARATOR = String.fromCharCode(31);
const MAX_HISTORY_LIMIT = 1000;

function parseStatusEntry(line: string): GitStatusEntry | null {
  if (line.length < 4) {
    return null;
  }

  const indexStatus = line[0] ?? ' ';
  const worktreeStatus = line[1] ?? ' ';
  const path = line.slice(3).replace(/^"|"$/g, '');

  return {
    displayStatus: `${indexStatus}${worktreeStatus}`.trim() || 'clean',
    indexStatus,
    path,
    worktreeStatus
  };
}

function resolveConfiguredBackendRepositoryPath() {
  return process.env.PROJECT_SPACE_BACKEND_REPO_PATH
    ? resolve(process.env.PROJECT_SPACE_BACKEND_REPO_PATH)
    : undefined;
}

function gitArgsForCwd(args: string[], cwd: string) {
  const backendRepositoryPath = resolveConfiguredBackendRepositoryPath();
  const resolvedCwd = resolve(cwd);

  if (
    backendRepositoryPath &&
    (resolvedCwd === backendRepositoryPath ||
      resolvedCwd.startsWith(`${backendRepositoryPath}/`))
  ) {
    return ['-c', `safe.directory=${backendRepositoryPath}`, ...args];
  }

  return args;
}

async function git(args: string[], cwd: string) {
  return runCommand('git', gitArgsForCwd(args, cwd), cwd);
}

async function resolveGitRoot(cwd: string) {
  const output = await git(['rev-parse', '--show-toplevel'], cwd);

  return output.stdout.trim();
}

function parseGitHistory(stdout: string): GitHistoryCommit[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, parents, author, date, refs, ...subjectParts] = line.split(FIELD_SEPARATOR);

      return {
        author: author ?? '',
        date: date ?? '',
        hash: hash ?? '',
        parents: (parents ?? '').split(' ').filter(Boolean),
        refs: (refs ?? '')
          .split(',')
          .map((ref) => ref.trim())
          .filter(Boolean),
        subject: subjectParts.join(FIELD_SEPARATOR) || ''
      };
    })
    .filter((commit) => commit.hash);
}

function normalizeRepositoryFullName(value: string | undefined) {
  return value?.trim().replace(/\.git$/, '').toLowerCase();
}

function parseRepositoryFullNameFromRemote(remoteUrl: string) {
  const trimmed = remoteUrl.trim().replace(/\.git$/, '');
  const githubMatch = trimmed.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+)$/i);

  if (!githubMatch?.groups) {
    return undefined;
  }

  return `${githubMatch.groups.owner}/${githubMatch.groups.repo}`;
}

async function repositoryMatches(root: string, repositoryFullName: string | undefined) {
  const expected = normalizeRepositoryFullName(repositoryFullName);

  if (!expected) {
    return true;
  }

  const remoteOutput = await git(['remote', 'get-url', 'origin'], root).catch(() => ({
    stdout: '',
    stderr: ''
  }));
  const actual = normalizeRepositoryFullName(
    parseRepositoryFullNameFromRemote(remoteOutput.stdout)
  );

  return actual === expected;
}

function getBackendRepositoryCandidates(requestCwd: string | undefined) {
  return Array.from(
    new Set(
      [
        requestCwd,
        process.env.PROJECT_SPACE_BACKEND_REPO_PATH,
        process.cwd()
      ].filter((candidate): candidate is string => Boolean(candidate?.trim()))
    )
  );
}

function normalizeHistoryLimit(limit: number | undefined) {
  const numericLimit = Math.trunc(limit ?? 300);

  if (!Number.isFinite(numericLimit)) {
    return 300;
  }

  return Math.min(Math.max(numericLimit, 1), MAX_HISTORY_LIMIT);
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult> {
  const resolvedCwd = resolve(cwd);

  try {
    const repositoryRoot = await resolveGitRoot(resolvedCwd);
    const branchOutput = await git(['branch', '--show-current'], repositoryRoot);
    const upstreamOutput = await git(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      repositoryRoot
    ).catch(() => ({ stdout: '', stderr: '' }));
    const statusOutput = await git(['status', '--porcelain=v1'], repositoryRoot);
    const entries = statusOutput.stdout
      .split('\n')
      .map((line) => parseStatusEntry(line))
      .filter((entry): entry is GitStatusEntry => Boolean(entry));

    return {
      branchName: branchOutput.stdout.trim() || 'detached',
      entries,
      isRepository: true,
      repositoryRoot,
      summary: {
        changed: entries.length,
        staged: entries.filter(
          (entry) => entry.indexStatus.trim() && entry.indexStatus !== '?'
        ).length,
        untracked: entries.filter((entry) => entry.displayStatus === '??').length
      },
      upstream: upstreamOutput.stdout.trim() || undefined
    };
  } catch {
    return {
      branchName: '',
      entries: [],
      isRepository: false,
      repositoryRoot: resolvedCwd,
      summary: {
        changed: 0,
        staged: 0,
        untracked: 0
      }
    };
  }
}

export async function getGitDiff(request: GitDiffRequest): Promise<GitDiffResult> {
  const status = await getGitStatus(request.cwd);

  if (!status.isRepository) {
    return {
      diff: 'Selected target is not a git repository.',
      path: request.path,
      staged: Boolean(request.staged)
    };
  }

  const args = ['diff'];
  if (request.staged) {
    args.push('--cached');
  }

  if (request.path) {
    args.push('--', request.path);
  }

  const output = await git(args, status.repositoryRoot);

  return {
    diff: output.stdout || output.stderr || 'No diff for this selection.',
    path: request.path,
    staged: Boolean(request.staged)
  };
}

export async function getGitHistory(request: GitHistoryRequest): Promise<GitHistoryResult> {
  const limit = normalizeHistoryLimit(request.limit);
  const candidates = getBackendRepositoryCandidates(request.cwd);
  const fallbackCwd = request.cwd ? resolve(request.cwd) : resolve(process.cwd());
  const ref = request.ref?.trim();

  for (const candidate of candidates) {
    const resolvedCwd = resolve(candidate);

    if (!existsSync(resolvedCwd)) {
      continue;
    }

    const status = await getGitStatus(resolvedCwd);

    if (!status.isRepository) {
      continue;
    }

    if (!(await repositoryMatches(status.repositoryRoot, request.repositoryFullName))) {
      continue;
    }

    try {
      const output = await git(
        [
          'log',
          ...(ref ? [ref] : ['--all']),
          '--date-order',
          '-n',
          String(limit),
          '--date=short',
          '--pretty=format:%H%x1f%P%x1f%an%x1f%ad%x1f%D%x1f%s'
        ],
        status.repositoryRoot
      );

      return {
        commits: parseGitHistory(output.stdout),
        cwd: resolvedCwd,
        isRepository: true,
        repositoryRoot: status.repositoryRoot,
        stderr: output.stderr
      };
    } catch (error) {
      return {
        commits: [],
        cwd: resolvedCwd,
        isRepository: true,
        message: error instanceof Error ? error.message : 'Could not read git history.',
        repositoryRoot: status.repositoryRoot
      };
    }
  }

  return {
    commits: [],
    cwd: fallbackCwd,
    isRepository: false,
    message: request.repositoryFullName
      ? `No backend git repository was found for ${request.repositoryFullName}.`
      : 'No backend git repository was found.',
    repositoryRoot: fallbackCwd
  };
}

export async function stageGitPaths(request: GitStageRequest): Promise<GitActionResult> {
  const status = await getGitStatus(request.cwd);

  if (!status.isRepository) {
    return {
      message: 'Selected target is not a git repository.',
      status: 'error'
    };
  }

  const paths = request.paths.length > 0 ? request.paths : ['.'];
  try {
    const output = await git(['add', '--', ...paths], status.repositoryRoot);

    return {
      message: 'Staged changes.',
      status: 'success',
      stderr: output.stderr,
      stdout: output.stdout
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Stage failed.',
      status: 'error'
    };
  }
}

export async function unstageGitPaths(request: GitStageRequest): Promise<GitActionResult> {
  const status = await getGitStatus(request.cwd);

  if (!status.isRepository) {
    return {
      message: 'Selected target is not a git repository.',
      status: 'error'
    };
  }

  const paths = request.paths.length > 0 ? request.paths : ['.'];
  try {
    const output = await git(['restore', '--staged', '--', ...paths], status.repositoryRoot);

    return {
      message: 'Unstaged changes.',
      status: 'success',
      stderr: output.stderr,
      stdout: output.stdout
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Unstage failed.',
      status: 'error'
    };
  }
}

export async function commitGitChanges(request: GitCommitRequest): Promise<GitActionResult> {
  const status = await getGitStatus(request.cwd);
  const message = request.message.trim();

  if (!status.isRepository) {
    return {
      message: 'Selected target is not a git repository.',
      status: 'error'
    };
  }

  if (!message) {
    return {
      message: 'Commit message is required.',
      status: 'error'
    };
  }

  try {
    const output = await git(['commit', '-m', message], status.repositoryRoot);

    return {
      message: 'Committed staged changes.',
      status: 'success',
      stderr: output.stderr,
      stdout: output.stdout
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : 'Commit failed.',
      status: 'error'
    };
  }
}
