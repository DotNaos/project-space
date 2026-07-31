import { describe, expect, test } from 'bun:test';

import { createLocalPhysicalMachineStore } from '../server/local-physical-machine-store';

describe('local physical machine store', () => {
  test('groups visible connectors and moves a connector between machines', () => {
    const store = createLocalPhysicalMachineStore();
    const first = store.save({
      allowedConnectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      connectorIds: ['windows', 'wsl-stable'],
      kind: 'physical',
      name: 'os-pc',
      userId: 'user-1'
    });
    const second = store.save({
      allowedConnectorIds: ['windows', 'wsl-stable', 'wsl-dev'],
      connectorIds: ['wsl-stable', 'wsl-dev'],
      kind: 'virtual',
      name: 'Linux runtimes',
      userId: 'user-1'
    });

    expect(store.list('user-1')).toEqual([
      { connectorIds: ['wsl-stable', 'wsl-dev'], id: second.id, kind: 'virtual', name: 'Linux runtimes' },
      { connectorIds: ['windows'], id: first.id, kind: 'physical', name: 'os-pc' }
    ]);
    expect(store.list('user-2')).toEqual([]);
  });

  test('rejects connector identities outside the local overview', () => {
    const store = createLocalPhysicalMachineStore();

    expect(() => store.save({
      allowedConnectorIds: ['windows'],
      connectorIds: ['unknown'],
      kind: 'physical',
      name: 'os-pc',
      userId: 'user-1'
    })).toThrow('Only connector installations visible in this local workspace can be grouped.');
  });

  test('keeps empty machines and only deletes an empty machine', () => {
    const store = createLocalPhysicalMachineStore();
    const empty = store.save({
      allowedConnectorIds: [],
      connectorIds: [],
      kind: 'virtual',
      name: 'ChatGPT-Work-VM',
      userId: 'user-1'
    });
    const occupied = store.save({
      allowedConnectorIds: ['connector'],
      connectorIds: ['connector'],
      kind: 'physical',
      name: 'Desk PC',
      userId: 'user-1'
    });

    expect(store.delete('user-1', occupied.id)).toBe(false);
    expect(store.delete('user-1', empty.id)).toBe(true);
    expect(store.list('user-1')).toEqual([
      { connectorIds: ['connector'], id: occupied.id, kind: 'physical', name: 'Desk PC' }
    ]);
  });
});
