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
  CodexInterruptTurnInput,
  CodexSessionEventListener,
  CodexStartTurnInput
} from '../server/codex-sessions/contracts';
import type { CodexSessionManager } from '../server/codex-sessions/manager';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';
import type {
  CodexMachineTaskConnectorStartRequest,
  CodexMachineTaskConnectorStartResult
} from '../src/shared/codex-machine-tasks-api';
import type {
  CodexSessionContinueRequest,
  CodexSessionInterruptRequest,
  CodexSessionReadRequest,
  CodexSessionSettingsRequest
} from '../src/shared/codex-sessions-api';

const keys = generateKeyPairSync('ed25519');
const machineId = 'machine-admission';
const now = 1_720_000_000_000;
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

class AdmissionSessionManager {
  readonly calls: string[] = [];
  resumeBarrier?: Promise<void>;

  subscribe(_listener: CodexSessionEventListener) { return () => true; }

  operationSnapshot() { return []; }

  async resumeThread(input: { threadId: string }) {
    this.calls.push('resume');
    await this.resumeBarrier;
    return { thread: { id: input.threadId, status: { type: 'idle' as const } } };
  }

  async startTurn(_input: CodexStartTurnInput) {
    this.calls.push('start-turn');
    return { turn: { id: 'turn-started' } };
  }

  async readThread(id: string) {
    this.calls.push('read');
    return {
      thread: {
        cwd: '/tmp/project-space',
        id,
        name: 'Admission task',
        status: { type: 'notLoaded' as const },
        turns: []
      }
    };
  }

  async listLoadedThreads() { return { data: [] }; }

  async interruptTurn(_input: CodexInterruptTurnInput) {
    this.calls.push('interrupt');
    return {};
  }
}

function executor(
  manager: AdmissionSessionManager,
  maintenanceAdmission: ConnectorRuntimeMaintenanceAdmission,
  startTask?: (
    request: CodexMachineTaskConnectorStartRequest,
    context: { generation: number; userId: string }
  ) => Promise<CodexMachineTaskConnectorStartResult>
) {
  return new CodexSessionsConnectorExecutor({
    expectedGeneration: 4,
    expectedMachineId: machineId,
    machineName: machineId,
    maintenanceAdmission,
    manager: manager as unknown as CodexSessionManager,
    now: () => now,
    ...(startTask ? { startTask } : {}),
    verificationKey: keys.publicKey
  });
}

function signed<Payload extends { machineId: string }>(
  operation: CodexSessionsConnectorOperation,
  operationId: string,
  payload: Payload
) {
  return createCodexSessionsWireRequest({
    generation: 4,
    operation,
    operationId,
    payload: payload as never,
    userId: 'user-owner'
  }, keys.privateKey, { nonce: `nonce-${operationId}`, now });
}

function continueRequest(operationId: string): CodexSessionContinueRequest {
  return { machineId, message: 'Continue safely', operationId, threadId };
}

