import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  CodexSessionsHttpError,
  createCodexSessionsHttpApi,
  type CodexSessionsHttpService,
  type CodexSessionsRequestContext
} from '../server/codex-sessions-http';
import {
  CodexSessionsRequestError,
  createCodexSessionsClient
} from '../src/api/codex-sessions-client';

const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const context = { userId: 'user-owner' };
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function stubService() {
  const calls: Array<{ input: unknown; method: string }> = [];
  const session = {
    archived: false,
    id: threadId,
    lastActivityAt: '2026-07-13T01:00:00.000Z',
    loadedByProjectSpace: false,
    machineId: 'machine-one',
    machineName: 'os-macbook',
    status: 'idle' as const,
    title: '#149 · Integrate Codex sessions'
  };
  const service: CodexSessionsHttpService = {
    async approve(_context, input) {
      calls.push({ input, method: 'approve' });
      return accepted(input);
    },
    async browser(_context, input) {
      calls.push({ input, method: 'browser' });
      return {
        checkedAt: '2026-07-13T01:00:00.000Z',
        imageDataUrl: 'data:image/jpeg;base64,c2FmZQ==',
        imageRevision: 'a'.repeat(64),
        machineId: input.machineId,
        pageUrl: 'https://example.test',
        state: 'live',
        threadId: input.threadId,
        turnId: 'turn-one'
      };
    },
    async continue(_context, input) {
      calls.push({ input, method: 'continue' });
      return { ...accepted(input), turnId: 'turn-one' };
    },
    async interrupt(_context, input) {
      calls.push({ input, method: 'interrupt' });
      return accepted(input);
    },
    async inspect(_context, input) {
      calls.push({ input, method: 'inspect' });
      const sessionRevision = 'c'.repeat(64);
      return {
        checkedAt: '2026-07-13T01:00:00.000Z',
        openedReadOnly: true,
        session,
        sessionRevision,
        taskLocation: {
          canonicalCwd: '/projects/project-space',
          checkedAt: '2026-07-13T01:00:00.000Z',
          machineId: input.machineId,
          sessionRevision,
          source: 'connector-realpath',
          threadId: input.threadId,
          worktreeRoot: '/projects/project-space'
        },
        writeCapability: {
          canContinue: true,
          checkedAt: '2026-07-13T01:00:00.000Z',
          expiresAt: '2026-07-13T01:00:30.000Z',
          machineId: input.machineId,
          sessionLastActivityAt: session.lastActivityAt,
          sessionRevision,
          state: 'ready',
          threadId: input.threadId
        }
      };
    },
    async list(_context, input) {
      calls.push({ input, method: 'list' });
      return {
        checkedAt: '2026-07-13T01:00:00.000Z',
        machine: { id: input.machineId, name: 'os-macbook', online: true },
        sessions: [session]
      };
    },
    async read(_context, input) {
      calls.push({ input, method: 'read' });
      return { openedReadOnly: true, session, turns: [] };
    },
    async respondToUserInput(_context, input) {
      calls.push({ input, method: 'input' });
      return accepted(input);
    },
    async stream(_context, input, emit) {
      calls.push({ input, method: 'stream' });
      emit({
        delta: 'Streaming safely',
        eventId: 'event-one',
        itemId: 'item-one',
        type: 'agent-message-delta'
      }, 7);
    }
  };
  return { calls, service };
}

function accepted(input: { operationId: string; threadId: string }) {
  return {
    operationId: input.operationId,
    replayed: false,
    status: 'accepted' as const,
    threadId: input.threadId
  };
}

async function startApi(
  service: CodexSessionsHttpService,
  options: {
    authorize?: (context: CodexSessionsRequestContext, machineId: string) => Promise<void>;
    resolve?: () => Promise<CodexSessionsRequestContext>;
  } = {}
) {
  const api = createCodexSessionsHttpApi(
    service,
    options.resolve ?? (async () => context),
    options.authorize ?? (async () => undefined)
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await api(request, response, url)) {
      response.writeHead(404).end();
    }
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  return `http://127.0.0.1:${address.port}`;
}

function mutation(body: Record<string, unknown>, operationId = String(body.operationId)) {
  return {
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': operationId
    },
    method: 'POST'
  };
}

