import { describe, expect, test } from 'bun:test';

import { createLocalPhysicalMachineStore } from '../server/local-physical-machine-store';

describe('local physical machine store', () => {
  test('groups visible connectors and moves a connector between machines', () => {
    const store = createLocalPhysicalMachineStore();
    const first = store.save({
      allowedConnectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      connectorIds: ['windows', 'wsl-stable'],
      name: 'os-pc',
      userId: 'user-1'
    });
    const second = store.save({
      allowedConnectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      connectorIds: ['wsl-stable', 'wsl-dev'],
      name: 'Linux runtimes',
      userId: 'user-1'
    });

    expect(store.list('user-1')).toEqual([
      { connectorIds: ['wsl-stable', 'wsl-dev'], id: second.id, name: 'Linux runtimes' },
      { connectorIds: ['windows'], id: first.id, name: 'os-pc' }
    ]);
    expect(store.list('user-2')).toEqual([]);
  });

  test('rejects connector identities outside the local overview', () => {
    const store = createLocalPhysicalMachineStore();

    expect(() => store.save({
      allowedConnectorIds: ['windows'],
      connectorIds: ['unknown'],
      name: 'os-pc',
      userId: 'user-1'
    })).toThrow('Only connector installations visible in this local workspace can be grouped.');
  });
});
