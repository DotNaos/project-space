import { describe, expect, test } from 'bun:test';
import type {
  CodexSessionApprovalRequest,
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionListRequest,
  CodexSessionListResult,
  CodexSessionOperationResult,
  CodexSessionReadRequest,
  CodexSessionReadResult,
  CodexSessionsClient,
  CodexSessionStreamEvent,
  CodexSessionUserInputResponse
} from '../src/shared/codex-sessions-api';
import {
  CodexSessionsController,
  CodexSessionsControllerError
} from '../src/features/codex-sessions/codex-sessions-controller';

const origin = { machineId: 'machine-mac', threadId: '019f5a78-3c4c-7082-bb45-5411be7d9b9a' };

function listResult(machineId = origin.machineId, online = true): CodexSessionListResult {
  return {
    checkedAt: '2026-07-13T09:00:00.000Z',
    machine: { id: machineId, name: machineId === origin.machineId ? 'os-macbook' : 'os-pc', online },
    sessions: machineId === origin.machineId ? [{
      archived: false,
      cwd: '/Users/oli/projects/project-space',
      id: origin.threadId,
      lastActivityAt: '2026-07-13T08:59:00.000Z',
      loadedByProjectSpace: true,
      machineId,
      machineName: 'os-macbook',
      model: 'gpt-5',
      project: 'project-space',
      status: 'idle',
      title: '#149 · Integrate Codex sessions'
    }] : []
  };
}

function readResult(
  status: CodexSessionReadResult['session']['status'] = 'idle'
): CodexSessionReadResult {
  const record = listResult().sessions[0];
  return {
    openedReadOnly: true,
    session: { ...record, status },
    turns: [{
      id: 'turn-1',
      items: [
        { id: 'user-1', kind: 'user-message', status: 'completed', text: 'Original request' },
        { id: 'assistant-1', kind: 'agent-message', status: 'completed', text: 'Stored answer' }
      ],
      status: status === 'active' ? 'in-progress' : 'completed'
    }]
  };
}

function accepted(operationId: string): CodexSessionOperationResult {
  return { operationId, replayed: false, status: 'accepted', threadId: origin.threadId, turnId: 'turn-2' };
}

interface FakeCalls {
  approvals: CodexSessionApprovalRequest[];
  continues: CodexSessionContinueRequest[];
  inputs: CodexSessionUserInputResponse[];
  interrupts: CodexSessionInterruptRequest[];
  lists: CodexSessionListRequest[];
  reads: CodexSessionReadRequest[];
  subscriptions: CodexSessionReadRequest[];
}

function fakeClient(options: {
  continueImplementation?(request: CodexSessionContinueRequest): Promise<CodexSessionOperationResult>;
  readImplementation?(request: CodexSessionReadRequest): Promise<CodexSessionReadResult>;
} = {}) {
  const calls: FakeCalls = {
    approvals: [], continues: [], inputs: [], interrupts: [], lists: [], reads: [], subscriptions: []
  };
  let onEvent: ((event: CodexSessionStreamEvent) => void) | undefined;
  const client: CodexSessionsClient = {
    async approve(request) {
      calls.approvals.push(request);
      return accepted(request.operationId);
    },
    async continue(request) {
      calls.continues.push(request);
      return options.continueImplementation?.(request) ?? accepted(request.operationId);
    },
    async interrupt(request) {
      calls.interrupts.push(request);
      return accepted(request.operationId);
    },
    async list(request) {
      calls.lists.push(request);
      return listResult(request.machineId, request.machineId === origin.machineId);
    },
    async read(request) {
      calls.reads.push(request);
      return options.readImplementation?.(request) ?? readResult();
    },
    async respondToUserInput(request) {
      calls.inputs.push(request);
      return accepted(request.operationId);
    },
    subscribe(request, handler) {
      calls.subscriptions.push(request);
      onEvent = handler;
      return () => { onEvent = undefined; };
    }
  };
  return { calls, client, event: (event: CodexSessionStreamEvent) => onEvent?.(event) };
}

function operationIds() {
  let sequence = 0;
  return (action: string) => `codex-ui:${action}:test-${String(++sequence).padStart(4, '0')}`;
}