describe('Codex sessions authenticated HTTP boundary', () => {
  test('ignores malformed encoded paths without crashing the server', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const response = await fetch(`${origin}/api/codex/sessions/%ZZ`);
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test('authorizes the selected machine before listing, reading, or inspecting a task', async () => {
    const { calls, service } = stubService();
    const authorized: string[] = [];
    const origin = await startApi(service, {
      authorize: async (callContext, machineId) => {
        expect(callContext).toEqual(context);
        authorized.push(machineId);
      }
    });

    const list = await fetch(`${origin}/api/codex/sessions?machineId=machine-one&includeArchived=true`);
    const read = await fetch(`${origin}/api/codex/sessions/${threadId}?machineId=machine-one`);
    const inspect = await fetch(
      `${origin}/api/codex/sessions/${threadId}/inspect?machineId=machine-one`
    );
    const browser = await fetch(
      `${origin}/api/codex/sessions/${threadId}/browser?machineId=machine-one`
    );

    expect(list.status).toBe(200);
    expect(await read.json()).toMatchObject({ openedReadOnly: true });
    expect(await inspect.json()).toMatchObject({ sessionRevision: 'c'.repeat(64) });
    expect(await browser.json()).toMatchObject({ machineId: 'machine-one', state: 'live', threadId });
    expect(authorized).toEqual(['machine-one', 'machine-one', 'machine-one', 'machine-one']);
    expect(calls).toEqual([
      {
        input: { includeArchived: true, machineId: 'machine-one' },
        method: 'list'
      },
      { input: { machineId: 'machine-one', threadId }, method: 'read' },
      { input: { machineId: 'machine-one', threadId }, method: 'inspect' },
      { input: { machineId: 'machine-one', threadId }, method: 'browser' }
    ]);
  });

  test('rejects machine isolation failures before dispatch', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service, {
      authorize: async () => {
        throw new CodexSessionsHttpError(403, 'access_denied', 'Codex session access is denied.');
      }
    });
    const response = await fetch(`${origin}/api/codex/sessions?machineId=machine-two`);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'access_denied', message: 'Codex session access is denied.' }
    });
    expect(calls).toHaveLength(0);
  });

  test('requires matching machine and operation idempotency bindings for turns', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const path = `${origin}/api/codex/sessions/${threadId}/continue?machineId=machine-one`;
    const body = {
      machineId: 'machine-two',
      message: 'Continue this exact task',
      operationId: 'operation-123456'
    };
    const mismatch = await fetch(path, mutation(body));
    const missingHeader = await fetch(path, {
      body: JSON.stringify({ ...body, machineId: 'machine-one' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    });

    expect(mismatch.status).toBe(400);
    expect(missingHeader.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('forwards only valid catalogue settings with the exact continued task', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const path = `${origin}/api/codex/sessions/${threadId}/continue?machineId=machine-one`;
    const valid = await fetch(path, mutation({
      machineId: 'machine-one',
      message: 'Continue with this model',
      effort: 'high',
      model: 'gpt-5-mini',
      operationId: 'operation-model-1',
      serviceTier: 'fast'
    }));
    const invalid = await fetch(path, mutation({
      machineId: 'machine-one',
      message: 'Do not dispatch this',
      model: 'gpt 5 with spaces',
      operationId: 'operation-model-2'
    }));

    expect(valid.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(calls).toEqual([{
      input: {
        machineId: 'machine-one',
        message: 'Continue with this model',
        effort: 'high',
        model: 'gpt-5-mini',
        operationId: 'operation-model-1',
        serviceTier: 'fast',
        threadId
      },
      method: 'continue'
    }]);
  });

  test('preserves every approval and user-input correlation identifier', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const common = {
      machineId: 'machine-one',
      operationId: 'operation-approval-1',
      requestId: 'request-one',
      turnId: 'turn-one'
    };
    const approval = await fetch(
      `${origin}/api/codex/sessions/${threadId}/approval?machineId=machine-one`,
      mutation({ ...common, approvalId: 'approval-one', decision: 'allow-once', itemId: 'item-one' })
    );
    const input = await fetch(
      `${origin}/api/codex/sessions/${threadId}/input?machineId=machine-one`,
      mutation({
        ...common,
        answers: [{ questionId: 'question-one', value: 'integration-only' }]
      })
    );

    expect(approval.status).toBe(200);
    expect(input.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: 'approve', input: { approvalId: 'approval-one' } });
    expect(calls[1]).toMatchObject({
      method: 'input',
      input: { answers: [{ questionId: 'question-one', value: 'integration-only' }] }
    });
  });

  test('replays from the scoped numeric SSE cursor and rejects opaque cursors', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const path = `${origin}/api/codex/sessions/${threadId}/stream?machineId=machine-one`;
    const response = await fetch(path, { headers: { 'Last-Event-ID': '6' } });
    const invalid = await fetch(path, { headers: { 'Last-Event-ID': 'event-six' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id: 7');
    expect(calls).toContainEqual({
      input: { afterSequence: 6, machineId: 'machine-one', threadId },
      method: 'stream'
    });
    expect(invalid.status).toBe(400);
  });
});

describe('Codex sessions browser client', () => {
  test('opens history read-only and receives streamed deltas', async () => {
    const { calls, service } = stubService();
    const origin = await startApi(service);
    const client = createCodexSessionsClient({ baseUrl: origin });
    expect(await client.read({ machineId: 'machine-one', threadId })).toMatchObject({
      openedReadOnly: true,
      session: { id: threadId }
    });
    expect(await client.inspect?.({ machineId: 'machine-one', threadId })).toMatchObject({
      sessionRevision: 'c'.repeat(64),
      writeCapability: { canContinue: true }
    });
    expect(await client.browser({ machineId: 'machine-one', threadId })).toMatchObject({
      machineId: 'machine-one',
      state: 'live',
      threadId
    });
    await client.browser({
      afterImageRevision: 'a'.repeat(64),
      machineId: 'machine-one',
      threadId
    });
    expect(calls).toContainEqual({
      input: { afterImageRevision: 'a'.repeat(64), machineId: 'machine-one', threadId },
      method: 'browser'
    });
    const event = await new Promise((resolve, reject) => {
      const unsubscribe = client.subscribe(
        { machineId: 'machine-one', threadId },
        (value) => {
          unsubscribe();
          resolve(value);
        },
        reject
      );
    });
    expect(event).toMatchObject({ delta: 'Streaming safely', type: 'agent-message-delta' });
  });

  test('sends the operation id as an idempotency header and surfaces safe errors', async () => {
    const seen: Array<{ body: unknown; header: string | null }> = [];
    const client = createCodexSessionsClient({
      fetchImplementation: async (_input, init) => {
        seen.push({
          body: JSON.parse(String(init?.body)),
          header: new Headers(init?.headers).get('Idempotency-Key')
        });
        return new Response(JSON.stringify({
          error: { code: 'thread_active', message: 'Wait for the active turn to finish.' }
        }), { headers: { 'Content-Type': 'application/json' }, status: 409 });
      }
    });
    await expect(client.continue({
      machineId: 'machine-one',
      message: 'Continue',
      operationId: 'operation-client-1',
      threadId
    })).rejects.toEqual(expect.objectContaining({
      code: 'thread_active',
      message: 'Wait for the active turn to finish.',
      name: 'CodexSessionsRequestError'
    } satisfies Partial<CodexSessionsRequestError>));
    expect(seen).toEqual([expect.objectContaining({ header: 'operation-client-1' })]);
  });

  test('starts at the read cursor and reconnects using the last stable event id', async () => {
    const headers: Array<string | null> = [];
    let calls = 0;
    const encoder = new TextEncoder();
    const client = createCodexSessionsClient({
      streamReconnectDelayMs: 0,
      fetchImplementation: async (_input, init) => {
        headers.push(new Headers(init?.headers).get('Last-Event-ID'));
        calls += 1;
        const eventId = `event-${calls}`;
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(
              `id: ${eventId}\nevent: session-status\ndata: ${JSON.stringify({
                eventId,
                status: 'idle',
                type: 'session-status'
              })}\n\n`
            ));
            controller.close();
          }
        }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
    });
    const seen: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = client.subscribe(
        { afterSequence: 41, machineId: 'machine-one', threadId },
        (event) => {
          seen.push(event.eventId);
          if (seen.length === 2) {
            unsubscribe();
            resolve();
          }
        },
        reject
      );
    });
    expect(seen).toEqual(['event-1', 'event-2']);
    expect(headers).toEqual(['41', 'event-1']);
  });

  test('rejects credential-bearing and insecure remote base URLs', () => {
    expect(() => createCodexSessionsClient({ baseUrl: 'https://user:pass@example.test' })).toThrow();
    expect(() => createCodexSessionsClient({ baseUrl: 'http://example.test' })).toThrow();
  });
});
