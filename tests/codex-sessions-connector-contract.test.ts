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
  test('binds device authorization to one exact action without auth parameters', () => {
    const request = createCodexSessionsWireRequest({
      generation: 17,
      operation: 'authorization',
      operationId: 'codex:login:operation-one',
      payload: {
        action: 'start',
        machineId: 'connector-wsl',
        operationId: 'codex:login:operation-one'
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-login-one', now: 1_000_000 });
    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'authorization', keys.publicKey, {
      expectedGeneration: 17,
      expectedMachineId: 'connector-wsl',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });

    const arbitrary = structuredClone(request) as unknown as {
      grant: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    arbitrary.payload.apiKey = 'not-allowed';
    expect(isCodexSessionsWireRequest(arbitrary)).toBe(false);
  });

  test('binds attach to the exact user, machine, generation, thread, and tunnel', () => {
    const request = createCodexSessionsWireRequest({
      generation: 13,
      operation: 'attach',
      operationId: 'attach-operation-one',
      payload: {
        machineId: 'connector-remote',
        operationId: 'attach-operation-one',
        threadId,
        tunnelId: 'attach-tunnel-one'
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-attach-one', now: 1_000_000 });

    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'attach', keys.publicKey, {
      expectedGeneration: 13,
      expectedMachineId: 'connector-remote',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });
    const tampered = structuredClone(request);
    if ('tunnelId' in tampered.payload) tampered.payload.tunnelId = 'attach-tunnel-other';
    expect(() => verifyCodexSessionsWireRequest(tampered, 'attach', keys.publicKey, {
      expectedGeneration: 13,
      expectedMachineId: 'connector-remote',
      now: 1_001_000
    })).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
    const withListener = structuredClone(request) as unknown as {
      grant: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    withListener.payload.listenUrl = 'ws://0.0.0.0:8080';
    expect(isCodexSessionsWireRequest(withListener)).toBe(false);
  });

  test('binds machine-task start to exact issue, repository, physical machine, and connector generation', () => {
    const request = createCodexSessionsWireRequest({
      generation: 11,
      operation: 'start',
      operationId: 'start-issue-262',
      payload: {
        branch: 'issue-262-machine-tasks',
        commit: 'a'.repeat(40),
        initialPrompt: 'Implement https://github.com/DotNaos/project-space/issues/262',
        issueNumber: 262,
        issueUrl: 'https://github.com/DotNaos/project-space/issues/262',
        machineId: 'connector-local',
        operationId: 'start-issue-262',
        physicalMachineId: 'physical-local',
        projectId: 'github:R_test',
        repositoryId: 'R_test',
        repositoryNameWithOwner: 'DotNaos/project-space'
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-start-262', now: 1_000_000 });

    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'start', keys.publicKey, {
      expectedGeneration: 11,
      expectedMachineId: 'connector-local',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });

    request.payload.physicalMachineId = 'physical-other';
    expect(() => verifyCodexSessionsWireRequest(request, 'start', keys.publicKey, {
      expectedGeneration: 11,
      expectedMachineId: 'connector-local',
      now: 1_001_000
    })).toThrow(expect.objectContaining({ code: 'binding-mismatch' }));
  });

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

  test('accepts only one exact advertised permission profile setting', () => {
    const request = createCodexSessionsWireRequest({
      generation: 7,
      operation: 'settings',
      operationId: 'operation-settings-1',
      payload: {
        machineId: 'machine-one',
        operationId: 'operation-settings-1',
        permissionProfileId: ':workspace',
        threadId
      },
      userId: 'user-owner'
    }, keys.privateKey, { nonce: 'nonce-settings-1', now: 1_000_000 });

    expect(isCodexSessionsWireRequest(request)).toBe(true);
    expect(verifyCodexSessionsWireRequest(request, 'settings', keys.publicKey, {
      expectedGeneration: 7,
      expectedMachineId: 'machine-one',
      now: 1_001_000
    })).toEqual({ userId: 'user-owner' });

    request.payload.permissionProfileId = ':workspace/../../danger';
    expect(isCodexSessionsWireRequest(request)).toBe(false);
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
