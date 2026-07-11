import { describe, expect, test } from 'bun:test';
import {
  PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS,
  PROJECT_CHAT_DEFAULT_RETENTION_MS,
  ProjectChatError,
  type ProjectChatContext,
  type ProjectChatIdGenerator
} from '../server/project-chat/contracts';
import { InMemoryProjectChatRepository } from '../server/project-chat/memory-store';
import type { ProjectChatRepository } from '../server/project-chat/repository';
import { ProjectChatService } from '../server/project-chat/service';

class TestClock {
  constructor(private timeMs = Date.parse('2026-07-11T00:00:00.000Z')) {}

  now() {
    return new Date(this.timeMs);
  }

  advance(milliseconds: number) {
    this.timeMs += milliseconds;
  }
}

function sequentialIds(): ProjectChatIdGenerator {
  let id = 0;
  return { next: (kind) => `${kind}-${++id}` };
}

const humanContext: ProjectChatContext = {
  spaceId: 'space-test',
  actor: {
    kind: 'human',
    accountId: 'account-olli',
    displayName: 'Olli',
    handle: 'olli'
  }
};

const testThreadIds: Record<string, string> = {
  mira: '019f4f2b-e97e-7180-9122-4187159dbe51',
  one: '019f4b93-5703-7692-ad6e-101e32fc4be0',
  two: '019f4efa-04e9-7231-b599-6e8d18e7f4d1'
};

function agentContext(name: string): ProjectChatContext {
  const slug = name.toLowerCase();
  return {
    spaceId: 'space-test',
    actor: {
      kind: 'agent',
      accountId: 'account-olli',
      machineId: `machine-${slug}`,
      hostId: `host-${slug}`,
      threadId: testThreadIds[slug] ?? '019f49e1-cc3d-7243-bc12-75c74c786457'
    }
  };
}

const systemContext: ProjectChatContext = {
  spaceId: 'space-test',
  actor: {
    kind: 'system',
    serviceId: 'project-space',
    displayName: 'Project Space',
    handle: 'project-space'
  }
};

function setup(options: {
  sendLimit?: number;
  repository?: ProjectChatRepository;
} = {}) {
  const clock = new TestClock();
  const repository = options.repository ?? new InMemoryProjectChatRepository();
  const service = new ProjectChatService({
    repository,
    clock,
    idGenerator: sequentialIds(),
    rateLimits: options.sendLimit === undefined
      ? undefined
      : { send: { limit: options.sendLimit, windowMs: 60_000 } }
  });
  return { clock, repository, service };
}

async function expectCode(promise: Promise<unknown>, code: ProjectChatError['code']) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProjectChatError);
    expect((error as ProjectChatError).code).toBe(code);
    return error as ProjectChatError;
  }
  throw new Error(`Expected ProjectChatError ${code}.`);
}

