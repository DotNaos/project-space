import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  acquireCodespaceAgentLock,
  classifyCodexLoginStatus,
  codespaceAgentCommands,
  codespaceAgentLockPath,
  codespaceAgentOperationId,
  codespaceAgentStatePath,
  codespaceAgentTmuxCommands,
  codespaceMachineName,
  parseCodespaceAgentStartResult,
  readCodespaceAgentState,
  sanitizeCodespaceAgentEnvironment,
  writeCodespaceAgentState,
  type CodespaceAgentState
} from '../server/codespace-agent-runner';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe('Codespace agent identity', () => {
  test('derives a stable operation ID from repository, issue, and sandbox', () => {
    const input = {
      issue: 456,
      repository: 'DotNaos/project-space',
      sandbox: 'probable-space-bassoon'
    };
    const first = codespaceAgentOperationId(input);
    expect(first).toBe(codespaceAgentOperationId(input));
    expect(first).toMatch(/^codespace:start:[a-f0-9]{32}$/);
    expect(codespaceAgentOperationId({ ...input, issue: 457 })).not.toBe(first);
    expect(codespaceAgentOperationId({ ...input, sandbox: 'another-codespace' })).not.toBe(first);
    expect(codespaceAgentOperationId({ ...input, repository: 'DotNaos/other' })).not.toBe(first);
  });

  test('keeps machine names valid and bounded', () => {
    expect(codespaceMachineName('friendly-space')).toBe('codespace-friendly-space');
    expect(codespaceMachineName(`${'x'.repeat(90)} / bad`)).toHaveLength(64);
    expect(codespaceMachineName('!!!')).toBe('codespace');
  });

  test('uses stable, sandbox-specific state and capacity lock paths', () => {
    const state = codespaceAgentStatePath({
      issue: 456,
      repository: 'DotNaos/project-space',
      sandbox: 'space-one',
      stateHome: '/state'
    });
    expect(state).toMatch(/^\/state\/project-space\/codespace-agent\/dotnaos--project-space-[a-f0-9]{12}\/456-[a-f0-9]{12}\.json$/);
    expect(
      codespaceAgentStatePath({
        issue: 456,
        repository: 'DotNaos/project-space',
        sandbox: 'space-two',
        stateHome: '/state'
      })
    ).not.toBe(state);
    expect(codespaceAgentLockPath({ sandbox: 'space-one', stateHome: '/state' })).toMatch(
      /^\/state\/project-space\/codespace-agent\/runner-[a-f0-9]{12}\.lock$/
    );
  });
});

describe('Codespace agent authentication guardrails', () => {
  test('accepts only an explicit ChatGPT login status', () => {
    expect(classifyCodexLoginStatus('Logged in using ChatGPT')).toBe('chatgpt');
    expect(classifyCodexLoginStatus('Logged in using an API key')).toBe('api-key');
    expect(classifyCodexLoginStatus('Not logged in')).toBe('signed-out');
    expect(classifyCodexLoginStatus('Authenticated')).toBe('unknown');
  });

  test('removes metered credentials without mutating the caller environment', () => {
    const source = {
      AZURE_OPENAI_API_KEY: 'azure-secret',
      CODEX_ACCESS_TOKEN: 'codex-token',
      CODEX_API_KEY: 'codex-key',
      GITHUB_TOKEN: 'github-token',
      OPENAI_API_KEY: 'openai-secret',
      PATH: '/usr/bin'
    };
    const sanitized = sanitizeCodespaceAgentEnvironment(source);
    expect(sanitized).toEqual({ GITHUB_TOKEN: 'github-token', PATH: '/usr/bin' });
    expect(source.OPENAI_API_KEY).toBe('openai-secret');
  });
});

