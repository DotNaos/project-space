import { describe, expect, test } from 'bun:test';

import {
  createCodexRuntimeReadinessProbe
} from '../server/codex-sessions/readiness-probe';

function transport(input: {
  account?: unknown;
  accountError?: boolean;
  initializeError?: boolean;
}) {
  let closed = false;
  return {
    async call() {
      if (input.accountError) throw new Error('account unavailable');
      return input.account;
    },
    async close() {
      closed = true;
    },
    async initialize() {
      if (input.initializeError) throw new Error('initialize unavailable');
    },
    get closed() {
      return closed;
    }
  };
}

describe('Codex runtime readiness probe', () => {
  test('distinguishes a missing or unusable runtime', async () => {
    await expect(createCodexRuntimeReadinessProbe({
      resolveBinary: () => undefined
    })()).resolves.toBe('missing');

    const unusable = transport({ initializeError: true });
    await expect(createCodexRuntimeReadinessProbe({
      launch: () => unusable,
      resolveBinary: () => '/managed/codex'
    })()).resolves.toBe('missing');
    expect(unusable.closed).toBe(true);
  });

  test('distinguishes authorization from a ready account', async () => {
    const authorizationRequired = transport({
      account: { account: null, requiresOpenaiAuth: true }
    });
    await expect(createCodexRuntimeReadinessProbe({
      launch: () => authorizationRequired,
      resolveBinary: () => '/managed/codex'
    })()).resolves.toBe('authorization-required');

    const ready = transport({
      account: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
    });
    await expect(createCodexRuntimeReadinessProbe({
      launch: () => ready,
      resolveBinary: () => '/managed/codex'
    })()).resolves.toBe('ready');

    const localProvider = transport({
      account: { account: null, requiresOpenaiAuth: false }
    });
    await expect(createCodexRuntimeReadinessProbe({
      launch: () => localProvider,
      resolveBinary: () => '/managed/codex'
    })()).resolves.toBe('ready');
  });

  test('keeps initialized runtime evidence when account status is unavailable', async () => {
    const runtime = transport({ accountError: true });
    await expect(createCodexRuntimeReadinessProbe({
      launch: () => runtime,
      resolveBinary: () => '/managed/codex'
    })()).resolves.toBe('runtime-only');
  });

  test('caches one bounded probe result', async () => {
    let launches = 0;
    let now = 10;
    const probe = createCodexRuntimeReadinessProbe({
      cacheMs: 20,
      launch: () => {
        launches++;
        return transport({
          account: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true }
        });
      },
      now: () => now,
      resolveBinary: () => '/managed/codex'
    });
    await probe();
    await probe();
    expect(launches).toBe(1);
    now = 31;
    await probe();
    expect(launches).toBe(2);
  });
});
