import { createHash, generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import type { ConnectorWorktreeActionResult } from '../server/connector-worktree-action-contract';
import { createConnectorWorktreeActionWireRequest } from '../server/connector-worktree-action-routing';
import { createProjectConnectorActionControls } from '../server/project-connector-action-controls';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';
import type {
  WorkspaceCommandConnectorRequest,
  WorkspaceCommandConnectorResult
} from '../server/workspace-command/connector-contract';
import { createWorkspaceCommandWireRequest } from '../server/workspace-command/connector-routing';

const now = Date.now();
const ids = {
  command: '11111111-1111-4111-8111-111111111111',
  environment: '22222222-2222-4222-8222-222222222222',
  execution: '33333333-3333-4333-8333-333333333333',
  workspace: '44444444-4444-4444-8444-444444444444'
};

function workspaceStartRequest(): WorkspaceCommandConnectorRequest {
  const command = 'printf ok';
  return {
    allowNetwork: false,
    command,
    commandId: ids.command,
    commandSha256: createHash('sha256').update(command).digest('hex'),
    environmentId: ids.environment,
    executionId: ids.execution,
    expectedHeadSha: 'a'.repeat(40),
    machineId: 'machine-1',
    maxOutputBytes: 4_096,
    operation: 'start',
    projectId: 'github:480',
    repositoryWritable: false,
    timeoutSeconds: 30,
    workspaceId: ids.workspace,
    workspaceWritable: false,
    worktreeId: 'wt_aaaaaaaaaaaaaaaaaaaaaaaa'
  };
}

describe('project connector action maintenance blockers', () => {
  test('counts running worktree and workspace mutations, then returns to idle', async () => {
    const keys = generateKeyPairSync('ed25519');
    const maintenanceAdmission = new ConnectorRuntimeMaintenanceAdmission();
    let finishWorktree!: (result: ConnectorWorktreeActionResult) => void;
    let finishWorkspace!: (result: WorkspaceCommandConnectorResult) => void;
    const worktreeResult = new Promise<ConnectorWorktreeActionResult>((resolve) => {
      finishWorktree = resolve;
    });
    const workspaceResult = new Promise<WorkspaceCommandConnectorResult>((resolve) => {
      finishWorkspace = resolve;
    });
    const controls = createProjectConnectorActionControls({
      backend: { async runWorktreeAction() { return worktreeResult; } },
      maintenanceAdmission,
      machineId: 'machine-1',
      verificationKey: keys.publicKey,
      workspaceAdapter: { async execute() { return workspaceResult; } }
    });
    const worktreeRequest = {
      branchName: 'feature/quiescence',
      commitSha: 'b'.repeat(40),
      machineId: 'machine-1',
      operation: 'materialize' as const,
      projectId: 'project-1',
      repositoryFullName: 'owner/repository'
    };
    const worktreeWire = createConnectorWorktreeActionWireRequest(
      'materialize', worktreeRequest, { generation: 7, userId: 'user-1' }, keys.privateKey,
      { nonce: 'worktree-mutation-nonce', now }
    );
    const workspaceRequest = workspaceStartRequest();
    const workspaceWire = createWorkspaceCommandWireRequest(
      'start', workspaceRequest, { generation: 7, userId: 'user-1' }, keys.privateKey,
      { nonce: 'workspace-mutation-nonce', now }
    );

    expect(controls.maintenanceBlockers()).toEqual([]);
    expect(controls.handle({
      id: 'worktree-command', payload: worktreeWire, type: 'worktree.action'
    })).toBe(true);
    expect(controls.handle({
      id: 'workspace-command', payload: workspaceWire, type: 'workspace.command'
    })).toBe(true);
    expect(controls.maintenanceBlockers()).toEqual([
      { count: 1, kind: 'connector-mutation', scope: 'worktree' },
      { count: 1, kind: 'connector-mutation', scope: 'workspace' }
    ]);
    const blockedMaintenance = createConnectorRuntimeMaintenanceSafetyCheck(
      maintenanceAdmission, controls
    )();
    expect(blockedMaintenance.certainty).toBe('known');
    expect(blockedMaintenance.certainty === 'known' && blockedMaintenance.blockers)
      .toEqual(expect.arrayContaining([
        { count: 1, kind: 'connector-activity', scope: 'worktree' },
        { count: 1, kind: 'connector-activity', scope: 'workspace' }
      ]));

    finishWorktree({
      branchName: worktreeRequest.branchName,
      checkedAt: new Date(now).toISOString(),
      commitSha: worktreeRequest.commitSha,
      generation: 7,
      machineId: worktreeRequest.machineId,
      operation: 'materialize',
      projectId: worktreeRequest.projectId,
      state: 'ready'
    });
    finishWorkspace({
      checkedAt: new Date(now).toISOString(),
      commandId: workspaceRequest.commandId,
      environmentId: workspaceRequest.environmentId,
      executionId: workspaceRequest.executionId,
      generation: 7,
      machineId: workspaceRequest.machineId,
      operation: 'start',
      state: 'completed',
      stderr: '',
      stdout: 'ok',
      truncated: false,
      workspaceId: workspaceRequest.workspaceId
    });
    await Bun.sleep(0);
    expect(controls.maintenanceBlockers()).toEqual([]);
  });

  test('maintenance admission rejects a new mutation before its adapter runs', async () => {
    const keys = generateKeyPairSync('ed25519');
    const maintenanceAdmission = new ConnectorRuntimeMaintenanceAdmission();
    let workspaceCalls = 0;
    let worktreeCalls = 0;
    const result: ConnectorWorktreeActionResult = {
      branchName: 'feature/maintenance-first',
      checkedAt: new Date(now).toISOString(),
      commitSha: 'c'.repeat(40),
      generation: 7,
      machineId: 'machine-1',
      operation: 'materialize',
      projectId: 'project-1',
      state: 'ready'
    };
    const controls = createProjectConnectorActionControls({
      backend: {
        async runWorktreeAction() {
          worktreeCalls += 1;
          return result;
        }
      },
      maintenanceAdmission,
      machineId: 'machine-1',
      verificationKey: keys.publicKey,
      workspaceAdapter: {
        async execute() {
          workspaceCalls += 1;
          throw new Error('Workspace adapter must not run during maintenance.');
        }
      }
    });
    const request = {
      branchName: result.branchName,
      commitSha: result.commitSha,
      machineId: result.machineId,
      operation: 'materialize' as const,
      projectId: result.projectId,
      repositoryFullName: 'owner/repository'
    };
    const wire = createConnectorWorktreeActionWireRequest(
      'materialize', request, { generation: 7, userId: 'user-1' }, keys.privateKey,
      { nonce: 'maintenance-first-nonce', now }
    );
    const workspaceRequest = workspaceStartRequest();
    const workspaceWire = createWorkspaceCommandWireRequest(
      'start', workspaceRequest, { generation: 7, userId: 'user-1' }, keys.privateKey,
      { nonce: 'workspace-maintenance-first', now }
    );
    const maintenance = createConnectorRuntimeMaintenanceSafetyCheck(
      maintenanceAdmission, controls
    )();
    const closes: Array<{ code?: number; reason?: string }> = [];
    const sent: string[] = [];
    const socket = {
      close(code?: number, reason?: string) { closes.push({ code, reason }); },
      readyState: WebSocket.OPEN,
      send(value: string) { sent.push(value); }
    } as unknown as WebSocket;

    controls.handle({ id: 'blocked-worktree', payload: wire, type: 'worktree.action' }, socket);
    controls.handle({
      id: 'blocked-workspace', payload: workspaceWire, type: 'workspace.command'
    }, socket);
    await Bun.sleep(0);
    expect(worktreeCalls).toBe(0);
    expect(workspaceCalls).toBe(0);
    expect(closes).toEqual([]);
    expect(sent.map((value) => JSON.parse(value))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'blocked-worktree',
        payload: expect.objectContaining({
          lastError: 'Connector runtime maintenance is in progress.',
          state: 'error'
        }),
        type: 'worktree.action.result'
      }),
      expect.objectContaining({
        id: 'blocked-workspace',
        payload: expect.objectContaining({
          state: 'failed', stderr: 'Connector runtime maintenance is in progress.'
        }),
        type: 'workspace.command.result'
      })
    ]));
    if (maintenance.certainty === 'known') maintenance.lease?.release();

    const retryWire = createConnectorWorktreeActionWireRequest(
      'materialize', request, { generation: 7, userId: 'user-1' }, keys.privateKey,
      { nonce: 'maintenance-finished-nonce', now }
    );
    controls.handle({ id: 'allowed-worktree', payload: retryWire, type: 'worktree.action' });
    await Bun.sleep(0);
    expect(worktreeCalls).toBe(1);
  });
});
