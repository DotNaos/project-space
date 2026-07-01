import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import type { TerminalCommandRequest, TerminalCommandResult } from '../src/shared/project-space-api';

const execFileAsync = promisify(execFile);
const outputLimit = 40_000;
const commandTimeoutMs = 30_000;
const shellCandidates = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh'];

export async function runCommand(command: string, args: string[], cwd?: string) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
    windowsHide: true
  });

  return {
    stderr,
    stdout
  };
}

function trimOutput(output: string) {
  if (output.length <= outputLimit) {
    return output;
  }

  return `${output.slice(0, outputLimit)}\n\n[output trimmed]`;
}

function getCommandShell() {
  return shellCandidates.find((candidate) => existsSync(candidate)) ?? '/bin/sh';
}

export async function runTerminalCommand(
  request: TerminalCommandRequest
): Promise<TerminalCommandResult> {
  const startedAt = Date.now();
  const cwd = resolve(request.cwd);

  return new Promise((resolveCommand) => {
    const child = spawn(getCommandShell(), ['-lc', request.command], {
      cwd,
      env: process.env,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        stderr += `\nCommand timed out after ${commandTimeoutMs / 1000}s.`;
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

export async function runSshTerminalCommand({
  command,
  target
}: {
  command: string;
  target: string;
}): Promise<TerminalCommandResult> {
  const startedAt = Date.now();
  const displayCommand = `ssh ${target} ${command}`;

  return new Promise((resolveCommand) => {
    const child = spawn(
      'ssh',
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', target, command],
      {
        env: process.env,
        windowsHide: true
      }
    );
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        stderr += `\nCommand timed out after ${commandTimeoutMs / 1000}s.`;
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
        command: displayCommand,
        cwd: `ssh:${target}`,
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
        command: displayCommand,
        cwd: `ssh:${target}`,
        durationMs: Date.now() - startedAt,
        exitCode: 1,
        stderr: error.message,
        stdout: ''
      });
    });
  });
}
