import { resolve } from 'node:path';

import { runCommand } from './local-command-runner';
import type {
  GitActionResult,
  GitCommitRequest,
  GitDiffRequest,
  GitDiffResult,
  GitStageRequest,
  GitStatusEntry,
  GitStatusResult
} from '../src/shared/project-space-api';

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

async function git(args: string[], cwd: string) {
  return runCommand('git', args, cwd);
}

async function resolveGitRoot(cwd: string) {
  const output = await git(['rev-parse', '--show-toplevel'], cwd);

  return output.stdout.trim();
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
        staged: entries.filter((entry) => entry.indexStatus.trim()).length,
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
