import { describe, expect, test } from 'bun:test';

import { resolveLocalMachineName } from '../server/local-machine-identity';

describe('local machine identity', () => {
  test('prefers the stable macOS computer name over a conflicted Bonjour hostname', () => {
    expect(resolveLocalMachineName({
      computerName: 'os-macbook',
      hostName: 'os-macbook-2.home',
      platform: 'darwin'
    })).toBe('os-macbook');
  });

  test('uses the short hostname on other platforms', () => {
    expect(resolveLocalMachineName({
      computerName: 'ignored-mac-name',
      hostName: 'os-pc.tailnet.example',
      platform: 'linux'
    })).toBe('os-pc');
  });

  test('falls back to the short hostname when macOS metadata is unavailable', () => {
    expect(resolveLocalMachineName({
      hostName: 'os-macbook-2.home',
      platform: 'darwin'
    })).toBe('os-macbook-2');
  });
});