describe('Codespace agent command and result contract', () => {
  const expected = {
    issue: 456,
    operationId: 'codespace:start:0123456789abcdef0123456789abcdef',
    repository: 'DotNaos/project-space',
    sandbox: 'friendly-space'
  };

  test('uses a foreground connector and replays the stable operation ID', () => {
    const commands = codespaceAgentCommands({
      issue: expected.issue,
      machineName: 'codespace-friendly-space',
      operationId: expected.operationId,
      repository: expected.repository
    });
    expect(commands.connect).toEqual([
      'project',
      'connect',
      '--connector-mode',
      'foreground',
      '--no-open',
      '--name',
      'codespace-friendly-space',
      '--json'
    ]);
    expect(commands.start).toEqual([
      'project',
      'codex',
      'start',
      '--issue',
      '456',
      '--repository',
      'DotNaos/project-space',
      '--here',
      '--operation-id',
      expected.operationId,
      '--format',
      'json'
    ]);
  });

  test('starts the runner in a stable detached tmux session', () => {
    const commands = codespaceAgentTmuxCommands({
      cwd: '/workspaces/project-space',
      issue: expected.issue,
      repository: expected.repository
    });
    expect(commands.sessionName).toBe('issue-456');
    expect(commands.exists).toEqual([
      'tmux',
      '-L',
      'project-space-agent',
      'has-session',
      '-t',
      '=issue-456'
    ]);
    expect(commands.start).toEqual([
      'tmux',
      '-L',
      'project-space-agent',
      'new-session',
      '-d',
      '-s',
      'issue-456',
      '-c',
      '/workspaces/project-space',
      'bun scripts/codespace-agent.ts --issue 456 --repository DotNaos/project-space'
    ]);
    expect(commands.attach).toEqual([
      'tmux',
      '-L',
      'project-space-agent',
      'attach-session',
      '-t',
      '=issue-456'
    ]);
  });

  test('parses and sanitizes a confirmed task identity', () => {
    const outcome = parseCodespaceAgentStartResult(
      `connector log\n${JSON.stringify(confirmedResult(expected.operationId))}\n`,
      expected,
      '2026-08-06T12:00:00.000Z'
    );
    expect(outcome.kind).toBe('confirmed');
    if (outcome.kind !== 'confirmed') throw new Error('expected a confirmed outcome');
    expect(outcome.state).toEqual(expectedState(expected.operationId));
    expect(JSON.stringify(outcome.state)).not.toContain('credential');
    expect(JSON.stringify(outcome.state)).not.toContain('token');
    expect(
      codespaceAgentCommands({
        issue: expected.issue,
        machineName: outcome.state.task.machineName,
        operationId: expected.operationId,
        repository: expected.repository,
        state: outcome.state
      }).inspect
    ).toEqual([
      'project',
      'codex',
      'read',
      '--machine-id',
      'machine-1',
      '--connector',
      'connector-1',
      '--thread',
      '019fd11c-aebb-7583-9668-04f8fffbe62b',
      '--last',
      '1',
      '--format',
      'json'
    ]);
  });

  test('parses pretty-printed multiline JSON output', () => {
    const outcome = parseCodespaceAgentStartResult(
      JSON.stringify(confirmedResult(expected.operationId), null, 2),
      expected
    );
    expect(outcome.kind).toBe('confirmed');
  });

  test('preserves blocked and uncertain outcomes for safe replay', () => {
    expect(
      parseCodespaceAgentStartResult(
        JSON.stringify({
          apiVersion: 1,
          message: 'Approve the connector.',
          operationId: expected.operationId,
          reason: 'approval_required',
          state: 'blocked'
        }),
        expected
      )
    ).toEqual({ kind: 'blocked', message: 'Approve the connector.', reason: 'approval_required' });
    expect(
      parseCodespaceAgentStartResult(
        JSON.stringify({
          apiVersion: 1,
          message: 'Reconcile the operation.',
          operationId: expected.operationId,
          reconcile: 'required',
          state: 'uncertain'
        }),
        expected
      )
    ).toEqual({ kind: 'uncertain', message: 'Reconcile the operation.' });
  });

  test('rejects a confirmation for a different task', () => {
    const result = confirmedResult(expected.operationId);
    result.task.repository.nameWithOwner = 'DotNaos/other';
    expect(() => parseCodespaceAgentStartResult(JSON.stringify(result), expected)).toThrow(
      'different issue or repository'
    );
  });
});

