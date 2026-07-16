import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  CodexSessionsGrantError,
  CodexSessionsGrantReplayProtection,
  createCodexSessionsWireRequest,
  isCodexSessionsWireRequest,
  verifyCodexSessionsWireRequest
} from '../server/codex-sessions-connector-contract';

const keys = generateKeyPairSync('ed25519');
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';

function continueRequest() {
  return createCodexSessionsWireRequest({
    generation: 7,
    operation: 'continue',
    operationId: 'operation-continue-1',
    payload: {
      machineId: 'machine-one',
      message: 'Continue the same task',
      operationId: 'operation-continue-1',
      threadId
    },
    userId: 'user-owner'
  }, keys.privateKey, { nonce: 'nonce-continue-1', now: 1_000_000 });
}

describe('Codex sessions connector grants', () => {
  test('binds the dedicated browser snapshot operation to its exact task', () => {
    const request = createCodexSessionsWireRequest({
      generation: 7,
      operation: 'browser',
      operationId: 'operation-browser-snapshot',
      payload: { afterImageRevision: 'a'.repeat(64), machineId: 'machine-one', threadId },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-browser-snapshot', now: 1_000_000 });

    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'browser', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });

    request.payload.threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9b';
    expect(() => verifyCodexSessionsWireRequest(request, 'browser', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
  });

  test('binds one operation to user, machine, thread, generation, and exact payload', () => {
    const request = continueRequest();
    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });

    const tampered = structuredClone(request);
    if ('message' in tampered.payload) tampered.payload.message = 'Start different work';
    expect(() => verifyCodexSessionsWireRequest(tampered, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
  });

  test('rejects wrong machine, stale generation, expiry, and replay', () => {
    const request = continueRequest();
    expect(() => verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-two',
      now: 1_001_000
    })).toThrow(CodexSessionsGrantError);
    expect(() => verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 8,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toThrow(expect.objectContaining({ code: 'stale-generation' }));
    expect(() => verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_100_000
    })).toThrow(expect.objectContaining({ code: 'expired' }));

    const replay = new CodexSessionsGrantReplayProtection();
    verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000,
      replayProtection: replay
    });
    expect(() => verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_001,
      replayProtection: replay
    })).toThrow(expect.objectContaining({ code: 'replayed' }));
  });

  test('rejects arbitrary fields and untyped payload shapes before verification', () => {
    const request = continueRequest() as unknown as {
      grant: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    request.payload.shellCommand = 'rm -rf /';
    expect(isCodexSessionsWireRequest(request)).toBe(false);
    delete request.payload.shellCommand;
    request.grant.url = 'https://attacker.example/payload';
    expect(isCodexSessionsWireRequest(request)).toBe(false);
  });

  test('does not allow operation ids to differ between grant and mutation payload', () => {
    const request = continueRequest();
    request.grant.operationId = 'operation-other';
    expect(() => verifyCodexSessionsWireRequest(request, 'continue', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toThrow(CodexSessionsGrantError);
  });
});
