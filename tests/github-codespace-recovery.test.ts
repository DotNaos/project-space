import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import type { EnvironmentLifecycleStore } from '../server/execution-environment-lifecycle/contracts';
import { createGitHubCodespaceRecoveryProvider } from '../server/workspace-command/github-codespace-recovery';
import type { StoredWorkspaceCommand } from '../server/workspace-command/contracts';

const environmentId = '11111111-1111-4111-8111-111111111111';
const commandId = '22222222-2222-4222-8222-222222222222';

const command: StoredWorkspaceCommand = {
  auditId: '33333333-3333-4333-8333-333333333333', commandId,
  commandSha256: 'a'.repeat(64), createdAt: '2026-08-09T12:00:00.000Z',
  environmentId, maxOutputBytes: 4_096, outputCursor: 0, ownerUserId: 'user-1',
  providerKind: 'github_codespaces', providerResourceId: 'silver-space',
  scope: 'environment_recovery', state: 'queued', stderr: '', stdout: '',
  startOperationFingerprint: 'b'.repeat(64), startOperationId: 'recovery:start:001',
  timeoutSeconds: 30, truncated: false, updatedAt: '2026-08-09T12:00:00.000Z'
};

describe('GitHub Codespace recovery provider', () => {
  test('resolves through the shared runtime and executes only through gh Codespace SSH', async () => {
    let spawned: { args: readonly string[]; command: string; env: NodeJS.ProcessEnv } | undefined;
    let stdin = '';
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, {
      exitCode: null, pid: 12345,
      stderr: new PassThrough(), stdout: new PassThrough(),
      stdin: { end(value: string) { stdin = value; } }
    });
    const lifecycle = {
      readBindingByEnvironment: async (userId: string, id: string) =>
        userId === 'user-1' && id === environmentId ? {
          branch: 'issue-557', environmentId, id: 'binding-1', lifecycleState: 'running' as const,
          observedAt: new Date().toISOString(), providerKind: 'github_codespaces',
          providerResourceId: 'silver-space', repositoryFullName: 'DotNaos/project-space',
          task: 557, userId
        } : undefined
    } as unknown as EnvironmentLifecycleStore;
    const provider = createGitHubCodespaceRecoveryProvider({
      lifecycle,
      resolveToken: async () => ({
        scope: 'repo codespace', source: 'stored-oauth', token: 'not-exposed'
      }),
      runner: {
        async run(request) {
          expect(request).toMatchObject({ action: 'status', repositoryFullName: 'DotNaos/project-space' });
          return {
            apiVersion: 1, codespace: { name: 'silver-space', state: 'Available' },
            message: 'ready', operationId: request.operationId, state: 'ready'
          };
        }
      },
      spawnProcess: ((binary: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
        spawned = { args, command: binary, env: options.env ?? {} };
        return child;
      }) as typeof spawn
    });
    expect(await provider.resolve({
      environmentId, operationId: 'recovery:start:001', userId: 'user-1'
    })).toEqual({ providerResourceId: 'silver-space', state: 'ready' });
    const raw = 'sudo project doctor --repair';
    expect((await provider.start(command, raw)).state).toBe('running');
    expect(spawned?.command).toBe('gh');
    expect(spawned?.args).toEqual([
      'codespace', 'ssh', '-c', 'silver-space', '--', '/bin/sh', '-s'
    ]);
    expect(spawned?.args).not.toContain(raw);
    expect(stdin).toBe(raw);
    expect(Object.keys(spawned?.env ?? {}).sort()).toEqual(['GH_TOKEN', 'HOME', 'LANG', 'PATH', 'TERM']);
    (child.stdout as PassThrough).end('fixed\n');
    child.emit('close', 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await provider.status(command)).toMatchObject({ state: 'completed', stdout: 'fixed\n' });
  });

  test('fails closed when the owner binding or exact provider identity does not match', async () => {
    const lifecycle = {
      readBindingByEnvironment: async () => undefined
    } as unknown as EnvironmentLifecycleStore;
    const provider = createGitHubCodespaceRecoveryProvider({
      lifecycle,
      runner: { run: async () => { throw new Error('must not call GitHub'); } }
    });
    expect(await provider.resolve({
      environmentId, operationId: 'recovery:start:002', userId: 'other-user'
    })).toEqual({ providerResourceId: '', state: 'unsupported' });
    expect((await provider.status(command)).state).toBe('uncertain');
  });
});
