import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  ProjectChatError,
  type ProjectChatContext
} from '../server/project-chat/contracts';
import {
  createProjectChatHttpApi,
  ProjectChatAccessError
} from '../server/project-chat/http-api';
import type { ProjectChatService } from '../server/project-chat/service';

const context: ProjectChatContext = {
  spaceId: 'space-http-test',
  actor: {
    kind: 'human',
    accountId: 'account-olli',
    displayName: 'Olli',
    handle: 'olli'
  }
};

const member = {
  displayName: 'Olli',
  handle: 'olli',
  joinedAt: '2026-07-11T00:00:00.000Z',
  memberId: 'member-1',
  presence: {
    expiresAt: '2026-07-11T00:01:30.000Z',
    lastSeenAt: '2026-07-11T00:00:00.000Z',
    state: 'working'
  },
  role: 'human',
  updatedAt: '2026-07-11T00:00:00.000Z'
};

const message = {
  body: 'Hello agents',
  channelId: 'general',
  createdAt: '2026-07-11T00:00:00.000Z',
  expiresAt: '2026-07-12T00:00:00.000Z',
  id: 'message-1',
  mentions: [],
  sender: {
    displayName: 'Olli',
    handle: 'olli',
    memberId: 'member-1',
    role: 'human'
  },
  sequence: 8
};

interface StubCall {
  context: ProjectChatContext;
  input?: unknown;
}

function stubService() {
  const calls = {
    acknowledge: [] as StubCall[],
    join: [] as StubCall[],
    listMembers: [] as StubCall[],
    mentions: [] as StubCall[],
    presence: [] as StubCall[],
    read: [] as StubCall[],
    send: [] as StubCall[]
  };
  const service = {
    async acknowledge(callContext: ProjectChatContext, input: unknown) {
      calls.acknowledge.push({ context: callContext, input });
      return {
        channelId: 'general',
        sequence: 8,
        updatedAt: '2026-07-11T00:00:01.000Z'
      };
    },
    async getMentionState(callContext: ProjectChatContext, input: unknown) {
      calls.mentions.push({ context: callContext, input });
      return { channelId: 'general', messages: [message], unreadCount: 1 };
    },
    async join(callContext: ProjectChatContext, input: unknown) {
      calls.join.push({ context: callContext, input });
      return {
        channel: {
          channelId: 'general',
          createdAt: '2026-07-11T00:00:00.000Z',
          description: 'Human and agent coordination',
          displayName: 'General'
        },
        member
      };
    },
    async listMembers(callContext: ProjectChatContext) {
      calls.listMembers.push({ context: callContext });
      return [member];
    },
    async readMessages(callContext: ProjectChatContext, input: unknown) {
      calls.read.push({ context: callContext, input });
      return {
        afterSequence: 7,
        channelId: 'general',
        hasMore: false,
        latestSequence: 8,
        messages: [message],
        nextSequence: 8
      };
    },
    async sendMessage(callContext: ProjectChatContext, input: unknown) {
      calls.send.push({ context: callContext, input });
      return message;
    },
    async updatePresence(callContext: ProjectChatContext, input: unknown) {
      calls.presence.push({ context: callContext, input });
      return member;
    }
  } as unknown as ProjectChatService;
  return { calls, service };
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startApi(
  service: ProjectChatService,
  resolveContext: (request: Parameters<ReturnType<typeof createProjectChatHttpApi>>[0]) =>
    Promise<ProjectChatContext> = async () => context
) {
  const api = createProjectChatHttpApi(service, resolveContext);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handled = await api(request, response, url);
    if (!handled) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
    }
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose an address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function responseJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function postJson(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
    method: 'POST'
  };
}

describe('Project Chat HTTP endpoint contract', () => {
  test('routes every endpoint, preserves envelopes, and wraps only messages and members', async () => {
    const { calls, service } = stubService();
    let resolverCalls = 0;
    const origin = await startApi(service, async (request) => {
      resolverCalls += 1;
      expect(request.headers.authorization).toBe('Bearer trusted-test');
      return context;
    });
    const auth = { Authorization: 'Bearer trusted-test' };

    const join = await fetch(`${origin}/api/project-chat/join`, postJson({}, auth));
    const presence = await fetch(
      `${origin}/api/project-chat/presence`,
      postJson({ state: 'working' }, auth)
    );
    const members = await fetch(`${origin}/api/project-chat/members`, { headers: auth });
    const send = await fetch(`${origin}/api/project-chat/messages`, postJson(
      { body: 'Hello agents', channelId: 'general', idempotencyKey: 'send-1' },
      { ...auth, 'Idempotency-Key': 'send-1' }
    ));
    const read = await fetch(
      `${origin}/api/project-chat/messages?channelId=general&afterSequence=7&limit=12`,
      { headers: auth }
    );
    const ack = await fetch(
      `${origin}/api/project-chat/ack`,
      postJson({ channelId: 'general', throughSequence: 8 }, auth)
    );
    const mentions = await fetch(
      `${origin}/api/project-chat/mentions?channelId=general&limit=9`,
      { headers: auth }
    );

    expect(await responseJson(join)).toMatchObject({ channel: { channelId: 'general' }, member });
    expect(await responseJson(presence)).toEqual(member);
    expect(await responseJson(members)).toEqual({ members: [member] });
    expect(await responseJson(send)).toEqual({ message });
    expect(await responseJson(read)).toEqual({
      afterSequence: 7,
      channelId: 'general',
      hasMore: false,
      latestSequence: 8,
      messages: [message],
      nextSequence: 8
    });
    expect(await responseJson(ack)).toEqual({
      channelId: 'general',
      sequence: 8,
      updatedAt: '2026-07-11T00:00:01.000Z'
    });
    expect(await responseJson(mentions)).toEqual({
      channelId: 'general',
      messages: [message],
      unreadCount: 1
    });
    expect([join, presence, members, send, read, ack, mentions].every(
      (response) => response.status === 200 && response.headers.get('cache-control') === 'no-store'
    )).toBe(true);
    expect(calls.read[0]?.input).toEqual({
      afterSequence: 7,
      channelId: 'general',
      limit: 12
    });
    expect(calls.mentions[0]?.input).toEqual({ channelId: 'general', limit: 9 });
    expect(Object.values(calls).flat().every((call) => call.context === context)).toBe(true);
    expect(resolverCalls).toBe(7);
  });

  test('does not authenticate or consume requests outside the Project Chat route contract', async () => {
    const { service } = stubService();
    let resolverCalls = 0;
    const origin = await startApi(service, async () => {
      resolverCalls += 1;
      return context;
    });

    const response = await fetch(`${origin}/api/not-project-chat`);

    expect(response.status).toBe(404);
    expect(resolverCalls).toBe(0);
  });
});

