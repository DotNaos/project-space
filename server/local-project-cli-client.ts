import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  ProjectCliCommand,
  ProjectCliCommandRequest,
  ProjectCliCommandResult
} from '../src/shared/project-space-api';

const outputLimit = 80_000;
const commandTimeoutMs = 60_000;
const projectSpaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localProjectBin = resolve(projectSpaceRoot, 'bin', 'project');
let repositoryCommandTail = Promise.resolve();

interface ProjectBinaryResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  repositoryBinary?: string;
}

function isExecutable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trimOutput(output: string) {
  if (output.length <= outputLimit) {
    return output;
  }

  return `${output.slice(0, outputLimit)}\n\n[output trimmed]`;
}

export function projectBinary({
  environment = process.env,
  homeDirectory = homedir(),
  repositoryBinary = localProjectBin
}: ProjectBinaryResolutionOptions = {}) {
  const configuredPath = environment.PROJECT_CLI_PATH?.trim();
  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      throw new Error('PROJECT_CLI_PATH must be an absolute path.');
    }
    if (!isExecutable(configuredPath)) {
      throw new Error(`PROJECT_CLI_PATH is not executable: ${configuredPath}`);
    }
    return configuredPath;
  }

  if (existsSync(repositoryBinary) && isExecutable(repositoryBinary)) {
    return repositoryBinary;
  }

  const installedBinary = resolve(homeDirectory, '.local', 'bin', 'project');
  return isExecutable(installedBinary) ? installedBinary : 'project';
}

export interface ProjectBinaryRunResult {
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

export async function runProjectBinary(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number } = {}
): Promise<ProjectBinaryRunResult> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  let binary: string;
  try {
    binary = projectBinary();
  } catch (error) {
    return {
      durationMs: Date.now() - startedAt,
      exitCode: 1,
      stderr: error instanceof Error ? error.message : 'Could not resolve the Project CLI.',
      stdout: ''
    };
  }

  const execute = () => new Promise<ProjectBinaryRunResult>((resolveCommand) => {
    const child = spawn(binary, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        stderr += `\nProject CLI command timed out after ${timeoutMs / 1000}s.`;
        child.kill('SIGTERM');
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('close', (exitCode) => {
      finished = true;
      clearTimeout(timeout);
      resolveCommand({
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr,
        stdout
      });
    });

    child.on('error', (error) => {
      finished = true;
      clearTimeout(timeout);
      resolveCommand({
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stderr: error.message,
        stdout: ''
      });
    });
  });

  if (binary !== localProjectBin) {
    return execute();
  }

  // The repository wrapper compiles to one shared temporary path. Serialize
  // only that development fallback so parallel worktree inspection cannot
  // race multiple `go build -o` calls. Installed connector binaries remain
  // fully concurrent through PROJECT_CLI_PATH.
  const queued = repositoryCommandTail.then(execute, execute);
  repositoryCommandTail = queued.then(() => undefined, () => undefined);
  return queued;
}

export async function reconcileProjectServeSessions() {
  const result = await runProjectBinary(
    ['serve', 'reconcile', '--json'],
    homedir(),
    { timeoutMs: 90_000 }
  );

  if (result.exitCode !== 0) {
    console.warn(
      `Could not reconcile Project dev-server sessions: ${trimOutput(result.stderr).trim()}`
    );
  }

  return result;
}

function projectCliArgs(request: ProjectCliCommandRequest): string[] {
  switch (request.command) {
    case 'validate':
      return ['validate', '--format', 'pretty'];
    case 'template-init':
      return ['init'];
    case 'module-list':
      return ['module', 'list'];
    case 'module-show':
      if (!request.moduleName) {
        throw new Error('moduleName is required for module-show.');
      }
      return ['module', 'show', request.moduleName];
    case 'template-sync':
      return ['template', 'sync', '--dry-run'];
    case 'template-sync-apply':
      return ['template', 'sync'];
    case 'template-update':
      return ['template', 'update', '--dry-run'];
    case 'deploy-status':
      return ['deploy', 'status', '--all-envs', '--format', 'json'];
    case 'deploy-dry-run':
      if (!request.environment) {
        throw new Error('environment is required for deploy-dry-run.');
      }
      return ['deploy', '--env', request.environment, '--dry-run', '--format', 'json'];
  }
}

export async function runProjectCliCommand(
  request: ProjectCliCommandRequest
): Promise<ProjectCliCommandResult> {
  const cwd = resolve(request.cwd);
  const args = projectCliArgs(request);
  const result = await runProjectBinary(args, cwd);

  return {
    args,
    command: request.command,
    cwd,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stderr: trimOutput(result.stderr),
    stdout: trimOutput(result.stdout)
  };
}
