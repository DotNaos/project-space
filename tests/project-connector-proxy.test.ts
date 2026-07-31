import { afterEach, describe, expect, test } from 'bun:test';

import { projectConnectorProxyForUrl } from '../server/project-connector-websocket';

const proxyEnvironmentNames = [
  'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'WS_PROXY', 'WSS_PROXY',
  'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy', 'ws_proxy', 'wss_proxy'
] as const;
const originalProxyEnvironment = Object.fromEntries(
  proxyEnvironmentNames.map((name) => [name, process.env[name]])
);

function clearProxyEnvironment() {
  for (const name of proxyEnvironmentNames) delete process.env[name];
}

afterEach(() => {
  clearProxyEnvironment();
  for (const name of proxyEnvironmentNames) {
    const value = originalProxyEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('project connector proxy routing', () => {
  test('uses supported uppercase and lowercase proxy conventions', () => {
    clearProxyEnvironment();
    process.env.WSS_PROXY = 'http://uppercase-proxy.example.test:8080';
    expect(projectConnectorProxyForUrl('wss://projects.example.test/socket'))
      .toBe('http://uppercase-proxy.example.test:8080');

    clearProxyEnvironment();
    process.env.wss_proxy = 'http://lowercase-proxy.example.test:8080';
    expect(projectConnectorProxyForUrl('wss://projects.example.test/socket'))
      .toBe('http://lowercase-proxy.example.test:8080');
  });

  test('honors no-proxy without exposing the proxy URL', () => {
    clearProxyEnvironment();
    process.env.WSS_PROXY = 'http://proxy-user:proxy-password@proxy.example.test:8080';
    process.env.NO_PROXY = 'projects.example.test';

    expect(projectConnectorProxyForUrl('wss://projects.example.test/socket')).toBe('');
  });
});