describe('Codespace agent durable state and capacity lock', () => {
  test('atomically round-trips non-secret task state', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'nested', 'state.json');
    const state = expectedState('codespace:start:0123456789abcdef0123456789abcdef');
    await writeCodespaceAgentState(path, state);
    expect(await readCodespaceAgentState(path)).toEqual(state);
    expect((await readFile(path, 'utf8')).endsWith('\n')).toBe(true);
  });

  test('rejects an active runner and releases only its own lock', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'runner.lock');
    const first = await acquireCodespaceAgentLock(path, {
      issue: 456,
      operationId: 'codespace:start:0123456789abcdef0123456789abcdef',
      pid: 4242,
      processAlive: () => true,
      repository: 'DotNaos/project-space',
      sandbox: 'space-one',
      token: 'first-token'
    });
    await expect(
      acquireCodespaceAgentLock(path, {
        issue: 457,
        operationId: 'codespace:start:fedcba9876543210fedcba9876543210',
        pid: 4343,
        processAlive: () => true,
        repository: 'DotNaos/project-space',
        sandbox: 'space-one',
        token: 'second-token'
      })
    ).rejects.toThrow('already active');
    await first.release();
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('recovers dead and invalid stale locks', async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, 'runner.lock');
    const stale = await acquireCodespaceAgentLock(path, {
      issue: 456,
      operationId: 'codespace:start:0123456789abcdef0123456789abcdef',
      pid: 4242,
      processAlive: () => false,
      repository: 'DotNaos/project-space',
      sandbox: 'space-one',
      token: 'stale-token'
    });
    const replacement = await acquireCodespaceAgentLock(path, {
      issue: 457,
      operationId: 'codespace:start:fedcba9876543210fedcba9876543210',
      pid: 4343,
      processAlive: () => false,
      repository: 'DotNaos/project-space',
      sandbox: 'space-one',
      token: 'replacement-token'
    });
    await stale.release();
    expect(await readFile(path, 'utf8')).toContain('replacement-token');
    await replacement.release();

    await writeFile(path, 'not json\n', { mode: 0o600 });
    const recovered = await acquireCodespaceAgentLock(path, {
      issue: 458,
      operationId: 'codespace:start:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      pid: 4444,
      processAlive: () => false,
      repository: 'DotNaos/project-space',
      sandbox: 'space-one',
      token: 'recovered-token'
    });
    expect(await readFile(path, 'utf8')).toContain('recovered-token');
    await recovered.release();
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'project-space-codespace-agent-'));
  temporaryDirectories.push(directory);
  return directory;
}

function confirmedResult(operationId: string) {
  return {
    apiVersion: 1,
    operationId,
    state: 'confirmed',
    task: {
      canonicalTaskUrl: 'https://projects.os-home.net/codex/task-one',
      connector: {
        environment: 'codespace',
        generation: 1,
        id: 'connector-1',
        name: 'Codespace connector'
      },
      issue: { number: 456, url: 'https://github.com/DotNaos/project-space/issues/456' },
      physicalMachine: { id: 'machine-1', name: 'codespace-friendly-space' },
      repository: { id: 'repository-1', nameWithOwner: 'DotNaos/project-space' },
      threadId: '019fd11c-aebb-7583-9668-04f8fffbe62b',
      worktree: { branch: 'issue-456-first-vertical-slice', id: 'worktree-1' }
    }
  };
}

function expectedState(operationId: string): CodespaceAgentState {
  return {
    createdAt: '2026-08-06T12:00:00.000Z',
    issue: 456,
    operationId,
    repository: 'DotNaos/project-space',
    sandbox: 'friendly-space',
    task: {
      branch: 'issue-456-first-vertical-slice',
      canonicalTaskUrl: 'https://projects.os-home.net/codex/task-one',
      connectorId: 'connector-1',
      connectorName: 'Codespace connector',
      issueUrl: 'https://github.com/DotNaos/project-space/issues/456',
      machineId: 'machine-1',
      machineName: 'codespace-friendly-space',
      threadId: '019fd11c-aebb-7583-9668-04f8fffbe62b',
      worktreeId: 'worktree-1'
    },
    version: 1
  };
}
