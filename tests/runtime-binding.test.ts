import { describe, expect, test } from 'bun:test';

import { resolveManagedRuntimeBinding } from '../server/runtime-binding';

const managed = {
  PROJECT_SPACE_MANAGED_SERVE: '1',
  PROJECT_SPACE_RUNTIME_ACCESS_URL: 'http://project.localhost:1355',
  PROJECT_SPACE_SERVE_MODE: 'local-only',
  PROJECT_SPACE_SIMULATION_STATE: '/tmp/project-space-simulation.json'
};

describe('managed runtime binding', () => {
  test('accepts explicit simulated APIs with local data', () => {
    expect(resolveManagedRuntimeBinding({
      ...managed,
      PROJECT_SPACE_APIS: 'simulated',
      PROJECT_SPACE_DATA: 'local'
    })).toEqual({
      accessUrl: managed.PROJECT_SPACE_RUNTIME_ACCESS_URL,
      apis: 'simulated',
      data: 'local',
      network: 'loopback-only',
      secrets: 'none',
      simulationStatePath: managed.PROJECT_SPACE_SIMULATION_STATE
    });
  });

  test('keeps local APIs and data while publishing the runtime through Tailscale', () => {
    expect(resolveManagedRuntimeBinding({
      ...managed,
      PROJECT_SPACE_APIS: 'simulated',
      PROJECT_SPACE_DATA: 'local',
      PROJECT_SPACE_RUNTIME_ACCESS_URL: 'http://100.64.0.8:44419',
      PROJECT_SPACE_SERVE_MODE: 'managed'
    })).toMatchObject({
      accessUrl: 'http://100.64.0.8:44419',
      apis: 'simulated',
      data: 'local',
      network: 'external',
      secrets: 'none'
    });
  });

  test('accepts the existing Portless URL from an older local-only CLI', () => {
    const { PROJECT_SPACE_RUNTIME_ACCESS_URL: _ignored, ...legacyManaged } = managed;
    const environment = {
      ...legacyManaged,
      PORTLESS_URL: 'http://project.localhost:1355',
      PROJECT_SPACE_APIS: 'simulated',
      PROJECT_SPACE_DATA: 'local'
    };

    expect(resolveManagedRuntimeBinding(environment)).toMatchObject({
      accessUrl: environment.PORTLESS_URL,
      network: 'loopback-only'
    });
  });

  test.each([
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'remote' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'external', PROJECT_SPACE_DATA: 'local' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'external', PROJECT_SPACE_DATA: 'remote' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_RUNTIME_ACCESS_URL: '' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_SERVE_MODE: '' }],
    [{ ...managed, PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_SIMULATION_STATE: '' }],
    [{ PROJECT_SPACE_APIS: 'simulated', PROJECT_SPACE_DATA: 'local', PROJECT_SPACE_SIMULATION_STATE: '/tmp/state.json' }]
  ])('rejects an unsafe or unproven binding', (environment) => {
    expect(() => resolveManagedRuntimeBinding(environment)).toThrow();
  });
});