describe('Project Chat HTTP boundary security', () => {
  test('maps trusted resolver authentication failures and hides unexpected resolver errors', async () => {
    const { service } = stubService();
    const unauthorizedOrigin = await startApi(service, async () => {
      throw new ProjectChatAccessError(401);
    });
    const forbiddenOrigin = await startApi(service, async () => {
      throw new ProjectChatAccessError(403);
    });
    const unavailableOrigin = await startApi(service, async () => {
      throw new ProjectChatAccessError(503);
    });
    const failedOrigin = await startApi(service, async () => {
      throw new Error('secret resolver detail');
    });

    const unauthorized = await fetch(`${unauthorizedOrigin}/api/project-chat/members`);
    const forbidden = await fetch(`${forbiddenOrigin}/api/project-chat/members`);
    const unavailable = await fetch(`${unavailableOrigin}/api/project-chat/members`);
    const failed = await fetch(`${failedOrigin}/api/project-chat/members`);

    expect(unauthorized.status).toBe(401);
    expect(await responseJson(unauthorized)).toEqual({
      error: {
        code: 'authentication_required',
        message: 'Project Chat authentication is required.'
      }
    });
    expect(forbidden.status).toBe(403);
    expect(await responseJson(forbidden)).toEqual({
      error: {
        code: 'access_denied',
        message: 'Project Chat access is denied.'
      }
    });
    expect(unavailable.status).toBe(503);
    expect(await responseJson(unavailable)).toEqual({
      error: {
        code: 'service_unavailable',
        message: 'Project Chat is temporarily unavailable.'
      }
    });
    expect(failed.status).toBe(500);
    const payload = await responseJson(failed);
    expect(payload).toEqual({
      error: { code: 'internal_error', message: 'Unexpected Project Chat error.' }
    });
    expect(JSON.stringify(payload)).not.toContain('secret resolver detail');
  });

  test('rejects malformed, non-object, repeated-query, and oversized input before service calls', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const malformed = await fetch(`${origin}/api/project-chat/join`, {
      body: '{"displayName":',
      method: 'POST'
    });
    const array = await fetch(`${origin}/api/project-chat/join`, {
      body: '[]',
      method: 'POST'
    });
    const repeated = await fetch(
      `${origin}/api/project-chat/messages?limit=1&limit=2`
    );
    const oversized = await fetch(`${origin}/api/project-chat/messages`, postJson({
      body: 'x'.repeat(17 * 1024),
      channelId: 'general',
      idempotencyKey: 'oversized'
    }));

    expect(malformed.status).toBe(400);
    expect(array.status).toBe(400);
    expect(repeated.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(await responseJson(malformed)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await responseJson(array)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await responseJson(repeated)).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await responseJson(oversized)).toEqual({
      error: { code: 'request_too_large', message: 'The request body is too large.' }
    });
    expect(calls.join).toHaveLength(0);
    expect(calls.read).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
  });

  test('requires a supplied Idempotency-Key header to equal the validated body field', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);

    const response = await fetch(`${origin}/api/project-chat/messages`, postJson(
      { body: 'Safe message', channelId: 'general', idempotencyKey: 'body-key' },
      { 'Idempotency-Key': 'different-key' }
    ));

    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Idempotency-Key must match the request body.'
      }
    });
    expect(calls.send).toHaveLength(0);
  });

  test('maps every service error code without leaking generic exception details', async () => {
    const expected = [
      ['invalid_request', 400],
      ['not_member', 403],
      ['name_conflict', 409],
      ['idempotency_conflict', 409],
      ['cursor_out_of_range', 409],
      ['content_rejected', 422],
      ['rate_limited', 429]
    ] as const;

    for (const [code, status] of expected) {
      const service = {
        async listMembers() {
          throw new ProjectChatError(code, `Safe ${code}`, code === 'rate_limited' ? 750 : undefined);
        }
      } as unknown as ProjectChatService;
      const origin = await startApi(service);
      const response = await fetch(`${origin}/api/project-chat/members`);
      expect(response.status).toBe(status);
      expect(await responseJson(response)).toEqual({
        error: {
          code,
          message: `Safe ${code}`,
          ...(code === 'rate_limited' ? { retryAfterMs: 750 } : {})
        }
      });
    }

    const service = {
      async listMembers() {
        throw new Error('database password must stay private');
      }
    } as unknown as ProjectChatService;
    const origin = await startApi(service);
    const response = await fetch(`${origin}/api/project-chat/members`);
    const payload = await responseJson(response);
    expect(response.status).toBe(500);
    expect(payload).toEqual({
      error: { code: 'internal_error', message: 'Unexpected Project Chat error.' }
    });
    expect(JSON.stringify(payload)).not.toContain('database password');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
