import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CodexHostWorktree } from '../src/shared/codex-host-inventory-api';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);

interface ManagedWorktreeIdentity {
  issueNumber?: number;
  managed: boolean;
}

export function createLocalCodexHostWorktreeLoader(
  backend: Pick<ProjectSpaceBackend, 'loadProjectDiscovery' | 'loadProjectWorktrees'>,
  machineId: string,
  readIdentity: (path: string) => Promise<ManagedWorktreeIdentity> = readManagedWorktreeIdentity
) {
  return async function load(): Promise<CodexHostWorktree[]> {
    const discovery = await backend.loadProjectDiscovery();
    const projects = discovery.projects.filter((project) => (
      project.machineId === machineId && project.github?.fullName
    ));
    const catalogues = await Promise.all(projects.map(async (project) => ({
      project,
      worktrees: await backend.loadProjectWorktrees(project.rootPath, machineId)
    })));
    const candidates = catalogues.flatMap(({ project, worktrees }) => worktrees.flatMap((worktree) => (
      !worktree.isBase && worktree.kind === 'project-managed' && worktree.status === 'ready'
        ? [{ project, worktree }]
        : []
    )));
    const inspected = await Promise.all(candidates.map(async ({ project, worktree }) => ({
      identity: await readIdentity(worktree.path),
      project,
      worktree
    })));

    return inspected.flatMap(({ identity, project, worktree }) => (
      identity.managed
        ? [{
            ...(worktree.branchName ? { branch: worktree.branchName } : {}),
            ...(identity.issueNumber ? { issueNumber: identity.issueNumber } : {}),
            label: worktree.name,
            path: worktree.path,
            repository: project.github!.fullName,
            threadCount: 0
          }]
        : []
    ));
  };
}

async function readManagedWorktreeIdentity(path: string): Promise<ManagedWorktreeIdentity> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', path, 'config', '--worktree', '--get-regexp',
      '^project\\.(worktreeManaged|issueNumber)$'
    ], {
      maxBuffer: 16 * 1024,
      timeout: 5_000,
      windowsHide: true
    });
    let managed = false;
    let issueNumber: number | undefined;
    for (const line of stdout.split(/\r?\n/)) {
      const separator = line.indexOf(' ');
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (key === 'project.worktreemanaged') managed = value === 'true';
      if (key === 'project.issuenumber' && /^[1-9][0-9]*$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) issueNumber = parsed;
      }
    }
    return { ...(issueNumber ? { issueNumber } : {}), managed };
  } catch {
    return { managed: false };
  }
}
