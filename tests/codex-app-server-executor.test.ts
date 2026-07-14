import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  createCodexSessionsWireRequest,
  type CodexSessionsConnectorOperation
} from '../server/codex-sessions-connector-contract';
import {
  CodexSessionsConnectorExecutor,
  CodexSessionsExecutorError
} from '../server/codex-sessions/connector-executor';
import type {
  CodexApprovalResponseInput,
  CodexInterruptTurnInput,
  CodexPermissionResponseInput,
  CodexResumeThreadInput,
  CodexSessionEvent,
  CodexSessionEventListener,
  CodexStartTurnInput,
  CodexThreadListInput,
  CodexUserInputResponseInput
} from '../server/codex-sessions/contracts';
import {
  CodexThreadActiveError,
  type CodexSessionManager
} from '../server/codex-sessions';
import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionReadRequest,
  CodexSessionUserInputResponse
} from '../src/shared/codex-sessions-api';

const keys = generateKeyPairSync('ed25519');
const now = 1_720_000_000_000;
const machineId = 'machine-one';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

class FakeSessionManager {
  readonly calls: Array<{ input?: unknown; method: string }> = [];
  private readonly listeners = new Set<CodexSessionEventListener>();
  active = false;
  clock: () => number = () => now;
  loadedIds = [threadId];
  paginated = false;

