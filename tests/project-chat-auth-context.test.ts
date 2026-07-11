import type { IncomingMessage } from 'node:http';

import { describe, expect, test } from 'bun:test';

import {
  createProjectChatAuthContextResolver,
  type ProjectChatAuthContextDependencies,
  type ProjectChatHumanSession
} from '../server/project-chat/auth-context';
import { ProjectChatAccessError } from '../server/project-chat/http-api';

type TestHeaders = Record<string, string | string[]>;
const testThreadId = '019f4f2b-e97e-7180-9122-4187159dbe51';
const otherThreadId = '019f4b93-5703-7692-ad6e-101e32fc4be0';

function request(headers: TestHeaders = {}, rawHeaders?: string[]) {
  return {
    headers,
    rawHeaders: rawHeaders ?? Object.entries(headers).flatMap(([name, value]) =>
      Array.isArray(value)
        ? value.flatMap((entry) => [name, entry])
        : [name, value]
    )
  } as unknown as IncomingMessage;
}

function dependencies(
  overrides: Partial<ProjectChatAuthContextDependencies> = {}
): ProjectChatAuthContextDependencies {
  return {
    async authenticateMachine() {
      return null;
    },
    authRequired: () => true,
    async readHumanSession() {
      return null;
    },
    spaceId: 'installation-one',
    ...overrides
  };
}

async function expectAccess(
  promise: Promise<unknown>,
  statusCode: 401 | 403
) {
  try {
    await promise;
    throw new Error('Expected Project Chat access to be denied.');
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectChatAccessError);
    expect((error as ProjectChatAccessError).statusCode).toBe(statusCode);
    expect((error as Error).message).not.toContain('token');
  }
}