describe('Project Chat service identity and membership', () => {
  test('derives human, agent, and system roles from trusted actors', async () => {
    const { service } = setup();
    const human = await service.join(humanContext);
    const miraContext = agentContext('mira');
    const agent = await service.join(miraContext, {
      displayName: 'Mira',
      taskTitle: 'Build Project Chat'
    });
    const system = await service.join(systemContext);

    expect(human.member).toMatchObject({ displayName: 'Olli', handle: 'olli', role: 'human' });
    expect(agent.member).toMatchObject({
      displayName: 'Mira',
      handle: 'mira',
      role: 'agent',
      origin: {
        hostId: 'host-mira',
        machineId: 'machine-mira',
        threadId: testThreadIds.mira,
        taskTitle: 'Build Project Chat'
      }
    });
    expect(system.member).toMatchObject({ role: 'system', handle: 'project-space' });
    expect(agent.channel).toEqual({
      channelId: 'general',
      displayName: 'General',
      description: 'Human and agent coordination',
      createdAt: '2026-07-11T00:00:00.000Z'
    });
  });

  test('rejects client attempts to set authority metadata', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await expectCode(service.join(context, {
      displayName: 'Mira',
      role: 'human',
      accountId: 'victim',
      hostId: 'other-host'
    } as never), 'invalid_request');

    await service.join(context, { displayName: 'Mira' });
    await expectCode(service.sendMessage(context, {
      body: 'hello',
      idempotencyKey: 'authority-attempt',
      role: 'human',
      sender: { displayName: 'Olli' }
    } as never), 'invalid_request');
  });

  test('rejects a non-Codex or secret-shaped cooperative thread identifier', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await expectCode(service.join({
      ...context,
      actor: {
        ...context.actor,
        threadId: 'glpat-012345678901234567890123456789'
      }
    } as ProjectChatContext, { displayName: 'Mira' }), 'invalid_request');
  });

  test('requires membership in the exact server-derived space', async () => {
    const { service } = setup();
    await service.join(humanContext);
    const otherSpace = { ...humanContext, spaceId: 'space-other' };

    await expectCode(service.sendMessage(otherSpace, {
      body: 'hello',
      idempotencyKey: 'not-member'
    }), 'not_member');
    await expectCode(service.readMessages(otherSpace), 'not_member');
    await expectCode(service.listMembers(otherSpace), 'not_member');
    await expectCode(service.getMentionState(otherSpace), 'not_member');
  });

  test('keeps mention handles unique across different actors', async () => {
    const { service } = setup();
    await service.join(agentContext('one'), { displayName: 'Mira' });
    await expectCode(
      service.join(agentContext('two'), { displayName: 'MIRA' }),
      'name_conflict'
    );
  });
});

describe('Project Chat service messages and cursors', () => {
  test('resolves mentions, reads without implicit acknowledgement, then persists ack', async () => {
    const { service } = setup();
    await service.join(humanContext);
    const miraContext = agentContext('mira');
    await service.join(miraContext, { displayName: 'Mira' });

    const message = await service.sendMessage(miraContext, {
      body: 'Ready for @OLLI, not @unknown.',
      idempotencyKey: 'mention-1'
    });
    expect(message.sequence).toBe(1);
    expect(message.sender).toMatchObject({ role: 'agent', handle: 'mira' });
    expect(message.mentions).toEqual([
      expect.objectContaining({ displayName: 'Olli', handle: 'olli' })
    ]);

    expect((await service.getMentionState(humanContext)).unreadCount).toBe(1);
    const firstRead = await service.readMessages(humanContext);
    const repeatedRead = await service.readMessages(humanContext);
    expect(firstRead.messages).toEqual([message]);
    expect(repeatedRead.messages).toEqual([message]);
    expect(firstRead.nextSequence).toBe(1);

    expect(await service.acknowledge(humanContext, {
      throughSequence: firstRead.nextSequence
    })).toMatchObject({ channelId: 'general', sequence: 1 });
    expect((await service.readMessages(humanContext)).messages).toEqual([]);
    expect((await service.getMentionState(humanContext)).unreadCount).toBe(0);
    expect((await service.readMessages(humanContext, { afterSequence: 0 })).messages).toEqual([message]);
  });

  test('deduplicates retries and rejects key reuse with different content', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    const first = await service.sendMessage(context, {
      body: 'same',
      idempotencyKey: 'same-key'
    });
    const retry = await service.sendMessage(context, {
      body: 'same',
      idempotencyKey: 'same-key'
    });
    expect(retry).toEqual(first);
    await expectCode(service.sendMessage(context, {
      body: 'different',
      idempotencyKey: 'same-key'
    }), 'idempotency_conflict');
    expect((await service.readMessages(context, { afterSequence: 0 })).messages).toHaveLength(1);
  });

  test('deduplicates concurrent retries using one idempotency key', async () => {
    const { service } = setup({ sendLimit: 200 });
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    const sent = await Promise.all(Array.from({ length: 20 }, () => service.sendMessage(context, {
      body: 'one logical message',
      idempotencyKey: 'concurrent-retry'
    })));
    expect(new Set(sent.map((message) => message.id)).size).toBe(1);
    expect(new Set(sent.map((message) => message.sequence))).toEqual(new Set([1]));
    expect((await service.readMessages(context, { afterSequence: 0 })).messages).toHaveLength(1);
  });

  test('keeps all 100 concurrent sends unique and monotonically ordered', async () => {
    const { service } = setup({ sendLimit: 200 });
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    const sent = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      service.sendMessage(context, {
        body: `message ${index}`,
        idempotencyKey: `concurrent-${index}`
      })));
    const sequences = sent.map((message) => message.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
    expect(new Set(sent.map((message) => message.id)).size).toBe(100);

    const read = await service.readMessages(context, { afterSequence: 0, limit: 100 });
    expect(read.messages.map((message) => message.sequence)).toEqual(sequences);
    expect(read.latestSequence).toBe(100);
    expect(read.hasMore).toBe(false);
  });

  test('paginates by sequence and refuses acknowledgements beyond the channel head', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    for (let index = 1; index <= 3; index += 1) {
      await service.sendMessage(context, {
        body: `page ${index}`,
        idempotencyKey: `page-${index}`
      });
    }

    const firstPage = await service.readMessages(context, { afterSequence: 0, limit: 2 });
    expect(firstPage.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(firstPage).toMatchObject({ hasMore: true, latestSequence: 3, nextSequence: 2 });
    await service.acknowledge(context, { throughSequence: firstPage.nextSequence });
    const secondPage = await service.readMessages(context);
    expect(secondPage.messages.map((message) => message.sequence)).toEqual([3]);
    expect(secondPage).toMatchObject({ hasMore: false, nextSequence: 3 });
    await expectCode(service.acknowledge(context, { throughSequence: 4 }), 'cursor_out_of_range');
  });

  test('stores plain text only and normalizes line endings', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    const message = await service.sendMessage(context, {
      body: '<strong>literal text</strong>\r\nnext line',
      idempotencyKey: 'plain-text'
    });
    expect(message.body).toBe('<strong>literal text</strong>\nnext line');
  });

  test('rejects unsupported channels, control characters, and oversized bodies', async () => {
    const { service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    await expectCode(service.sendMessage(context, {
      channelId: 'private',
      body: 'hello',
      idempotencyKey: 'wrong-channel'
    }), 'invalid_request');
    await expectCode(service.sendMessage(context, {
      body: 'hello\u0000world',
      idempotencyKey: 'control-character'
    }), 'invalid_request');
    await expectCode(service.sendMessage(context, {
      body: 'x'.repeat(4_001),
      idempotencyKey: 'too-large'
    }), 'invalid_request');
  });
});