describe('Codex connector maintenance admission', () => {
  test('a local transport follow-up reserves activity before maintenance can enter', async () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const manager = new AdmissionSessionManager();
    let resume!: () => void;
    manager.resumeBarrier = new Promise<void>((resolve) => { resume = resolve; });
    const codex = executor(manager, admission);
    const local = codex.createLocalTransport(threadId);
    const request = continueRequest('local-continue-wins-race');
    const continuing = local.mutate({
      kind: 'continue', machineId, request, threadId, userId: 'user-owner'
    });
    await Bun.sleep(0);

    expect(createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers: () => []
    })()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex' }],
      certainty: 'known'
    });
    resume();
    await expect(continuing).resolves.toMatchObject({
      machineId, result: { status: 'accepted' }, threadId
    });
    codex.close();
  });

  test('admitted maintenance rejects local follow-ups and settings but permits interrupt', async () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const manager = new AdmissionSessionManager();
    const codex = executor(manager, admission);
    const local = codex.createLocalTransport(threadId);
    const maintenance = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers: () => []
    })();
    expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();

    const followUp = continueRequest('local-maintenance-first');
    await expect(local.mutate({
      kind: 'continue', machineId, request: followUp, threadId, userId: 'user-owner'
    })).rejects.toBeInstanceOf(CodexSessionsExecutorError);
    const settings: CodexSessionSettingsRequest = {
      machineId,
      operationId: 'local-settings-during-maintenance',
      permissionProfileId: 'workspace-write',
      threadId
    };
    await expect(local.mutate({
      kind: 'settings', machineId, request: settings, threadId, userId: 'user-owner'
    })).rejects.toBeInstanceOf(CodexSessionsExecutorError);
    expect(manager.calls).toEqual([]);

    const interrupt: CodexSessionInterruptRequest = {
      machineId,
      operationId: 'local-interrupt-during-maintenance',
      threadId,
      turnId: 'turn-one'
    };
    await expect(local.mutate({
      kind: 'interrupt', machineId, request: interrupt, threadId, userId: 'user-owner'
    })).resolves.toMatchObject({ result: { status: 'accepted' } });
    expect(manager.calls).toEqual(['interrupt']);

    if (maintenance.certainty === 'known') maintenance.lease?.release();
    codex.close();
  });

  test('a follow-up reserves activity before runtime maintenance can enter', async () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const manager = new AdmissionSessionManager();
    let resume!: () => void;
    manager.resumeBarrier = new Promise<void>((resolve) => { resume = resolve; });
    const codex = executor(manager, admission);
    const request = continueRequest('continue-wins-race');
    const continuing = codex.execute(
      'continue', signed('continue', request.operationId, request)
    );
    await Bun.sleep(0);

    const maintenance = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers: () => []
    })();
    expect(maintenance).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'codex' }],
      certainty: 'known'
    });
    resume();
    await expect(continuing).resolves.toMatchObject({
      operation: 'continue', result: { status: 'accepted' }
    });
    codex.close();
  });

  test('admitted maintenance rejects new sends but permits read and interrupt', async () => {
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const manager = new AdmissionSessionManager();
    let starts = 0;
    const codex = executor(manager, admission, async () => {
      starts += 1;
      return { state: 'confirmed', threadId, worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa' };
    });
    const inspect = createConnectorRuntimeMaintenanceSafetyCheck(admission, {
      maintenanceBlockers: () => []
    });
    const maintenance = inspect();
    expect(maintenance.certainty === 'known' && maintenance.lease).toBeDefined();

    const followUp = continueRequest('maintenance-wins-race');
    await expect(codex.execute(
      'continue', signed('continue', followUp.operationId, followUp)
    )).rejects.toBeInstanceOf(CodexSessionsExecutorError);
    expect(manager.calls).not.toContain('resume');
    const start: CodexMachineTaskConnectorStartRequest = {
      branch: 'issue-576-quiescence',
      commit: 'a'.repeat(40),
      initialPrompt: 'Implement issue 576',
      issueNumber: 576,
      issueUrl: 'https://github.com/DotNaos/project-space/issues/576',
      machineId,
      operationId: 'start-during-maintenance',
      physicalMachineId: machineId,
      projectId: 'project-1',
      repositoryId: 'repository-1',
      repositoryNameWithOwner: 'DotNaos/project-space'
    };
    await expect(codex.execute(
      'start', signed('start', start.operationId, start)
    )).rejects.toBeInstanceOf(CodexSessionsExecutorError);
    expect(starts).toBe(0);

    const read: CodexSessionReadRequest = { machineId, threadId };
    await expect(codex.execute(
      'read', signed('read', 'read-during-maintenance', read)
    )).resolves.toMatchObject({ operation: 'read' });
    const interrupt: CodexSessionInterruptRequest = {
      machineId, operationId: 'interrupt-during-maintenance', threadId, turnId: 'turn-one'
    };
    await expect(codex.execute(
      'interrupt', signed('interrupt', interrupt.operationId, interrupt)
    )).resolves.toMatchObject({ operation: 'interrupt', result: { status: 'accepted' } });
    expect(manager.calls).toContain('interrupt');

    if (maintenance.certainty === 'known') maintenance.lease?.release();
    const allowedStart = { ...start, operationId: 'start-after-maintenance' };
    await expect(codex.execute(
      'start', signed('start', allowedStart.operationId, allowedStart)
    )).resolves.toMatchObject({ operation: 'start', result: { state: 'confirmed' } });
    expect(starts).toBe(1);
    codex.close();
  });
});
