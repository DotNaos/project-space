import { describe, expect, test } from 'bun:test';

import {
  readMachineConnectionPublicOrigin,
  machineConnectionRateLimitSecretEnvironment,
  readMachineConnectionRateLimitSecret
} from '../server/machine-connection-environment';

describe('machine connection environment', () => {
  test('requires HTTPS except for an explicit loopback origin', () => {
    expect(
      readMachineConnectionPublicOrigin({
        PROJECT_SPACE_PUBLIC_ORIGIN: 'https://projects.os-home.net'
      })
    ).toBe('https://projects.os-home.net');
    expect(
      readMachineConnectionPublicOrigin({
        PROJECT_SPACE_PUBLIC_ORIGIN: 'http://127.0.0.1:4173'
      })
    ).toBe('http://127.0.0.1:4173');
    expect(readMachineConnectionPublicOrigin({})).toBeNull();

    for (const value of [
      'http://projects.os-home.net',
      'https://user:password@projects.os-home.net',
      'https://projects.os-home.net/path',
      ' https://projects.os-home.net'
    ]) {
      expect(() =>
        readMachineConnectionPublicOrigin({ PROJECT_SPACE_PUBLIC_ORIGIN: value })
      ).toThrow('not configured securely');
    }
  });

  test('requires an independent bounded secret and returns a private copy', () => {
    const source = 'a'.repeat(64);
    const environment = {
      [machineConnectionRateLimitSecretEnvironment]: source,
      CLERK_SECRET_KEY: 'must-not-be-used',
      PROJECT_CONNECTOR_REGISTRATION_TOKEN: 'must-not-be-used'
    };

    const secret = readMachineConnectionRateLimitSecret(environment);
    expect(secret.byteLength).toBe(64);
    expect(secret.toString('utf8')).toBe(source);
    secret.fill(0);
    expect(environment[machineConnectionRateLimitSecretEnvironment]).toBe(source);
  });

  test('never falls back to Clerk, connector, or database credentials', () => {
    for (const environment of [
      {},
      { CLERK_SECRET_KEY: 'c'.repeat(64) },
      { PROJECT_CONNECTOR_REGISTRATION_TOKEN: 'r'.repeat(64) },
      { DATABASE_URL: 'postgres://secret' }
    ]) {
      expect(() => readMachineConnectionRateLimitSecret(environment)).toThrow(
        'rate-limit secret is not configured securely'
      );
    }
  });

  test('rejects short, padded, multiline, and unbounded values without echoing them', () => {
    for (const secret of [
      'short',
      ` ${'a'.repeat(32)}`,
      `${'a'.repeat(32)}\nunsafe`,
      'a'.repeat(4_097)
    ]) {
      try {
        readMachineConnectionRateLimitSecret({
          [machineConnectionRateLimitSecretEnvironment]: secret
        });
        throw new Error('Expected an unsafe secret to be rejected.');
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