  subscribe(listener: CodexSessionEventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CodexSessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async listThreads(input: CodexThreadListInput) {
    this.calls.push({ input, method: 'listThreads' });
    const archived = input.archived === true;
    const baseId = archived ? '019f5a78-3c4c-7082-bb45-5411be7d9b9b' : threadId;
    const pageTwo = this.paginated && Boolean(input.cursor);
    return {
      data: [{
        archived,
        cwd: '/Users/oli/projects/project-space',
        id: pageTwo ? `${baseId.slice(0, -1)}${archived ? 'd' : 'c'}` : baseId,
        model: 'gpt-5.4',
        name: archived ? 'Archived signing work' : '#149 · Integrate Codex sessions',
        status: { type: 'notLoaded' as const },
        updatedAt: 1_719_999_999
      }],
      nextCursor: this.paginated && !input.cursor ? `cursor-${archived ? 'archived' : 'active'}` : null
    };
  }

  async listLoadedThreads() {
    this.calls.push({ method: 'listLoadedThreads' });
    return { data: this.loadedIds };
  }

  async readThread(id: string, includeTurns: boolean) {
    this.calls.push({ input: { id, includeTurns }, method: 'readThread' });
    return {
      thread: {
        cwd: '/Users/oli/projects/project-space',
        id,
        name: 'Stored history',
        status: { type: 'notLoaded' as const },
        turns: [{
          id: 'turn-one',
          items: [
            { id: 'agent-one', text: `sk-proj-${'a'.repeat(24)}`, type: 'agentMessage' },
            { id: 'reason-one', summary: ['private chain'], type: 'reasoning' },
            {
              aggregatedOutput: `Authorization: Bearer ${'b'.repeat(24)}`,
              command: 'printenv',
              id: 'command-one',
              type: 'commandExecution'
            }
          ],
          status: 'completed'
        }],
        updatedAt: 1_719_999_999
      }
    };
  }

  async resumeThread(input: CodexResumeThreadInput) {
    this.calls.push({ input, method: 'resumeThread' });
    return { thread: { id: input.threadId, status: { type: this.active ? 'active' : 'idle' } } };
  }

  async startTurn(input: CodexStartTurnInput) {
    this.calls.push({ input, method: 'startTurn' });
    if (this.active) throw new CodexThreadActiveError('active');
    return { turn: { id: 'turn-started', status: 'inProgress' } };
  }

  async interruptTurn(input: CodexInterruptTurnInput) {
    this.calls.push({ input, method: 'interruptTurn' });
    return {};
  }

  async respondToApproval(input: CodexApprovalResponseInput) {
    this.calls.push({ input, method: 'respondToApproval' });
    return {};
  }

  async respondToPermissions(input: CodexPermissionResponseInput) {
    this.calls.push({ input, method: 'respondToPermissions' });
    return {};
  }

  async respondToUserInput(input: CodexUserInputResponseInput) {
    this.calls.push({ input, method: 'respondToUserInput' });
    return {};
  }
}

function createExecutor(manager = new FakeSessionManager(), generation: number | (() => number) = 4) {
  return {
    executor: new CodexSessionsConnectorExecutor({
      expectedGeneration: generation,
      expectedMachineId: machineId,
      machineName: 'os-macbook',
      manager: manager as unknown as CodexSessionManager,
      now: manager.clock,
      verificationKey: keys.publicKey
    }),
    manager
  };
}

function signed<Payload extends { machineId: string }>(
  operation: CodexSessionsConnectorOperation,
  payload: Payload,
  operationId = `operation-${operation}-one`
) {
  return createCodexSessionsWireRequest({
    generation: 4,
    operation,
    operationId,
    payload: payload as never,
    userId: 'user-owner'
  }, keys.privateKey, {
    nonce: `nonce-${operation}-${operationId}`,
    now
  });
}

describe('Codex connector executor', () => {
  test('verifies grants, rejects replay, and lists active, archived, and loaded sessions', async () => {
    const { executor, manager } = createExecutor();
    const request: CodexSessionListRequest = {
      includeArchived: true,
      machineId,
      search: 'Codex'
    };
    const wire = signed('list', request);
    const result = await executor.execute('list', wire);
    expect(result.operation).toBe('list');
    if (result.operation !== 'list') throw new Error('unexpected result');
    expect(result.result.sessions).toHaveLength(2);
    expect(result.result.sessions[0]).toMatchObject({
      loadedByProjectSpace: true,
      machineId,
      project: 'project-space',
      status: 'idle'
    });
    expect(result.result.sessions[1]?.status).toBe('archived');
    expect(manager.calls.filter((call) => call.method === 'listThreads')).toHaveLength(2);
    await expect(executor.execute('list', wire)).rejects.toMatchObject({ code: 'replayed' });
    executor.close();
  });

  test('paginates complete inventory while preserving the oldest acquisition time', async () => {
    const manager = new FakeSessionManager();
    manager.paginated = true;
    const clockValues = [now, now + 1_000, now + 13_000];
    manager.clock = () => clockValues.shift() ?? now + 13_000;
    const { executor } = createExecutor(manager);
    const request: CodexSessionListRequest = { includeArchived: true, machineId };
    const result = await executor.execute('list', signed('list', request, 'operation-list-pages'));
    if (result.operation !== 'list') throw new Error('unexpected result');
    expect(result.result.checkedAt).toBe(new Date(now + 1_000).toISOString());
    expect(result.result.publishedAt).toBe(new Date(now + 13_000).toISOString());
    expect(result.result.sessions).toHaveLength(4);
    expect(manager.calls.filter((call) => call.method === 'listThreads')).toHaveLength(4);
    expect(manager.calls.filter((call) => call.method === 'listThreads').every((call) => (
      (call.input as CodexThreadListInput).limit === 100
    ))).toBe(true);
    executor.close();
  });

  test('includes a process-loaded thread that is absent from stored lists', async () => {
    const manager = new FakeSessionManager();
    const loadedOnlyId = '019f5a78-3c4c-7082-bb45-5411be7d9b9e';
    manager.loadedIds = [threadId, loadedOnlyId];
    const { executor } = createExecutor(manager);
    const result = await executor.execute('list', signed('list', {
      includeArchived: false,
      machineId
    }, 'operation-list-loaded-only'));
    if (result.operation !== 'list') throw new Error('unexpected result');
    expect(result.result.sessions).toContainEqual(expect.objectContaining({
      id: loadedOnlyId,
      loadedByProjectSpace: true,
      machineId
    }));
    expect(manager.calls).toContainEqual({
      input: { id: loadedOnlyId, includeTurns: false },
      method: 'readThread'
    });
    executor.close();
  });

  test('does not silently truncate more than 200 process-loaded threads', async () => {
    const manager = new FakeSessionManager();
    manager.loadedIds = [
      threadId,
      ...Array.from({ length: 201 }, (_, index) => (
        `019f5a78-3c4c-7082-bb45-${(index + 1).toString(16).padStart(12, '0')}`
      ))
    ];
    const { executor } = createExecutor(manager);
    const result = await executor.execute('list', signed('list', {
      includeArchived: false,
      machineId
    }, 'operation-list-many-loaded'));
    if (result.operation !== 'list') throw new Error('unexpected result');
    expect(result.result.sessions).toHaveLength(202);
    expect(manager.calls.filter((call) => call.method === 'readThread')).toHaveLength(201);
    executor.close();
  });

  test('opens history read-only and strips secrets, command output, and reasoning', async () => {
    const { executor, manager } = createExecutor();
    const request: CodexSessionReadRequest = { machineId, threadId };
    const result = await executor.execute('read', signed('read', request));
    if (result.operation !== 'read') throw new Error('unexpected result');
    expect(result.result.openedReadOnly).toBe(true);
    expect(manager.calls.some((call) => call.method === 'resumeThread')).toBe(false);
    const serialized = JSON.stringify(result.result);
    expect(serialized).toContain('[Sensitive content redacted]');
    expect(serialized).not.toContain('private chain');
    expect(serialized).not.toContain('printenv');
    expect(serialized).not.toContain('Authorization');
    executor.close();
  });

  test('resumes then starts the same thread with stable derived operation ids', async () => {
    const { executor, manager } = createExecutor();
    const request: CodexSessionContinueRequest = {
      machineId,
      message: 'Continue this exact session',
      operationId: 'operation-continue-one',
      threadId
    };
    const result = await executor.execute('continue', signed('continue', request, request.operationId));
    if (result.operation !== 'continue') throw new Error('unexpected result');
    expect(result.result).toMatchObject({ status: 'accepted', threadId, turnId: 'turn-started' });
    const resume = manager.calls.find((call) => call.method === 'resumeThread')?.input as CodexResumeThreadInput;
    const start = manager.calls.find((call) => call.method === 'startTurn')?.input as CodexStartTurnInput;
    expect(resume.threadId).toBe(threadId);
    expect(start.threadId).toBe(threadId);
    expect(resume.operationId).toMatch(/^codex:resume:/);
    expect(start.operationId).toMatch(/^codex:turn:/);
    expect(start.operationId).not.toBe(resume.operationId);
    executor.close();
  });

  test('rejects continue while active and never starts another turn', async () => {
    const manager = new FakeSessionManager();
    manager.active = true;
    const { executor } = createExecutor(manager);
    const request: CodexSessionContinueRequest = {
      machineId,
      message: 'Must wait',
      operationId: 'operation-continue-active',
      threadId
    };
    const result = await executor.execute('continue', signed('continue', request, request.operationId));
    if (result.operation !== 'continue') throw new Error('unexpected result');
    expect(result.result.status).toBe('rejected');
    expect(manager.calls.filter((call) => call.method === 'startTurn')).toHaveLength(0);
    executor.close();
  });

  test('preserves numeric request identity and routes permission decisions explicitly', async () => {
    const { executor, manager } = createExecutor();
    const events: unknown[] = [];
    const stop = executor.stream(
      signed('stream', { machineId, threadId }),
      (event) => events.push(event)
    );
    manager.emit({
      kind: 'request',
      method: 'item/permissions/requestApproval',
      params: {
        permissions: { network: ['example.com'] },
        threadId,
        turnId: 'turn-one'
      },
      requestId: 70
    });
    expect(events[0]).toMatchObject({
      approvalId: 'permissions',
      canAllow: true,
      kind: 'permissions',
      permissionSummary: ['network: example.com'],
      requestId: 'n:70',
      turnId: 'turn-one',
      type: 'approval-requested'
    });
    manager.emit({
      kind: 'request',
      method: 'item/permissions/requestApproval',
      params: {
        permissions: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`scope${index}`, true])
        ),
        threadId,
        turnId: 'turn-one'
      },
      requestId: 71
    });
    expect(events[1]).toMatchObject({
      canAllow: false,
      kind: 'permissions',
      requestId: 'n:71'
    });

    const approval: CodexSessionApprovalRequest = {
      approvalId: 'permissions',
      decision: 'allow-once',
      machineId,
      operationId: 'operation-permission-one',
      requestId: 'n:70',
      threadId,
      turnId: 'turn-one'
    };
    await executor.execute('approval', signed('approval', approval, approval.operationId));
    const permission = manager.calls.find((call) => call.method === 'respondToPermissions')
      ?.input as CodexPermissionResponseInput;
    expect(permission).toMatchObject({
      grant: 'allRequested',
      requestId: 70,
      scope: 'turn'
    });
    expect(manager.calls.some((call) => call.method === 'respondToApproval')).toBe(false);

    const incompleteApproval: CodexSessionApprovalRequest = {
      approvalId: 'permissions',
      decision: 'allow-once',
      machineId,
      operationId: 'operation-permission-incomplete',
      requestId: 'n:71',
      threadId,
      turnId: 'turn-one'
    };
    const blocked = await executor.execute(
      'approval',
      signed('approval', incompleteApproval, incompleteApproval.operationId)
    );
    if (blocked.operation !== 'approval') throw new Error('unexpected result');
    expect(blocked.result.status).toBe('rejected');
    expect(manager.calls.filter((call) => call.method === 'respondToPermissions')).toHaveLength(1);
    const denied = await executor.execute('approval', signed('approval', {
      ...incompleteApproval,
      decision: 'deny',
      operationId: 'operation-permission-incomplete-deny'
    }, 'operation-permission-incomplete-deny'));
    if (denied.operation !== 'approval') throw new Error('unexpected result');
    expect(denied.result.status).toBe('completed');
    expect(manager.calls.filter((call) => call.method === 'respondToPermissions').at(-1)?.input)
      .toMatchObject({ grant: 'none', requestId: 71 });
    stop();
    executor.close();
  });

  test('maps user input atomically and does not expose reasoning or secret deltas', async () => {
    const { executor, manager } = createExecutor();
    const events: unknown[] = [];
    executor.stream(signed('stream', { machineId, threadId }), (event) => events.push(event));
    manager.emit({
      kind: 'request',
      method: 'item/tool/requestUserInput',
      params: {
        questions: [{ id: 'choice', options: [{ label: 'Continue' }], question: 'Proceed?' }],
        threadId,
        turnId: 'turn-one'
      },
      requestId: 'request-input'
    });
    manager.emit({
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: {
        delta: 'Bearer ',
        itemId: 'agent-one',
        threadId,
        turnId: 'turn-one'
      }
    });
    manager.emit({
      kind: 'notification',
      method: 'item/agentMessage/delta',
      params: {
        delta: 'c'.repeat(24),
        itemId: 'agent-one',
        threadId,
        turnId: 'turn-one'
      }
    });
    manager.emit({
      kind: 'notification',
      method: 'item/completed',
      params: {
        item: { id: 'reason-one', text: 'private reasoning', type: 'reasoning' },
        threadId,
        turnId: 'turn-one'
      }
    });
    expect(events[0]).toMatchObject({
      requestId: 's:request-input',
      turnId: 'turn-one',
      type: 'user-input-requested'
    });
    expect(JSON.stringify(events)).not.toContain(`Bearer ${'c'.repeat(24)}`);
    expect(JSON.stringify(events)).toContain('[Sensitive content redacted]');
    expect(JSON.stringify(events)).not.toContain('private reasoning');

    const input: CodexSessionUserInputResponse = {
      answers: [{ questionId: 'choice', value: 'Continue' }],
      machineId,
      operationId: 'operation-input-one',
      requestId: 's:request-input',
      threadId,
      turnId: 'turn-one'
    };
    await executor.execute('input', signed('input', input, input.operationId));
    expect(manager.calls.find((call) => call.method === 'respondToUserInput')?.input)
      .toMatchObject({
        answers: { choice: ['Continue'] },
        requestId: 'request-input',
        threadId,
        turnId: 'turn-one'
      });
    executor.close();
  });

  test('supports interrupt and rejects arbitrary unsigned payload fields', async () => {
    const { executor, manager } = createExecutor();
    const interrupt: CodexSessionInterruptRequest = {
      machineId,
      operationId: 'operation-interrupt-one',
      threadId,
      turnId: 'turn-one'
    };
    const result = await executor.execute(
      'interrupt',
      signed('interrupt', interrupt, interrupt.operationId)
    );
    if (result.operation !== 'interrupt') throw new Error('unexpected result');
    expect(result.result.status).toBe('accepted');
    expect(manager.calls.some((call) => call.method === 'interruptTurn')).toBe(true);

    const invalid = signed('list', { machineId }) as unknown as {
      grant: unknown;
      payload: Record<string, unknown>;
    };
    invalid.payload.shell = 'rm -rf /';
    await expect(executor.execute('list', invalid)).rejects.toBeInstanceOf(
      CodexSessionsExecutorError
    );
    executor.close();
  });
});
