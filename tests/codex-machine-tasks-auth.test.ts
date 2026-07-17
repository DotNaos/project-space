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
});