describe('Project Chat service lifecycle and abuse protection', () => {
  test('rejects invalid rate-limit configuration', () => {
    expect(() => new ProjectChatService({
      repository: new InMemoryProjectChatRepository(),
      rateLimits: { send: { limit: 0, windowMs: -1 } }
    })).toThrow('send rate limit must use positive integer values');
  });

  test('marks stale presence offline and accepts bounded agent task updates', async () => {
    const { clock, service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira', taskTitle: 'Initial task' });
    const idle = await service.updatePresence(context, {
      state: 'idle',
      taskTitle: 'Waiting for main'
    });
    expect(idle).toMatchObject({
      origin: { taskTitle: 'Waiting for main' },
      presence: { state: 'idle' }
    });

    const cleared = await service.updatePresence(context, { state: 'working', taskTitle: null });
    expect(cleared.origin?.taskTitle).toBeUndefined();

    clock.advance(PROJECT_CHAT_DEFAULT_PRESENCE_TTL_MS + 1);
    const [stale] = await service.listMembers(context);
    expect(stale.presence.state).toBe('offline');
    expect(stale.presence.lastSeenAt).toBe('2026-07-11T00:00:00.000Z');
  });

  test('filters and purges expired messages while preserving channel sequence', async () => {
    const { clock, repository, service } = setup();
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    await service.sendMessage(context, { body: 'temporary', idempotencyKey: 'retained-key' });
    clock.advance(PROJECT_CHAT_DEFAULT_RETENTION_MS + 1);

    const read = await service.readMessages(context, { afterSequence: 0 });
    expect(read.messages).toEqual([]);
    expect(read.latestSequence).toBe(1);
    expect(read.nextSequence).toBe(1);
    expect((await (repository as InMemoryProjectChatRepository).snapshot()).messages).toEqual([]);

    const replacement = await service.sendMessage(context, {
      body: 'temporary',
      idempotencyKey: 'retained-key'
    });
    expect(replacement.sequence).toBe(2);
  });

  test('rate limits sends with a deterministic retry interval', async () => {
    const { clock, service } = setup({ sendLimit: 2 });
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    await service.sendMessage(context, { body: 'one', idempotencyKey: 'limit-1' });
    await service.sendMessage(context, { body: 'two', idempotencyKey: 'limit-2' });
    const error = await expectCode(service.sendMessage(context, {
      body: 'three',
      idempotencyKey: 'limit-3'
    }), 'rate_limited');
    expect(error.retryAfterMs).toBe(60_000);

    clock.advance(60_000);
    await expect(service.sendMessage(context, {
      body: 'after window',
      idempotencyKey: 'limit-4'
    })).resolves.toMatchObject({ sequence: 3 });
  });

  test('rate limits join and presence renewal independently', async () => {
    const clock = new TestClock();
    const service = new ProjectChatService({
      repository: new InMemoryProjectChatRepository(),
      clock,
      idGenerator: sequentialIds(),
      rateLimits: {
        join: { limit: 1, windowMs: 60_000 },
        presence: { limit: 1, windowMs: 60_000 }
      }
    });
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    await expectCode(service.join(context, { displayName: 'Mira' }), 'rate_limited');

    await service.updatePresence(context, { state: 'working' });
    await expectCode(
      service.updatePresence(context, { state: 'idle' }),
      'rate_limited'
    );
  });

  test('cannot reset machine rate limits by rotating the cooperative thread ID', async () => {
    const clock = new TestClock();
    const service = new ProjectChatService({
      repository: new InMemoryProjectChatRepository(),
      clock,
      idGenerator: sequentialIds(),
      rateLimits: { join: { limit: 1, windowMs: 60_000 } }
    });
    const first = agentContext('mira');
    const rotated = {
      ...first,
      actor: { ...first.actor, threadId: '019f49e1-cc3d-7243-bc12-75c74c786457' }
    } as ProjectChatContext;
    await service.join(first, { displayName: 'Mira' });
    await expectCode(service.join(rotated, { displayName: 'Nova' }), 'rate_limited');
  });

  test('malformed send attempts consume the same abuse quota', async () => {
    const { service } = setup({ sendLimit: 1 });
    const context = agentContext('mira');
    await service.join(context, { displayName: 'Mira' });
    await expectCode(service.sendMessage(context, {
      body: '', idempotencyKey: 'invalid-first'
    }), 'invalid_request');
    await expectCode(service.sendMessage(context, {
      body: 'valid second attempt', idempotencyKey: 'valid-second'
    }), 'rate_limited');
  });

  test('rejects suspected secrets in agent metadata before persistence', async () => {
    const { repository, service } = setup();
    const secret = `github_pat_${'a'.repeat(30)}`;
    await expectCode(service.join(agentContext('mira'), {
      displayName: 'Mira', taskTitle: secret
    }), 'content_rejected');
    expect((await (repository as InMemoryProjectChatRepository).snapshot()).members).toEqual([]);
  });

  test('rejects suspected secrets generically before any repository call', async () => {
    const store = new InMemoryProjectChatRepository();
    let repositoryCalls = 0;
    const counted = new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          repositoryCalls += 1;
          return value.apply(target, args);
        };
      }
    }) as ProjectChatRepository;
    const { service } = setup({ repository: counted });
    const secret = `github_pat_${'a'.repeat(30)}`;
    const error = await expectCode(service.sendMessage(agentContext('mira'), {
      body: secret,
      idempotencyKey: 'secret-attempt'
    }), 'content_rejected');

    expect(repositoryCalls).toBe(0);
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('GitHub');
  });
});
