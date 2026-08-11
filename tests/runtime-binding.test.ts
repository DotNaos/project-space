import { describe, expect, test } from 'bun:test';

import { resolveManagedRuntimeBinding } from '../server/runtime-binding';

const managed = {
  PROJECT_SPACE_MANAGED_SERVE: '1',
  PROJECT_SPACE_SIMULATION_STATE: '/tmp/project-space-simulation.json'
};

describe('managed runtime binding', () => {
  test('accepts explicit simulated APIs with local data', () => {
    expect(resolveManagedRuntimeBinding({
      ...managed,
      PROJECT_SPACE_APIS: 'simulated',
      PROJECT_SPACE_DATA: 'local'
    })).toEqual({
      apis: 'simulated',
      data: 'local',
      network: 'loopback-only',
      secrets: 'none',
      simulationStatePath: managed.PROJECT_SPACE_SIMULATION_STATE
    });
  });

  test.each([
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'remote' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'external', PROJECT_SPACE_DATA: 'local' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'external', PROJECT_SPACE_DATA: 'remote' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_SIMULATION_STATE: '' }],
    [{ PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_SIMULATION_STATE: '/tmp/state.json' }]
  ])('rejects an unsafe or unproven binding', (environment) => {
    expect(() => resolveManagedRuntimeBinding(environment)).toThrow();
  });
});
