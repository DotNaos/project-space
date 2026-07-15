import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  ConnectorRuntimeStopReplayProtection,
  connectorRuntimeStopSchema,
  createConnectorRuntimeStopWireRequest,
  verifyConnectorRuntimeStopWireRequest,
  type ConnectorRuntimeStopIdentity,
  type ConnectorRuntimeStopPlan
} from '../server/connector-runtime-stop-contract';

const keys = generateKeyPairSync('ed25519');
const now = Date.parse('2026-07-15T00:00:00.000Z');
const expectedRuntime: ConnectorRuntimeStopIdentity = {
  buildId: 'a'.repeat(40),
  channel: 'dev',
  instanceId: 'instance-current',
  protocolVersion: '2',
  releaseId: `dev-source-${'a'.repeat(40)}`,
  source: 'source'
};

function plan(overrides: Partial<ConnectorRuntimeStopPlan> = {}): ConnectorRuntimeStopPlan {
  return {
    expectedRuntime,
    machineId: 'machine-dev',
    operation: 'stop',
    operationId: 'operation-stop',
    schema: connectorRuntimeStopSchema,
    target: 'linux-x64',
    ...overrides
  };
}

function command(value = plan()) {
  return createConnectorRuntimeStopWireRequest(
    { generation: 7, plan: value, userId: 'user-owner' },
    keys.privateKey,
    { nonce: 'nonce-stop', now }
  );
}

function verify(value: unknown, overrides: Partial<Parameters<
  typeof verifyConnectorRuntimeStopWireRequest
>[2]> = {}) {
  return verifyConnectorRuntimeStopWireRequest(value, keys.publicKey, {
    expectedGeneration: 7,
    expectedMachineId: 'machine-dev',
    expectedRuntime,
    expectedTarget: 'linux-x64',
    now,
    ...overrides
  });
}

describe('connector runtime stop signed contract', () => {
  test('accepts only the exact source-development instance and exposes no execution input', () => {
    const request = command();
    expect(verify(request)).toEqual({ plan: plan(), userId: 'user-owner' });
    expect(Object.keys(request.plan).sort()).toEqual([
      'expectedRuntime', 'machineId', 'operation', 'operationId', 'schema', 'target'
    ]);
    expect(Object.keys(request.plan.expectedRuntime).sort()).toEqual([
      'buildId', 'channel', 'instanceId', 'protocolVersion', 'releaseId', 'source'
    ]);
    expect(JSON.stringify(request)).not.toMatch(/pid|path|service|shell|releaseUrl|command/i);
  });

  test('rejects arbitrary fields, tampering, and a non-source identity', () => {
    const arbitrary = command() as unknown as Record<string, unknown>;
    (arbitrary.plan as Record<string, unknown>).pid = 1234;
    expect(() => verify(arbitrary)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));

    const tampered = command();
    tampered.plan.expectedRuntime.instanceId = 'instance-other';
    expect(() => verify(tampered)).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));

    expect(() => createConnectorRuntimeStopWireRequest({
      generation: 7,
      plan: {
        ...plan(),
        expectedRuntime: { ...expectedRuntime, channel: 'stable' }
      } as ConnectorRuntimeStopPlan,
      userId: 'user-owner'
    }, keys.privateKey)).toThrow(expect.objectContaining({ code: 'invalid-schema' }));
  });

  test('binds machine, socket generation, target, and local process identity', () => {
    expect(() => verify(command(), { expectedMachineId: 'machine-other' }))
      .toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
    expect(() => verify(command(), { expectedGeneration: 8 }))
      .toThrow(expect.objectContaining({ code: 'stale-generation' }));
    expect(() => verify(command(), { expectedTarget: 'darwin-arm64' }))
      .toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
    expect(() => verify(command(), {
      expectedRuntime: { ...expectedRuntime, instanceId: 'instance-restarted' }
    })).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
  });

  test('rejects expired and replayed grants', () => {
    expect(() => verify(command(), { now: now + 70_000 }))
      .toThrow(expect.objectContaining({ code: 'expired' }));

    const replay = new ConnectorRuntimeStopReplayProtection();
    const request = command();
    expect(verify(request, { replayProtection: replay }).plan.operation).toBe('stop');
    expect(() => verify(request, { replayProtection: replay }))
      .toThrow(expect.objectContaining({ code: 'replayed' }));
  });
});
