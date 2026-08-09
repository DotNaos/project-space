import { describe, expect, test } from 'bun:test';

import {
  createCodexAuthorizationService
} from '../server/codex-authorization/service';
import type { MachineRecord } from '../src/shared/project-space-api';

function connector(capabilities: string[]): MachineRecord {
  return {
    connector: {
      capabilities,
      installCommand: 'managed',
      status: 'online'
    },
    id: 'wsl-connector',
    kind: 'connector',
    name: 'os-pc WSL',
    network: {},
    roles: ['connector'],
    sourcePath: 'connector-hub'
  };
}

function service(options: {
  capabilities?: string[];
  connectorIds?: string[];
  generation?: number;
}) {
  const dispatched: unknown[] = [];
  return {
    dispatched,
    value: createCodexAuthorizationService({
      async dispatch(input) {
        dispatched.push(input);
        return {
          deadlineAt: '2026-07-24T00:15:00.000Z',
          state: 'pending',
          userCode: 'ABCD-1234',
          verificationUrl: 'https://auth.openai.com/codex/device'
        };
      },
      generationFor: () => options.generation,
      async inventory() {
        return {
          connectors: [connector(options.capabilities ?? [
            'codex.account.device-login.v1',
            'codex.authorization-required.v1',
            'codex.runtime.v1'
          ])],
          physicalMachines: [{
            connectorIds: options.connectorIds ?? ['wsl-connector'],
            id: 'physical-pc',
            name: 'os-pc'
          }]
        };
      }
    })
  };
}

describe('Codex authorization service', () => {
  test('authorizes an exact provider-managed Codespace environment', async () => {
    const dispatched: unknown[] = [];
    const value = createCodexAuthorizationService({
      async dispatch(input) {
        dispatched.push(input);
        return {
          deadlineAt: '2026-08-09T00:15:00.000Z',
          state: 'pending',
          userCode: 'SPACE-1234',
          verificationUrl: 'https://auth.openai.com/codex/device'
        };
      },
      generationFor: () => 9,
      async inventory() {
        return {
          computeInventory: {
            connectors: [{ associatedAt: '2026-08-09T00:00:00.000Z', connectorId: 'wsl-connector', environmentId: 'codespace-environment' }],
            environments: [{
              hostAssociation: { evidence: 'provider', resolution: 'not_applicable' },
              id: 'codespace-environment',
              identity: { key: 'environment:codespace12345678', version: 1 },
              kind: 'github_codespace',
              name: 'reliable-space',
              platformId: 'codespaces',
              resourceMode: 'dedicated'
            }],
            hosts: [],
            platforms: [{ id: 'codespaces', kind: 'github_codespaces', name: 'GitHub Codespaces' }],
            violations: []
          },
          connectors: [connector([
            'codex.account.device-login.v1',
            'codex.authorization-required.v1',
            'codex.runtime.v1'
          ])],
          physicalMachines: []
        };
      }
    });
    const response = await value.authorize({ userId: 'owner' }, {
      action: 'start',
      connectorId: 'wsl-connector',
      environmentId: 'codespace-environment',
      operationId: 'codex:login:codespace'
    });
    expect(response).toEqual(expect.objectContaining({ state: 'pending', userCode: 'SPACE-1234' }));
    expect(dispatched).toHaveLength(1);
  });

  test('dispatches one exact current-generation device login', async () => {
    const fixture = service({ generation: 7 });
    const response = await fixture.value.authorize(
      { userId: 'owner' },
      {
        action: 'start',
        operationId: 'codex:login:operation-one',
        physicalMachineName: 'os-pc'
      }
    );
    expect(response).toEqual(expect.objectContaining({
      deadlineAt: '2026-07-24T00:15:00.000Z',
      operationId: 'codex:login:operation-one',
      state: 'pending',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device'
    }));
    expect(fixture.dispatched).toEqual([{
      action: 'start',
      connectorId: 'wsl-connector',
      generation: 7,
      operationId: 'codex:login:operation-one',
      userId: 'owner'
    }]);
  });

  test('does not dispatch offline, unsupported, or already-ready connectors', async () => {
    const offline = service({ generation: undefined });
    await expect(offline.value.authorize({ userId: 'owner' }, {
      action: 'start',
      operationId: 'codex:login:offline',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual(expect.objectContaining({ state: 'offline' }));
    expect(offline.dispatched).toHaveLength(0);

    const unsupported = service({
      capabilities: ['codex.authorization-required.v1', 'codex.runtime.v1'],
      generation: 2
    });
    await expect(unsupported.value.authorize({ userId: 'owner' }, {
      action: 'start',
      operationId: 'codex:login:unsupported',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual(expect.objectContaining({ state: 'unsupported' }));
    expect(unsupported.dispatched).toHaveLength(0);

    const ready = service({
      capabilities: ['codex.machine-tasks.v1', 'codex.runtime.v1'],
      generation: 3
    });
    await expect(ready.value.authorize({ userId: 'owner' }, {
      action: 'start',
      operationId: 'codex:login:ready',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual(expect.objectContaining({ state: 'ready' }));
    expect(ready.dispatched).toHaveLength(0);
  });

  test('requires an exact visible machine and connector', async () => {
    const ambiguous = service({
      connectorIds: ['wsl-connector', 'windows-connector'],
      generation: 7
    });
    await expect(ambiguous.value.authorize({ userId: 'owner' }, {
      action: 'start',
      operationId: 'codex:login:ambiguous',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual(expect.objectContaining({ state: 'ambiguous' }));
    expect(ambiguous.dispatched).toHaveLength(0);

    const hidden = service({ generation: 7 });
    await expect(hidden.value.authorize({ userId: 'owner' }, {
      action: 'start',
      connectorId: 'another-connector',
      operationId: 'codex:login:hidden',
      physicalMachineName: 'os-pc'
    })).resolves.toEqual(expect.objectContaining({ state: 'unauthorized' }));
    expect(hidden.dispatched).toHaveLength(0);
  });
});
