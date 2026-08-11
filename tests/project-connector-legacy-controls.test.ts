import { describe, expect, test } from 'bun:test';

import type { ConnectorMachineMessage } from '../server/connector-command-protocol';
import { createProjectConnectorLegacyControls } from '../server/project-connector-legacy-controls';
import {
  ConnectorRuntimeMaintenanceAdmission,
  createConnectorRuntimeMaintenanceSafetyCheck
} from '../server/connector-runtime-maintenance-safety';
import type { ProjectSpaceBackend } from '../src/shared/project-space-api';

class RecordingSocket {
  readonly messages: Array<Record<string, unknown>> = [];
  readyState = WebSocket.OPEN;
  send(value: string) { this.messages.push(JSON.parse(value)); }
}

function mutationMessages(): ConnectorMachineMessage[] {
  return [
    {
      id: 'chat',
      payload: { cwd: '/tmp', machineId: 'machine-1', messages: [], prompt: 'Work' },
      type: 'codex.chat'
    },
    {
      id: 'terminal', payload: { command: 'touch marker', machineId: 'machine-1' },
      type: 'terminal.run'
    },
    {
      id: 'create', payload: { machineId: 'machine-1', name: 'folder', parentPath: '/tmp' },
      type: 'filesystem.folder.create'
    },
    {
      id: 'rename', payload: { machineId: 'machine-1', name: 'renamed', path: '/tmp/folder' },
      type: 'filesystem.folder.rename'
    },
    {
      id: 'delete', payload: { machineId: 'machine-1', paths: ['/tmp/renamed'] },
      type: 'filesystem.folder.delete'
    },
    {
      id: 'project-cli', payload: { command: 'validate', cwd: '/tmp', machineId: 'machine-1' },
      type: 'project-cli.run'
    }
  ];
}

describe('project connector legacy mutation admission', () => {
  test('maintenance rejects every legacy mutation but leaves filesystem reads open', async () => {
    const calls: string[] = [];
    const backend = {
      async createMachineDirectory() { calls.push('create'); return { affectedPaths: [], status: 'success' }; },
      async deleteMachineDirectories() { calls.push('delete'); return { affectedPaths: [], status: 'success' }; },
      async getMachineFileSystemRoot() {
        calls.push('root');
        return { defaultPath: '/tmp', homePath: '/tmp', status: 'success' };
      },
      async renameMachineDirectory() { calls.push('rename'); return { affectedPaths: [], status: 'success' }; },
      async runMachineTerminalCommand() { calls.push('terminal'); throw new Error('not expected'); },
      async runProjectCliCommand() { calls.push('project-cli'); throw new Error('not expected'); },
      async streamCodexChat() { calls.push('chat'); }
    } as unknown as ProjectSpaceBackend;
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const maintenance = createConnectorRuntimeMaintenanceSafetyCheck(
      admission, { maintenanceBlockers: () => [] }
    )();
    const socket = new RecordingSocket();
    const controls = createProjectConnectorLegacyControls({
      backend,
      isCurrentConnection: () => true,
      maintenanceAdmission: admission,
      socket: socket as unknown as WebSocket
    });

    for (const message of mutationMessages()) expect(controls.handle(message)).toBe(true);
    expect(controls.handle({
      id: 'root', payload: { machineId: 'machine-1' }, type: 'filesystem.root'
    })).toBe(true);
    await Bun.sleep(0);

    expect(calls).toEqual(['root']);
    expect(socket.messages.map((message) => message.type)).toEqual([
      'codex.chat.event', 'codex.chat.complete', 'terminal.result',
      'filesystem.folder.create.result', 'filesystem.folder.rename.result',
      'filesystem.folder.delete.result', 'project-cli.result', 'filesystem.root.result'
    ]);
    expect(JSON.stringify(socket.messages)).toContain('Connector runtime maintenance is in progress.');
    if (maintenance.certainty === 'known') maintenance.lease?.release();
  });

  test('a terminal mutation reserves activity before maintenance checks', async () => {
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => { finish = resolve; });
    const backend = {
      async runMachineTerminalCommand(request: { command: string }) {
        await barrier;
        return {
          command: request.command, cwd: '/tmp', durationMs: 1, exitCode: 0,
          stderr: '', stdout: 'done'
        };
      }
    } as unknown as ProjectSpaceBackend;
    const admission = new ConnectorRuntimeMaintenanceAdmission();
    const socket = new RecordingSocket();
    const controls = createProjectConnectorLegacyControls({
      backend,
      isCurrentConnection: () => true,
      maintenanceAdmission: admission,
      socket: socket as unknown as WebSocket
    });

    controls.handle({
      id: 'terminal-race', payload: { command: 'mutate', machineId: 'machine-1' },
      type: 'terminal.run'
    });
    expect(createConnectorRuntimeMaintenanceSafetyCheck(
      admission, { maintenanceBlockers: () => [] }
    )()).toEqual({
      blockers: [{ count: 1, kind: 'connector-activity', scope: 'terminal' }],
      certainty: 'known'
    });
    finish();
    await Bun.sleep(0);
    expect(socket.messages).toEqual([
      expect.objectContaining({ id: 'terminal-race', type: 'terminal.result' })
    ]);
  });
});