describe('Project Chat trusted request context', () => {
  test('resolves a hosted human only from the authenticated server session', async () => {
    let machineAuthCalls = 0;
    const resolve = createProjectChatAuthContextResolver(dependencies({
      async authenticateMachine() {
        machineAuthCalls += 1;
        return null;
      },
      async readHumanSession() {
        return {
          displayName: '  Olli   Schütz  ',
          login: 'OLLI@example.com',
          userId: 'user_olli'
        };
      }
    }));

    await expect(resolve(request({
      'x-project-account-id': 'spoofed-account',
      'x-project-host-id': 'spoofed-host',
      'x-project-role': 'agent'
    }))).resolves.toEqual({
      actor: {
        accountId: 'user_olli',
        displayName: 'Olli Schütz',
        handle: 'olli-example-com',
        kind: 'human'
      },
      spaceId: 'installation-one'
    });
    expect(machineAuthCalls).toBe(0);
  });

  test('requires a hosted human session and fails closed when the session reader fails', async () => {
    const missing = createProjectChatAuthContextResolver(dependencies());
    const failed = createProjectChatAuthContextResolver(dependencies({
      async readHumanSession() {
        throw new Error('identity provider unavailable');
      }
    }));

    await expectAccess(missing(request()), 401);
    await expectAccess(failed(request()), 401);
  });

  test('creates a server-defined local human only while authentication is disabled', async () => {
    let humanSessionReads = 0;
    const resolve = createProjectChatAuthContextResolver(dependencies({
      authRequired: () => false,
      localDevelopmentHuman: {
        displayName: '  Olli  Local ',
        login: 'olli.local',
        userId: 'local-development-user'
      },
      async readHumanSession() {
        humanSessionReads += 1;
        return null;
      }
    }));

    await expect(resolve(request())).resolves.toEqual({
      actor: {
        accountId: 'local-development-user',
        displayName: 'Olli Local',
        handle: 'olli-local',
        kind: 'human'
      },
      spaceId: 'installation-one'
    });
    expect(humanSessionReads).toBe(0);
  });

  test('resolves an agent only from machine authentication and a server-derived host', async () => {
    const authentications: Array<{ machineId: string; token: string }> = [];
    let humanSessionReads = 0;
    const resolve = createProjectChatAuthContextResolver(dependencies({
      async authenticateMachine(input) {
        authentications.push(input);
        return { machineId: 'machine-mac-studio', userId: 'user_owner' };
      },
      hostIdForMachine(machineId) {
        expect(machineId).toBe('machine-mac-studio');
        return 'host-mac-studio';
      },
      async readHumanSession() {
        humanSessionReads += 1;
        return { login: 'attacker', userId: 'user_attacker' };
      }
    }));

    await expect(resolve(request({
      authorization: 'Bearer machine-token_123',
      'x-codex-thread-id': testThreadId,
      'x-project-account-id': 'user_attacker',
      'x-project-host-id': 'host-spoofed',
      'x-project-machine-id': 'machine-mac-studio'
    }))).resolves.toEqual({
      actor: {
        accountId: 'user_owner',
        hostId: 'host-mac-studio',
        kind: 'agent',
        machineId: 'machine-mac-studio',
        threadId: testThreadId
      },
      spaceId: 'installation-one'
    });
    expect(authentications).toEqual([
      { machineId: 'machine-mac-studio', token: 'machine-token_123' }
    ]);
    expect(humanSessionReads).toBe(0);
  });

  test('never falls back to human auth after an agent signal or machine mismatch', async () => {
    let humanSessionReads = 0;
    const humanSession: ProjectChatHumanSession = {
      login: 'olli',
      userId: 'user_olli'
    };
    const base = {
      async readHumanSession() {
        humanSessionReads += 1;
        return humanSession;
      }
    };
    const rejected = createProjectChatAuthContextResolver(dependencies({
      ...base,
      async authenticateMachine() {
        return null;
      }
    }));
    const mismatched = createProjectChatAuthContextResolver(dependencies({
      ...base,
      async authenticateMachine() {
        return { machineId: 'machine-real', userId: 'user_olli' };
      }
    }));
    const headers = {
      authorization: 'Bearer valid-looking-token',
      'x-codex-thread-id': testThreadId,
      'x-project-machine-id': 'machine-spoofed'
    };

    await expectAccess(rejected(request(headers)), 401);
    await expectAccess(mismatched(request(headers)), 403);
    expect(humanSessionReads).toBe(0);
  });

  test('rejects partial, empty, and duplicated agent headers even in local mode', async () => {
    let machineAuthCalls = 0;
    const resolve = createProjectChatAuthContextResolver(dependencies({
      authRequired: () => false,
      async authenticateMachine() {
        machineAuthCalls += 1;
        return { machineId: 'machine-one', userId: 'user_one' };
      }
    }));

    await expectAccess(resolve(request({ 'x-project-machine-id': 'machine-one' })), 403);
    await expectAccess(resolve(request({ 'x-codex-thread-id': testThreadId })), 403);
    await expectAccess(resolve(request({
      'x-codex-thread-id': testThreadId,
      'x-project-machine-id': ''
    })), 403);
    await expectAccess(resolve(request(
      {
        authorization: 'Bearer machine-token',
        'x-codex-thread-id': testThreadId,
        'x-project-machine-id': 'machine-one'
      },
      [
        'Authorization', 'Bearer machine-token',
        'X-Codex-Thread-ID', testThreadId,
        'X-Project-Machine-ID', 'machine-one',
        'X-Project-Machine-ID', 'machine-two'
      ]
    )), 403);
    expect(machineAuthCalls).toBe(0);
  });

  test('rejects oversized, control-bearing, or injected authentication headers', async () => {
    let machineAuthCalls = 0;
    const resolve = createProjectChatAuthContextResolver(dependencies({
      async authenticateMachine() {
        machineAuthCalls += 1;
        return { machineId: 'machine-one', userId: 'user_one' };
      }
    }));
    const valid = {
      authorization: 'Bearer machine-token',
      'x-codex-thread-id': testThreadId,
      'x-project-machine-id': 'machine-one'
    };

    await expectAccess(resolve(request({
      ...valid,
      'x-project-machine-id': `m${'x'.repeat(128)}`
    })), 403);
    await expectAccess(resolve(request({
      ...valid,
      'x-codex-thread-id': `${testThreadId}\r\nx-project-role: human`
    })), 403);
    await expectAccess(resolve(request({
      ...valid,
      'x-codex-thread-id': 'glpat-012345678901234567890123456789'
    })), 403);
    await expectAccess(resolve(request({
      ...valid,
      'x-codex-thread-id': otherThreadId.toUpperCase()
    })), 403);
    await expectAccess(resolve(request({
      ...valid,
      authorization: `Bearer ${'a'.repeat(4_097)}`
    })), 401);
    await expectAccess(resolve(request({
      ...valid,
      authorization: 'Bearer machine-token\nX-Project-Role: human'
    })), 401);
    expect(machineAuthCalls).toBe(0);
  });

  test('rejects unsafe server identity metadata and keeps installation contexts isolated', async () => {
    const human = {
      async readHumanSession() {
        return { displayName: 'Olli', login: 'olli', userId: 'user_olli' };
      }
    };
    const first = createProjectChatAuthContextResolver(dependencies({
      ...human,
      spaceId: 'installation-one'
    }));
    const second = createProjectChatAuthContextResolver(dependencies({
      ...human,
      spaceId: 'installation-two'
    }));
    const unsafeName = createProjectChatAuthContextResolver(dependencies({
      async readHumanSession() {
        return {
          displayName: 'Olli\nAdmin',
          login: 'olli',
          userId: 'user_olli'
        };
      }
    }));

    expect((await first(request())).spaceId).toBe('installation-one');
    expect((await second(request())).spaceId).toBe('installation-two');
    await expectAccess(unsafeName(request()), 403);
  });
});
