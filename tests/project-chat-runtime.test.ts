import { describe, expect, test } from 'bun:test';

import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import { createProjectChatRuntime } from '../server/project-chat/runtime';
import { createProjectSpaceServer } from '../server/project-space-http';

async function withRuntimeServer(
  runtime: Awaited<ReturnType<typeof createProjectChatRuntime>>,
  operation: (origin: string) => Promise<void>
) {
  const server = await createProjectSpaceServer({
    host: '127.0.0.1',
    port: 0,
    projectChatRuntime: runtime
  });
  try {
    await operation(server.origin);
  } finally {
    await server.close();
  }
}

async function jsonRequest(
  origin: string,
  path: string,
  options: RequestInit = {}
) {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  return {
    body: await response.json() as Record<string, unknown>,
    headers: response.headers,
    status: response.status
  };
}

describe('Project Chat production runtime', () => {
  test('reports retention failures without exposing the database error', async () => {
    let reports = 0;
    class FailingRetentionRepository extends InMemoryProjectChatRepository {
      override async purgeExpired() {
        throw new Error('private database detail');
      }
    }
    const runtime = await createProjectChatRuntime({
      authRequired: () => false,
      onRetentionError() {
        reports += 1;
      },
      repository: new FailingRetentionRepository(),
      spaceId: 'runtime-retention-test'
    });

    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.stop();
    expect(reports).toBe(1);
  });

  test('serves the local human flow through the real Project Space HTTP router', async () => {
    const runtime = await createProjectChatRuntime({
      authRequired: () => false,
      repository: new InMemoryProjectChatRepository(),
      spaceId: 'runtime-local-test'
    });

    await withRuntimeServer(runtime, async (origin) => {
      const joined = await jsonRequest(origin, '/api/project-chat/join', {
        body: '{}',
        method: 'POST'
      });
      expect(joined.status).toBe(200);
      expect(joined.headers.get('cache-control')).toBe('no-store');
      expect(joined.body).toMatchObject({
        member: { displayName: 'Olli', handle: 'olli', role: 'human' }
      });

      const sent = await jsonRequest(origin, '/api/project-chat/messages', {
        body: JSON.stringify({
          body: 'Local Project Chat is connected.',
          channelId: 'general',
          idempotencyKey: 'runtime-local-message'
        }),
        method: 'POST'
      });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({
        message: {
          body: 'Local Project Chat is connected.',
          sequence: 1,
          sender: { displayName: 'Olli', role: 'human' }
        }
      });

      const read = await jsonRequest(
        origin,
        '/api/project-chat/messages?channelId=general&afterSequence=0&limit=100'
      );
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ latestSequence: 1, nextSequence: 1 });
      expect((read.body.messages as unknown[]).length).toBe(1);
    });
  });

  test('keeps hosted humans and authenticated agents distinct without trusting request identity', async () => {
    const runtime = await createProjectChatRuntime({
      async authenticateMachine(input) {
        return input.machineId === 'machine-one' && input.token === 'machine-secret'
          ? { machineId: 'machine-one', userId: 'user-olli' }
          : null;
      },
      authRequired: () => true,
      async readHumanSession() {
        return { displayName: 'Olli', login: 'olli', userId: 'user-olli' };
      },
      repository: new InMemoryProjectChatRepository(),
      spaceId: 'runtime-hosted-test'
    });

    await withRuntimeServer(runtime, async (origin) => {
      const humanHeaders = { Authorization: 'Bearer human-session' };
      expect((await jsonRequest(origin, '/api/project-chat/join', {
        body: '{}', headers: humanHeaders, method: 'POST'
      })).status).toBe(200);

      const agentHeaders = {
        Authorization: 'Bearer machine-secret',
        'X-Codex-Thread-ID': '019f4f2b-e97e-7180-9122-4187159dbe51',
        'X-Project-Machine-ID': 'machine-one'
      };
      const agentJoin = await jsonRequest(origin, '/api/project-chat/join', {
        body: JSON.stringify({ displayName: 'Mira', taskTitle: 'Project Chat' }),
        headers: agentHeaders,
        method: 'POST'
      });
      expect(agentJoin.status).toBe(200);
      expect(agentJoin.body).toMatchObject({
        member: {
          displayName: 'Mira',
          origin: {
            hostId: 'machine-one',
            machineId: 'machine-one',
            threadId: '019f4f2b-e97e-7180-9122-4187159dbe51'
          },
          role: 'agent'
        }
      });

      const sent = await jsonRequest(origin, '/api/project-chat/messages', {
        body: JSON.stringify({
          body: 'Message from the agent to @olli.',
          channelId: 'general',
          idempotencyKey: 'runtime-agent-message'
        }),
        headers: agentHeaders,
        method: 'POST'
      });
      expect(sent.status).toBe(200);
      expect(sent.body).toMatchObject({
        message: {
          mentions: [{ handle: 'olli' }],
          sender: { displayName: 'Mira', role: 'agent' }
        }
      });

      const spoofedPartialAgent = await jsonRequest(origin, '/api/project-chat/members', {
        headers: {
          ...humanHeaders,
          'X-Codex-Thread-ID': '019f4b93-5703-7692-ad6e-101e32fc4be0'
        }
      });
      expect(spoofedPartialAgent.status).toBe(403);
    });
  });

  test('returns a safe 503 instead of falling back to process memory in hosted mode', async () => {
    const runtime = await createProjectChatRuntime({
      authRequired: () => true,
      databaseConfigured: () => false,
      spaceId: 'runtime-unavailable-test'
    });

    await withRuntimeServer(runtime, async (origin) => {
      const response = await jsonRequest(origin, '/api/project-chat/join', {
        body: '{}',
        method: 'POST'
      });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: 'service_unavailable',
          message: 'Project Chat is temporarily unavailable.'
        }
      });
    });
  });
});