describe('Codex sessions UI controller', () => {
  test('aggregates machine lists and opens selected history without any mutation', async () => {
    const fake = fakeClient();
    const controller = new CodexSessionsController(fake.client, operationIds());

    await controller.loadMachines(['machine-mac', 'machine-pc']);
    await controller.select(origin);

    const state = controller.getState();
    expect(state.machines.map((machine) => [machine.name, machine.status])).toEqual([
      ['os-macbook', 'connected'],
      ['os-pc', 'offline']
    ]);
    expect(state.selectedOrigin).toEqual(origin);
    expect(state.conversations[0].items).toEqual([
      expect.objectContaining({ role: 'user', text: 'Original request' }),
      expect.objectContaining({ role: 'assistant', text: 'Stored answer' })
    ]);
    expect(fake.calls.reads).toEqual([origin]);
    expect(fake.calls.continues).toHaveLength(0);
    expect(fake.calls.approvals).toHaveLength(0);
    expect(fake.calls.inputs).toHaveLength(0);
    expect(fake.calls.interrupts).toHaveLength(0);
  });

  test('merges streaming deltas once per event identifier', async () => {
    const fake = fakeClient();
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.loadMachines([origin.machineId]);
    await controller.select(origin);

    fake.event({ delta: 'Hello', eventId: 'event-1', itemId: 'live-answer', type: 'agent-message-delta' });
    fake.event({ delta: 'Hello', eventId: 'event-1', itemId: 'live-answer', type: 'agent-message-delta' });
    fake.event({ delta: ' world', eventId: 'event-2', itemId: 'live-answer', type: 'agent-message-delta' });

    expect(controller.getState().conversations[0].items).toContainEqual({
      id: 'live-answer',
      kind: 'message',
      role: 'assistant',
      streaming: true,
      text: 'Hello world'
    });
    expect(controller.getState().seenEventIds).toEqual(['event-1', 'event-2']);
  });

  test('rejects continuation locally while the selected thread is active', async () => {
    const fake = fakeClient({ readImplementation: async () => readResult('active') });
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.loadMachines([origin.machineId]);
    await controller.select(origin);

    expect(controller.continue(origin, 'Do not queue this')).rejects.toMatchObject({
      code: 'thread_not_idle',
      name: 'CodexSessionsControllerError'
    } satisfies Partial<CodexSessionsControllerError>);
    expect(fake.calls.continues).toHaveLength(0);
  });

  test('reuses the same operation identifier after an ambiguous network failure', async () => {
    let attempt = 0;
    const fake = fakeClient({
      continueImplementation: async (request) => {
        attempt += 1;
        if (attempt === 1) throw new Error('Connection closed before acknowledgement.');
        return accepted(request.operationId);
      }
    });
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.loadMachines([origin.machineId]);
    await controller.select(origin);

    await expect(controller.continue(origin, 'Continue safely')).rejects.toThrow('acknowledgement');
    await controller.continue(origin, 'Continue safely');

    expect(fake.calls.continues.map((request) => request.operationId)).toEqual([
      'codex-ui:continue:test-0001',
      'codex-ui:continue:test-0001'
    ]);
    expect(fake.calls.continues.every((request) => (
      request.machineId === origin.machineId && request.threadId === origin.threadId
    ))).toBe(true);
  });

  test('preserves approval and multi-question input decisions with the active turn', async () => {
    const fake = fakeClient({ readImplementation: async () => readResult('active') });
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.loadMachines([origin.machineId]);
    await controller.select(origin);

    fake.event({
      approvalId: 'approval-1',
      command: 'bun test',
      eventId: 'event-approval',
      itemId: 'command-1',
      kind: 'command',
      requestId: 'request-approval',
      turnId: 'turn-explicit-approval',
      type: 'approval-requested'
    });
    fake.event({
      eventId: 'event-input',
      questions: [
        { choices: [{ label: 'Wait', value: 'wait' }], id: 'behavior', prompt: 'How should it proceed?' },
        { choices: [{ label: 'Once', value: 'once' }], id: 'scope', prompt: 'For how long?' }
      ],
      requestId: 'request-input',
      turnId: 'turn-explicit-input',
      type: 'user-input-requested'
    });

    await controller.resolveApproval({ ...origin, decision: 'allow_once', requestId: 'request-approval' });
    await controller.resolveUserInput({
      ...origin,
      answers: [
        { questionId: 'behavior', value: 'wait' },
        { questionId: 'scope', value: 'once' }
      ],
      requestId: 'request-input'
    });

    expect(fake.calls.approvals[0]).toMatchObject({
      approvalId: 'approval-1',
      decision: 'allow-once',
      itemId: 'command-1',
      machineId: origin.machineId,
      requestId: 'request-approval',
      threadId: origin.threadId,
      turnId: 'turn-explicit-approval'
    });
    expect(fake.calls.inputs[0]).toMatchObject({
      answers: [
        { questionId: 'behavior', value: 'wait' },
        { questionId: 'scope', value: 'once' }
      ],
      machineId: origin.machineId,
      requestId: 'request-input',
      threadId: origin.threadId,
      turnId: 'turn-explicit-input'
    });
    expect(controller.getState().conversations[0].approvals).toEqual([]);
    expect(controller.getState().conversations[0].userInputRequests).toEqual([]);
  });

  test('marks a deep-linked thread missing when read returns not found', async () => {
    const notFound = Object.assign(new Error('The Codex thread no longer exists.'), {
      code: 'thread_not_found', status: 404
    });
    const fake = fakeClient({ readImplementation: async () => { throw notFound; } });
    const controller = new CodexSessionsController(fake.client, operationIds());

    await controller.select(origin);

    expect(controller.getState().sessions[0]).toMatchObject({
      machineId: origin.machineId,
      status: 'missing',
      threadId: origin.threadId
    });
    expect(controller.getState().errorMessage).toBe('The Codex thread no longer exists.');
  });

  test('does not reconnect an offline thread and clears selection on list navigation', async () => {
    const fake = fakeClient({ readImplementation: async () => readResult('offline') });
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.select(origin);

    expect(fake.calls.subscriptions).toHaveLength(0);
    controller.clearSelection();
    expect(controller.getState().selectedOrigin).toBeUndefined();
  });

  test('allows denial but blocks approval when permission details are incomplete', async () => {
    const fake = fakeClient({ readImplementation: async () => readResult('active') });
    const controller = new CodexSessionsController(fake.client, operationIds());
    await controller.loadMachines([origin.machineId]);
    await controller.select(origin);
    fake.event({
      approvalId: 'permissions',
      canAllow: false,
      eventId: 'event-permission-incomplete',
      kind: 'permissions',
      requestId: 'request-permission-incomplete',
      turnId: 'turn-permission-incomplete',
      type: 'approval-requested'
    });

    await expect(controller.resolveApproval({
      ...origin,
      decision: 'allow_once',
      requestId: 'request-permission-incomplete'
    })).rejects.toMatchObject({ code: 'permission_details_unavailable' });
    expect(fake.calls.approvals).toHaveLength(0);

    await controller.resolveApproval({
      ...origin,
      decision: 'deny',
      requestId: 'request-permission-incomplete'
    });
    expect(fake.calls.approvals[0]).toMatchObject({ decision: 'deny' });
  });
});
