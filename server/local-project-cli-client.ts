import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

function trimOutput(output: string) {
  if (output.length <= outputLimit) {
    return output;
  }

  return `${output.slice(0, outputLimit)}\n\n[output trimmed]`;
}

function projectBinary() {
  return existsSync(localProjectBin) ? localProjectBin : 'project';
}

function projectCliArgs(request: ProjectCliCommandRequest): string[] {
  switch (request.command) {
    case 'validate':
      return ['validate', '--format', 'pretty'];
    case 'module-list':
      return ['module', 'list'];
    case 'module-show':
      if (!request.moduleName) {
        throw new Error('moduleName is required for module-show.');
      }
      return ['module', 'show', request.moduleName];
    case 'template-sync':
      return ['template', 'sync', '--dry-run'];
    case 'template-update':
      return ['template', 'update', '--dry-run'];
    case 'deploy-status':
      return ['deploy', 'status'];
  }
}

export async function runProjectCliCommand(
  request: ProjectCliCommandRequest
): Promise<ProjectCliCommandResult> {
  const startedAt = Date.now();
  const cwd = resolve(request.cwd);
  const args = projectCliArgs(request);

  return new Promise((resolveCommand) => {
    const child = spawn(projectBinary(), args, {
      cwd,
      env: process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        stderr += `\nProject CLI command timed out after ${commandTimeoutMs / 1000}s.`;
        child.kill('SIGTERM');
      }
    }, commandTimeoutMs);

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
        args,
        command: request.command,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr: trimOutput(stderr),
        stdout: trimOutput(stdout)
      });
    });

    child.on('error', (error) => {
      finished = true;
      clearTimeout(timeout);
      resolveCommand({
        args,
        command: request.command,
        cwd,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stderr: error.message,
        stdout: ''
      });
    });
  });
}
