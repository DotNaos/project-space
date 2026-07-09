import { expect, test } from 'bun:test';

import { isWebHubMachine } from './local-project-space-backend.ts';

function machine(serviceName) {
  return {
    connector: {
      installCommand: 'project connector install',
      serviceName,
      status: 'local'
    }
  };
}

test('web hub machines are hidden from the connector machine list', () => {
  expect(isWebHubMachine(machine('project-space-web'))).toBe(true);
  expect(isWebHubMachine(machine('project-space-prod-web'))).toBe(true);
  expect(isWebHubMachine(machine('project-space-beta-web'))).toBe(true);
});

test('real machine connectors stay visible', () => {
  expect(isWebHubMachine(machine('project-space-connector'))).toBe(false);
  expect(isWebHubMachine(machine('net.os-home.project-space-connector'))).toBe(false);
  expect(isWebHubMachine(machine('my-web'))).toBe(false);
  expect(isWebHubMachine(machine(undefined))).toBe(false);
});
