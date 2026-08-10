import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { GitHubCodespaceRunnerRuntime } from '../github-codespace-runner/configured-runtime';
import { resolveOAuthToken } from '../local-github-catalog';
import type { EnvironmentLifecycleStore } from '../execution-environment-lifecycle/contracts';
import type { WorkspaceCommandConnectorResult } from './connector-contract';
import type { StoredWorkspaceCommand } from './contracts';
import type { WorkspaceCommandRecoveryProvider } from './service';

interface RecoveryExecution {
  cancel(): void;
  commandSha256: string;
  result: WorkspaceCommandConnectorResult;
}

const secret = /(?:bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/gi;
const privatePath = /(?:\/(?:Users|home|root|private|opt\/platform)\/[^\s:'"`]+|[A-Za-z]:\\Users\\[^\s:'"`]+)/g;

export function createGitHubCodespaceRecoveryProvider(options: {
  lifecycle: EnvironmentLifecycleStore;
  runner: GitHubCodespaceRunnerRuntime;
  resolveToken?: typeof resolveOAuthToken;
  spawnProcess?: typeof spawn;
}): WorkspaceCommandRecoveryProvider {
  const executions = new Map<string, RecoveryExecution>();
  const token = options.resolveToken ?? resolveOAuthToken;
  const spawnProcess = options.spawnProcess ?? spawn;

  function missing(command: StoredWorkspaceCommand, operation: 'cancel' | 'status') {
    return result(command, operation, 'uncertain', {
      stderr: 'The recovery process is no longer observable.'
    });
  }

  return {
    async resolve(input) {
      const binding = await options.lifecycle.readBindingByEnvironment(
        input.userId, input.environmentId
      );
      if (!binding || binding.providerKind !== 'github_codespaces')
        return { providerResourceId: '', state: 'unsupported' };
      const status = await options.runner.run({
        action: 'status', branch: binding.branch, issue: binding.task,
        operationId: `recovery-status:${createHash('sha256').update(input.operationId).digest('hex').slice(0, 24)}`,
        repositoryFullName: binding.repositoryFullName
      });
      const name = status.codespace?.name;
      const native = status.codespace?.state?.toLowerCase();
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(name) || native !== 'available')
        return { providerResourceId: '', state: 'unsupported' };
      if (binding.providerResourceId !== name)
        return { providerResourceId: '', state: 'unsupported' };
      return { providerResourceId: name, state: 'ready' };
    },

    async start(command, rawCommand) {
      if (command.scope !== 'environment_recovery') throw new Error('Recovery target is invalid.');
      const existing = executions.get(command.commandId);
      if (existing) {
        if (existing.commandSha256 !== command.commandSha256)
          throw new Error('Recovery command identity changed.');
        return { ...existing.result, operation: 'start' };
      }
      const cutoff = Date.now() - 24 * 60 * 60_000;
      for (const [id, value] of executions) {
        if (value.result.finishedAt && Date.parse(value.result.finishedAt) < cutoff) executions.delete(id);
      }
      if (executions.size >= 256)
        return result(command, 'start', 'unsupported', {
          stderr: 'The provider recovery command limit is reached.'
        });
      const auth = await token();
      if (!auth || (auth.source === 'stored-oauth' &&
          !(auth.scope ?? '').split(/[ ,]+/).includes('codespace')))
        return result(command, 'start', 'unsupported', {
          stderr: 'GitHub Codespaces authorization is required.'
        });
      const startedAt = new Date().toISOString();
      const child = spawnProcess('gh', [
        'codespace', 'ssh', '-c', command.providerResourceId, '--', '/bin/sh', '-s'
      ], {
        detached: process.platform !== 'win32',
        env: {
          GH_TOKEN: auth.token,
          HOME: process.env.HOME,
          LANG: process.env.LANG ?? 'C.UTF-8',
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          TERM: 'dumb'
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
      child.stdin?.end(rawCommand);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const output = { bytes: 0, truncated: false };
      child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk, output, command.maxOutputBytes));
      child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk, output, command.maxOutputBytes));
      const running: RecoveryExecution = {
        cancel: () => terminate(child), commandSha256: command.commandSha256,
        result: result(command, 'start', 'running', { startedAt })
      };
      executions.set(command.commandId, running);
      const timer = setTimeout(() => terminate(child), command.timeoutSeconds * 1_000);
      timer.unref();
      let cancelled = false;
      running.cancel = () => { cancelled = true; terminate(child); };
      child.once('error', (error) => {
        clearTimeout(timer);
        running.result = result(command, 'status', 'failed', {
          finishedAt: new Date().toISOString(), startedAt,
          stderr: sanitize(`${Buffer.concat(stderr).toString('utf8')}\n${error.message}`),
          stdout: sanitize(Buffer.concat(stdout).toString('utf8')), truncated: output.truncated
        });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        running.result = result(command, 'status', cancelled ? 'cancelled' : code === 0 ? 'completed' : 'failed', {
          exitCode: code ?? undefined, finishedAt: new Date().toISOString(), startedAt,
          stderr: sanitize(Buffer.concat(stderr).toString('utf8')),
          stdout: sanitize(Buffer.concat(stdout).toString('utf8')), truncated: output.truncated
        });
      });
      return running.result;
    },

    async status(command) {
      const execution = executions.get(command.commandId);
      return execution ? { ...execution.result, checkedAt: new Date().toISOString(), operation: 'status' }
        : missing(command, 'status');
    },

    async cancel(command) {
      const execution = executions.get(command.commandId);
      if (!execution) return missing(command, 'cancel');
      execution.cancel();
      return { ...execution.result, checkedAt: new Date().toISOString(), operation: 'cancel' };
    }
  };
}

function result(
  command: StoredWorkspaceCommand,
  operation: 'cancel' | 'start' | 'status',
  state: WorkspaceCommandConnectorResult['state'],
  detail: Partial<WorkspaceCommandConnectorResult> = {}
): WorkspaceCommandConnectorResult {
  return {
    checkedAt: new Date().toISOString(), commandId: command.commandId,
    environmentId: command.environmentId, executionId: command.commandId,
    generation: 1, machineId: 'github-codespaces', operation, state,
    stderr: '', stdout: '', truncated: false, workspaceId: command.commandId, ...detail
  };
}

function append(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }, max: number) {
  const remaining = Math.max(0, max - state.bytes);
  if (remaining === 0) { state.truncated = true; return; }
  const selected = chunk.subarray(0, remaining);
  chunks.push(selected);
  state.bytes += selected.byteLength;
  if (selected.byteLength < chunk.byteLength) state.truncated = true;
}
function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  setTimeout(() => {
    if (!child.pid || child.exitCode !== null) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, 500).unref();
}
function sanitize(value: string) {
  return value.replace(secret, '[redacted]').replace(privatePath, '[path]')
    .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
