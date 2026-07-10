import { afterEach, describe, expect, test } from 'bun:test';
import { resolveProjectConnectorTargets } from '../server/project-connector-config';

const originalConfig = process.env.PROJECT_CONNECTOR_CONFIG;
const originalHubs = process.env.PROJECT_CONNECTOR_HUBS;

afterEach(() => {
  if (originalConfig === undefined) {
    delete process.env.PROJECT_CONNECTOR_CONFIG;
  } else {
    process.env.PROJECT_CONNECTOR_CONFIG = originalConfig;
  }
  if (originalHubs === undefined) {
    delete process.env.PROJECT_CONNECTOR_HUBS;
  } else {
    process.env.PROJECT_CONNECTOR_HUBS = originalHubs;
  }
});

describe('connector hub targets', () => {
  test('derives the authenticated command socket from an HTTPS hub URL', () => {
    process.env.PROJECT_CONNECTOR_CONFIG = '/tmp/project-space-missing-connector-config.json';
    process.env.PROJECT_CONNECTOR_HUBS = JSON.stringify([
      { name: 'prod', url: 'https://projects.os-home.net/' }
    ]);

    expect(resolveProjectConnectorTargets()).toEqual([
      {
        name: 'prod',
        registrationTokenEnv: 'PROJECT_CONNECTOR_REGISTRATION_TOKEN',
        url: 'https://projects.os-home.net',
        wsUrl: 'wss://projects.os-home.net/api/connectors/socket'
      }
    ]);
  });
});
