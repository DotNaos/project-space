import { describe, expect, test } from 'bun:test';

import {
  CodexMachineTasksAuthError,
  createCodexMachineTasksAuthResolver
} from '../server/codex-machine-tasks/auth-context';

function request(headers: Record<string, string>) {
  return {
    headers,
    rawHeaders: Object.entries(headers).flatMap(([key, value]) => [key, value])
  } as never;
}

describe('Codex machine-task authentication', () => {
  test('maps the enrolled caller machine to its user without confusing it with the target', async () => {
    const resolve = createCodexMachineTasksAuthResolver({
      async authenticateMachine(input) {
        expect(input).toEqual({ machineId: 'caller-mac', token: 'secret-token' });
        return { machineId: 'caller-mac', userId: 'user-owner' };
      },
      authRequired: () => true,
      readHuman: async () => null
    });
    await expect(resolve(request({
      authorization: 'Bearer secret-token',
      'x-project-machine-id': 'caller-mac'
    }))).resolves.toEqual({ callerMachineId: 'caller-mac', userId: 'user-owner' });
  });

  test('rejects invalid, duplicate, and mismatched machine credentials', async () => {
    const resolve = createCodexMachineTasksAuthResolver({
      authenticateMachine: async () => ({ machineId: 'other-machine', userId: 'user-owner' }),
      authRequired: () => true,
      readHuman: async () => null
    });
    await expect(resolve(request({
      authorization: 'Bearer secret-token',
      'x-project-machine-id': 'caller-mac'
    }))).rejects.toEqual(expect.objectContaining({ statusCode: 403 }));
    await expect(resolve(request({
      'x-project-machine-id': 'caller-mac'
    }))).rejects.toBeInstanceOf(CodexMachineTasksAuthError);
  });

  test('binds the caller thread as an honest initiator and rejects spoofed header shapes', async () => {
    const resolve = createCodexMachineTasksAuthResolver({
      authenticateMachine: async () => ({ machineId: 'caller-mac', userId: 'user-owner' }),
      authRequired: () => true,
      readHuman: async () => ({ userId: 'user-owner' })
    });
    await expect(resolve(request({
      authorization: 'Bearer secret-token',
      'x-project-machine-id': 'caller-mac',
      'x-codex-thread-id': '019f6d33-6aad-7302-a45e-bb7a33fc399c'
    }))).resolves.toEqual({
      callerMachineId: 'caller-mac',
      reportingTask: { evidence: 'caller-supplied', role: 'initiator', threadId: '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
      userId: 'user-owner'
    });
    await expect(resolve(request({
      authorization: 'Bearer secret-token',
      'x-project-machine-id': 'caller-mac',
      'x-codex-thread-id': 'not-a-thread'
    }))).rejects.toEqual(expect.objectContaining({ statusCode: 403 }));
    const duplicate = {
      headers: { 'x-codex-thread-id': '019f6d33-6aad-7302-a45e-bb7a33fc399c' },
      rawHeaders: [
        'x-codex-thread-id', '019f6d33-6aad-7302-a45e-bb7a33fc399c',
        'x-codex-thread-id', '019f6d33-6aad-7302-a45e-bb7a33fc399d'
      ]
    } as never;
    await expect(resolve(duplicate)).rejects.toEqual(expect.objectContaining({ statusCode: 401 }));
    await expect(resolve(request({
      authorization: 'Bearer secret-token', 'x-project-machine-id': 'caller-mac'
    }))).resolves.toEqual({ callerMachineId: 'caller-mac', userId: 'user-owner' });
  });
});
