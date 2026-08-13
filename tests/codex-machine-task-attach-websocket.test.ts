import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'bun:test';

import { CodexAttachLeaseStore } from '../server/codex-machine-tasks/attach-lease-store';
import { createCodexAttachUpgradeHandler } from '../server/codex-machine-tasks/attach-websocket';

describe('retired Codex attach WebSocket', () => {
  test('rejects before consuming credentials or opening a Connector relay', async () => {
    const leases = new CodexAttachLeaseStore();
    const issued = leases.issue({
      callerMachineId: 'caller-one',
      connectorId: 'connector-remote',
      generation: 7,
      operationId: 'attach-operation-one',
      threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c',
      userId: 'user-owner'
    });
    const handler = createCodexAttachUpgradeHandler(leases);
    const socket = new PassThrough();
    let response = '';
    socket.on('data', (chunk) => { response += chunk.toString('utf8'); });

    expect(handler.handleUpgrade(
      { url: issued.endpointPath } as never,
      socket,
      Buffer.alloc(0)
    )).toBe(true);
    await new Promise<void>((resolve) => socket.once('finish', resolve));

    expect(response).toContain('HTTP/1.1 410 Gone');
    expect(response).toContain('canonical_runtime_required');
    expect(leases.consume(issued.token, '019f6d33-6aad-7302-a45e-bb7a33fc399c')).toMatchObject({
      connectorId: 'connector-remote'
    });
  });
});
