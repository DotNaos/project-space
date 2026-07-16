import { describe, expect, test } from 'bun:test';
import type {
  ProjectChatClient,
  ProjectChatHumanProfileRecord,
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '../src/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  formatProjectChatActivity,
  projectChatIdentitySnapshot,
  projectChatMemberWithProfile,
  projectChatMessageIdentity,
  projectChatProfileUpdateRequest,
  projectChatThreadKey,
  projectChatTextSegments,
  projectChatThreadParticipants,
  projectChatThreads,
  reconcileProjectChatMemberTaskTitles,
  reconcileProjectChatMessageTaskTitles,
  shortProjectChatId,
  sortProjectChatMessages
} from '../src/features/project-chat/project-chat-model';
import {
  cursorAfterLocalSend,
  loadInitialProjectChat,
  mergeVisibleProjectChatMessages,
  readProjectChatPages,
  refreshProjectChat
} from '../src/features/project-chat/project-chat-loading';
import { isProjectChatMessageSafe } from '../src/features/project-chat/project-chat-message-safety';
import {
  createProjectChatClient,
  projectChatServerEvents,
  ProjectChatRequestError
} from '../src/api/project-chat-client';

function agent(overrides: Partial<ProjectChatMemberRecord> = {}): ProjectChatMemberRecord {
  return {
    displayName: 'Mira',
    handle: 'Mira',
    memberId: 'agent-mira',
    origin: {
      hostId: 'os-macbook',
      machineId: 'machine-1',
      taskTitle: 'Project Chat UI',
      threadId: '019f4f2b-e97e-7180-9122-4187159dbe51'
    },
    presence: {
      expiresAt: '2026-07-11T04:02:00.000Z',
      lastSeenAt: '2026-07-11T04:00:00.000Z',
      state: 'working'
    },
    role: 'agent',
    ...overrides
  };
}

function message(overrides: Partial<ProjectChatMessageRecord> = {}): ProjectChatMessageRecord {
  return {
    body: 'Project Chat is ready.',
    channelId: 'general',
    createdAt: '2026-07-11T04:00:00.000Z',
    expiresAt: '2026-07-12T04:00:00.000Z',
    id: 'message-1',
    mentions: [],
    sender: {
      displayName: 'Mira',
      handle: 'Mira',
      memberId: 'agent-mira',
      origin: agent().origin,
      role: 'agent'
    },
    sequence: 1,
    ...overrides
  };
}

function humanProfile(
  overrides: Partial<ProjectChatHumanProfileRecord> = {}
): ProjectChatHumanProfileRecord {
  return {
    avatarSource: 'custom',
    avatarUrl: 'data:image/webp;base64,current-avatar',
    defaultDisplayName: 'Olli',
    displayName: 'Olli Chat',
    handle: 'olli',
    revision: 1,
    updatedAt: '2026-07-11T04:00:00.000Z',
    ...overrides
  };
}

describe('Project Chat chronological model', () => {
  test('sorts append-only records by room sequence without mutating the input', () => {
    const messages = [
      message({ id: 'third', sequence: 3 }),
      message({ id: 'first', sequence: 1 }),
      message({ id: 'second', sequence: 2 })
    ];

    expect(sortProjectChatMessages(messages).map((entry) => entry.id)).toEqual([
      'first',
      'second',
      'third'
    ]);
    expect(messages.map((entry) => entry.id)).toEqual(['third', 'first', 'second']);
  });

  test('keeps the latest activity for each unique origin thread', () => {
    const messages = [
      message({ createdAt: '2026-07-11T04:00:00.000Z', sequence: 1 }),
      message({ createdAt: '2026-07-11T04:03:00.000Z', id: 'message-2', sequence: 2 })
    ];

    expect(projectChatThreads(messages)).toEqual([
      expect.objectContaining({
        lastActivityAt: '2026-07-11T04:03:00.000Z',
        taskTitle: 'Project Chat UI',
        threadId: '019f4f2b-e97e-7180-9122-4187159dbe51'
      })
    ]);
  });

  test('surfaces origin threads for agents who have not posted yet', () => {
    expect(projectChatThreads([], [agent()])).toEqual([
      expect.objectContaining({
        memberId: 'agent-mira',
        taskTitle: 'Project Chat UI',
        threadId: '019f4f2b-e97e-7180-9122-4187159dbe51'
      })
    ]);
  });

  test('uses the current authorized Codex title without mutating stored chat snapshots', () => {
    const storedAgent = agent({
      origin: { ...agent().origin!, taskTitle: 'Old stored title' }
    });
    const storedMessage = message({
      sender: { ...message().sender, origin: storedAgent.origin }
    });
    const titles = [{
      machineId: 'machine-1',
      threadId: storedAgent.origin!.threadId,
      title: 'Current canonical title'
    }];

    const members = reconcileProjectChatMemberTaskTitles([storedAgent], titles);
    const messages = reconcileProjectChatMessageTaskTitles([storedMessage], titles);

    expect(members[0]?.origin?.taskTitle).toBe('Current canonical title');
    expect(messages[0]?.sender.origin?.taskTitle).toBe('Current canonical title');
    expect(storedAgent.origin?.taskTitle).toBe('Old stored title');
    expect(storedMessage.sender.origin?.taskTitle).toBe('Old stored title');
  });

  test('keeps stored and honest fallback titles when no authorized task matches', () => {
    const stored = agent({ origin: { ...agent().origin!, taskTitle: 'Stored title' } });
    const untitled = agent({
      memberId: 'agent-untitled',
      origin: { ...agent().origin!, machineId: 'machine-2', taskTitle: undefined }
    });
    const reconciled = reconcileProjectChatMemberTaskTitles([stored, untitled], [{
      machineId: 'different-machine',
      threadId: stored.origin!.threadId,
      title: 'Must not leak'
    }]);

    expect(projectChatThreads([], reconciled).map((thread) => thread.taskTitle)).toEqual([
      'Stored title',
      'Untitled Codex task'
    ]);
  });

  test('keeps identical thread IDs on different machines as separate canonical tasks', () => {
    const threadId = agent().origin!.threadId;
    const first = agent({
      memberId: 'agent-first',
      origin: { ...agent().origin!, machineId: 'machine-1', taskTitle: 'First machine' }
    });
    const second = agent({
      memberId: 'agent-second',
      origin: { ...agent().origin!, machineId: 'machine-2', taskTitle: 'Second machine' }
    });
    const threads = projectChatThreads([], [first, second]);

    expect(threads).toHaveLength(2);
    expect(new Set(threads.map((thread) => thread.id))).toEqual(new Set([
      projectChatThreadKey('machine-1', threadId),
      projectChatThreadKey('machine-2', threadId)
    ]));
  });

  test('shortens thread identifiers without losing both identifying ends', () => {
    expect(shortProjectChatId('019f4f2b-e97e-7180-9122-4187159dbe51')).toBe('019f…be51');
    expect(shortProjectChatId('short-id')).toBe('short-id');
  });

  test('uses the current human profile without allowing it to rewrite agent identity', () => {
    const humanMessage = message({
      sender: {
        displayName: 'Old Human',
        handle: 'olli',
        memberId: 'human-olli',
        role: 'human'
      }
    });
    const currentHuman: ProjectChatMemberRecord = {
      avatarUrl: 'data:image/webp;base64,current-avatar',
      displayName: 'Olli Current',
      handle: 'olli',
      memberId: 'human-olli',
      presence: { lastSeenAt: humanMessage.createdAt, state: 'offline' },
      role: 'human'
    };
    expect(projectChatMessageIdentity(humanMessage, currentHuman)).toEqual({
      avatarUrl: currentHuman.avatarUrl,
      displayName: 'Olli Current',
      role: 'human'
    });
    expect(projectChatMessageIdentity(message(), {
      ...currentHuman,
      displayName: 'Fake Mira',
      memberId: 'agent-mira'
    })).toEqual({
      avatarUrl: undefined,
      displayName: 'Mira',
      role: 'agent'
    });
  });

  test('applies a refreshed human profile to the current viewer only', () => {
    const currentHuman: ProjectChatMemberRecord = {
      displayName: 'Old Human',
      handle: 'old-handle',
      memberId: 'human-olli',
      presence: { lastSeenAt: '2026-07-11T04:00:00.000Z', state: 'working' },
      role: 'human'
    };
    expect(projectChatMemberWithProfile(currentHuman, humanProfile())).toEqual({
      ...currentHuman,
      avatarUrl: 'data:image/webp;base64,current-avatar',
      displayName: 'Olli Chat',
      handle: 'olli'
    });
    expect(projectChatMemberWithProfile(agent(), humanProfile())).toEqual(agent());
  });

  test('builds initial viewer and member state from the same refreshed profile', () => {
    const staleViewer: ProjectChatMemberRecord = {
      displayName: 'Old Human',
      handle: 'old-handle',
      memberId: 'human-olli',
      presence: { lastSeenAt: '2026-07-11T04:00:00.000Z', state: 'working' },
      role: 'human'
    };
    const identity = projectChatIdentitySnapshot(
      staleViewer,
      [agent(), staleViewer],
      humanProfile({ displayName: 'New Human', handle: 'new-handle', revision: 2 })
    );

    expect(identity.viewer).toMatchObject({
      displayName: 'New Human',
      handle: 'new-handle'
    });
    expect(identity.members).toEqual([
      agent(),
      expect.objectContaining({
        displayName: 'New Human',
        handle: 'new-handle',
        memberId: 'human-olli'
      })
    ]);
  });

  test('builds avatar-only profile updates without resubmitting an untouched stale name', () => {
    expect(projectChatProfileUpdateRequest(
      humanProfile(),
      'Stale name from an older drawer render',
      false,
      null
    )).toEqual({ avatarDataUrl: null });
    expect(projectChatProfileUpdateRequest(
      humanProfile(),
      'Olli',
      true,
      undefined
    )).toEqual({ displayName: null });
  });

  test('uses current member details for thread participants while preserving agent roles', () => {
    const humanMessage = message({
      id: 'human-message',
      mentions: [{ displayName: 'Mira', handle: 'Mira', memberId: 'agent-mira' }],
      sender: {
        displayName: 'Old Human',
        handle: 'olli',
        memberId: 'human-olli',
        role: 'human'
      },
      sequence: 2
    });
    const currentHuman: ProjectChatMemberRecord = {
      avatarUrl: 'data:image/webp;base64,current-human',
      displayName: 'Current Human',
      handle: 'olli',
      memberId: 'human-olli',
      presence: { lastSeenAt: humanMessage.createdAt, state: 'offline' },
      role: 'human'
    };
    const currentAgent = agent({
      avatarUrl: 'https://example.test/agent-must-not-use-this.png',
      displayName: 'Mira Current'
    });
    const thread = projectChatThreads([message(), humanMessage])[0]!;

    expect(projectChatThreadParticipants(
      [message(), humanMessage],
      [currentAgent, currentHuman],
      thread
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        avatarUrl: undefined,
        displayName: 'Mira Current',
        memberId: 'agent-mira',
        role: 'agent'
      }),
      expect.objectContaining({
        avatarUrl: 'data:image/webp;base64,current-human',
        displayName: 'Current Human',
        memberId: 'human-olli',
        role: 'human'
      })
    ]));

    expect(projectChatThreadParticipants(
      [message()],
      [{ ...currentHuman, displayName: 'Spoofed agent', memberId: 'agent-mira' }],
      thread
    )[0]).toEqual(expect.objectContaining({
      avatarUrl: undefined,
      displayName: 'Mira',
      role: 'agent'
    }));
  });
});

describe('Project Chat trusted presence display', () => {
  test('shows working only while server evidence is fresh', () => {
    const member = agent();
    expect(effectiveProjectChatPresence(member, new Date('2026-07-11T04:01:00.000Z'))).toBe('working');
    expect(effectiveProjectChatPresence(member, new Date('2026-07-11T04:02:00.000Z'))).toBe('offline');
  });

  test('never infers active state without an expiry timestamp', () => {
    const member = agent({ presence: { lastSeenAt: '2026-07-11T04:00:00.000Z', state: 'working' } });
    expect(effectiveProjectChatPresence(member, new Date('2026-07-11T04:00:30.000Z'))).toBe('offline');
  });

  test('formats relative activity against an injected clock', () => {
    expect(
      formatProjectChatActivity(
        '2026-07-11T03:48:00.000Z',
        new Date('2026-07-11T04:00:00.000Z')
      )
    ).toBe('12m ago');
  });
});

describe('Project Chat plain-text mention rendering', () => {
  test('marks only server-resolved mention handles', () => {
    const segments = projectChatTextSegments(
      message({
        body: '@Mira please sync with @Atlas. Mira@example.com stays plain.',
        mentions: [
          { displayName: 'Mira', handle: 'Mira', memberId: 'agent-mira' },
          { displayName: 'Atlas', handle: 'Atlas', memberId: 'agent-atlas' }
        ]
      })
    );

    expect(segments.filter((segment) => segment.kind === 'mention')).toEqual([
      { kind: 'mention', memberId: 'agent-mira', value: '@Mira' },
      { kind: 'mention', memberId: 'agent-atlas', value: '@Atlas' }
    ]);
    expect(segments.map((segment) => segment.value).join('')).toBe(
      '@Mira please sync with @Atlas. Mira@example.com stays plain.'
    );
  });

  test('leaves HTML-looking input as ordinary text', () => {
    const body = '<img src=x onerror=alert(1)> @Unknown';
    expect(projectChatTextSegments(message({ body, mentions: [] }))).toEqual([
      { kind: 'text', value: body }
    ]);
  });

  test('does not highlight a resolved handle inside a longer identifier', () => {
    const segments = projectChatTextSegments(
      message({
        body: '@Mirabelle is not @Mira',
        mentions: [{ displayName: 'Mira', handle: 'Mira', memberId: 'agent-mira' }]
      })
    );

    expect(segments.filter((segment) => segment.kind === 'mention')).toEqual([
      { kind: 'mention', memberId: 'agent-mira', value: '@Mira' }
    ]);
  });
});

describe('Project Chat loading flow', () => {
  test('joins before starting membership-protected reads', async () => {
    let joined = false;
    const order: string[] = [];
    const requireMembership = (operation: string) => {
      order.push(operation);
      if (!joined) {
        throw new Error(`${operation} raced ahead of join`);
      }
    };
    const client = {
      async join() {
        order.push('join');
        await Promise.resolve();
        joined = true;
        return {
          channel: { channelId: 'general', description: 'Shared room', displayName: 'general' },
          member: agent()
        };
      },
      async getProfile() {
        requireMembership('profile');
        return {
          profile: {
            avatarSource: 'none',
            defaultDisplayName: 'Olli',
            displayName: 'Olli',
            handle: 'olli',
            updatedAt: '2026-07-11T04:00:00.000Z'
          }
        };
      },
      async listMembers() {
        requireMembership('members');
        return { members: [agent()] };
      },
      async listMentions() {
        requireMembership('mentions');
        return { channelId: 'general', messages: [], unreadCount: 0 };
      },
      async read() {
        requireMembership('read');
        return {
          afterSequence: 0,
          channelId: 'general',
          hasMore: false,
          latestSequence: 0,
          messages: [],
          nextSequence: 0
        };
      }
    } as ProjectChatClient;

    await expect(loadInitialProjectChat(client)).resolves.toEqual(
      expect.objectContaining({ joinResult: expect.objectContaining({ member: agent() }) })
    );
    expect(order[0]).toBe('join');
    expect(order.slice(1)).toEqual(expect.arrayContaining(['read', 'members', 'mentions', 'profile']));
  });

  test('refreshes the current profile together with viewer presence and room data', async () => {
    const operations: string[] = [];
    const client = {
      async getProfile() {
        operations.push('profile');
        return { profile: humanProfile({ displayName: 'Fresh Human' }) };
      },
      async listMembers() {
        operations.push('members');
        return { members: [agent()] };
      },
      async listMentions() {
        operations.push('mentions');
        return { channelId: 'general', messages: [], unreadCount: 0 };
      },
      async read() {
        operations.push('read');
        return {
          afterSequence: 0,
          channelId: 'general',
          hasMore: false,
          latestSequence: 0,
          messages: [],
          nextSequence: 0
        };
      },
      async updatePresence() {
        operations.push('presence');
        return {
          displayName: 'Old Human',
          handle: 'olli',
          memberId: 'human-olli',
          presence: { lastSeenAt: '2026-07-11T04:00:00.000Z', state: 'working' },
          role: 'human'
        } satisfies ProjectChatMemberRecord;
      }
    } as ProjectChatClient;

    const result = await refreshProjectChat(client, 'general', 0);
    expect(operations[0]).toBe('presence');
    expect(operations).toEqual(expect.arrayContaining(['read', 'members', 'mentions', 'profile']));
    expect(result.profileResult.profile.displayName).toBe('Fresh Human');
    expect(result.refreshedViewer.memberId).toBe('human-olli');
  });

  test('follows advancing cursors until every message page is loaded', async () => {
    const requestedCursors: number[] = [];
    const client = {
      async read(request: { afterSequence?: number }) {
        const afterSequence = request.afterSequence ?? 0;
        requestedCursors.push(afterSequence);
        const firstPage = afterSequence === 0;
        return {
          afterSequence,
          channelId: 'general',
          hasMore: firstPage,
          latestSequence: 2,
          messages: [message({
            id: firstPage ? 'message-1' : 'message-2',
            sequence: firstPage ? 1 : 2
          })],
          nextSequence: firstPage ? 1 : 2
        };
      }
    } as Pick<ProjectChatClient, 'read'>;

    const result = await readProjectChatPages(client, 'general', 0);
    expect(requestedCursors).toEqual([0, 1]);
    expect(result.messages.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(result.nextSequence).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  test('rejects a non-advancing server cursor instead of looping forever', async () => {
    const client = {
      async read() {
        return {
          afterSequence: 4,
          channelId: 'general',
          hasMore: true,
          latestSequence: 5,
          messages: [message({ sequence: 5 })],
          nextSequence: 4
        };
      }
    } as Pick<ProjectChatClient, 'read'>;

    await expect(readProjectChatPages(client, 'general', 4)).rejects.toThrow(
      'non-advancing message cursor'
    );
  });

  test('does not skip unseen concurrent messages after a local send', () => {
    expect(cursorAfterLocalSend(9, 10)).toBe(10);
    expect(cursorAfterLocalSend(9, 11)).toBe(9);
  });

  test('prunes expired records and bounds the rendered transcript', () => {
    const current = Array.from({ length: 505 }, (_, index) => message({
      expiresAt: '2026-07-12T04:00:00.000Z',
      id: `message-${index + 1}`,
      sequence: index + 1
    }));
    const visible = mergeVisibleProjectChatMessages(
      current,
      [message({ expiresAt: '2026-07-11T03:00:00.000Z', id: 'expired', sequence: 506 })],
      new Date('2026-07-11T04:00:00.000Z')
    );

    expect(visible).toHaveLength(500);
    expect(visible[0].sequence).toBe(6);
    expect(visible.some((entry) => entry.id === 'expired')).toBe(false);
  });

  test('jumps to a bounded recent window when a room has deep history', async () => {
    const requestedCursors: number[] = [];
    const client = {
      async read(request: { afterSequence?: number }) {
        const afterSequence = request.afterSequence ?? 0;
        requestedCursors.push(afterSequence);
        return afterSequence === 0
          ? {
              afterSequence,
              channelId: 'general',
              hasMore: true,
              latestSequence: 1_000,
              messages: [message({ sequence: 1 })],
              nextSequence: 100
            }
          : {
              afterSequence,
              channelId: 'general',
              hasMore: false,
              latestSequence: 1_000,
              messages: [message({ id: 'recent', sequence: 1_000 })],
              nextSequence: 1_000
            };
      }
    } as Pick<ProjectChatClient, 'read'>;

    const result = await readProjectChatPages(client);
    expect(requestedCursors).toEqual([0, 500]);
    expect(result.messages.map((entry) => entry.id)).toEqual(['recent']);
  });
});

describe('Project Chat client-side secret warning', () => {
  test('allows ordinary coordination messages', () => {
    expect(isProjectChatMessageSafe('The password policy should require 16 characters.')).toBe(true);
    expect(isProjectChatMessageSafe('@Mira PR #128 is ready for review.')).toBe(true);
  });

  test('blocks representative secrets without returning match details', () => {
    expect(isProjectChatMessageSafe(`github_pat_${'a'.repeat(30)}`)).toBe(false);
    expect(isProjectChatMessageSafe(`glpat-${'a'.repeat(30)}`)).toBe(false);
    expect(isProjectChatMessageSafe(`sk_live_${'a'.repeat(30)}`)).toBe(false);
    expect(isProjectChatMessageSafe(`AWS_SECRET_ACCESS_KEY=${'a'.repeat(40)}`)).toBe(false);
    expect(isProjectChatMessageSafe('password=correct-horse-battery-staple')).toBe(false);
    expect(isProjectChatMessageSafe('postgres://service:super-secret@database.internal/project')).toBe(false);
  });
});

describe('Project Chat HTTP client boundary', () => {
  test('requests only one project channel when a scope is supplied', async () => {
    let capturedUrl = '';
    const client = createProjectChatClient({
      baseUrl: 'https://projects.example.test/',
      fetchImplementation: async (input) => {
        capturedUrl = String(input);
        return Response.json({ channels: [] });
      }
    });

    await client.listChannels({ projectId: 'github:101' });
    expect(capturedUrl).toBe(
      'https://projects.example.test/api/project-chat/channels?projectId=github%3A101'
    );
  });

  test('parses fragmented server events while ignoring heartbeats', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': keep-alive\n\nid: 1\nevent: mes'));
        controller.enqueue(encoder.encode('sage\ndata: {"sequence":1}\n\n'));
        controller.close();
      }
    });

    const events = [];
    for await (const event of projectChatServerEvents(stream)) events.push(event);
    expect(events).toEqual([{ data: '{"sequence":1}', event: 'message' }]);
  });

  test('uses injected authentication and sends only the typed message request', async () => {
    let capturedBody = '';
    let capturedToken = '';
    let capturedUrl = '';
    const client = createProjectChatClient({
      authToken: 'test-session-token',
      baseUrl: 'https://projects.example.test/',
      fetchImplementation: async (input, init) => {
        capturedBody = String(init?.body);
        capturedToken = new Headers(init?.headers).get('Authorization') ?? '';
        capturedUrl = String(input);
        return new Response(JSON.stringify({ message: message() }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
    });

    await client.send({
      body: 'Ready for review.',
      channelId: 'general',
      idempotencyKey: 'request-1'
    });

    expect(capturedUrl).toBe('https://projects.example.test/api/project-chat/messages');
    expect(capturedToken).toBe('Bearer test-session-token');
    expect(JSON.parse(capturedBody)).toEqual({
      body: 'Ready for review.',
      channelId: 'general',
      idempotencyKey: 'request-1'
    });
  });

  test('updates only human profile fields without exposing identity authority', async () => {
    let capturedBody = '';
    let capturedMethod = '';
    let capturedToken = '';
    const client = createProjectChatClient({
      authToken: 'human-session-token',
      fetchImplementation: async (_input, init) => {
        capturedBody = String(init?.body);
        capturedMethod = init?.method ?? '';
        capturedToken = new Headers(init?.headers).get('Authorization') ?? '';
        return Response.json({
          member: {
            displayName: 'Olli Chat', handle: 'olli', memberId: 'human-olli',
            presence: { lastSeenAt: '2026-07-11T04:00:00.000Z', state: 'working' },
            role: 'human'
          },
          profile: {
            avatarSource: 'none', defaultDisplayName: 'Olli', displayName: 'Olli Chat',
            handle: 'olli', revision: 1, updatedAt: '2026-07-11T04:00:00.000Z'
          }
        });
      }
    });

    await client.updateProfile({ avatarDataUrl: null, displayName: 'Olli Chat' });
    expect(capturedMethod).toBe('PUT');
    expect(capturedToken).toBe('Bearer human-session-token');
    expect(JSON.parse(capturedBody)).toEqual({
      avatarDataUrl: null,
      displayName: 'Olli Chat'
    });
    expect(capturedBody).not.toContain('role');
    expect(capturedBody).not.toContain('memberId');
    expect(capturedBody).not.toContain('origin');
  });

  test('rejects credential-bearing base URLs before making a request', () => {
    expect(() => createProjectChatClient({
      baseUrl: 'https://user:password@projects.example.test'
    })).toThrow('without credentials');
  });

  test('requires HTTPS for remote servers but permits loopback development', () => {
    expect(() => createProjectChatClient({ baseUrl: 'http://projects.example.test' })).toThrow(
      'requires HTTPS'
    );
    expect(() => createProjectChatClient({ baseUrl: 'http://project-chat.localhost:45873' })).not.toThrow();
    expect(() => createProjectChatClient({ baseUrl: 'http://127.0.0.1:45873' })).not.toThrow();
    expect(() => createProjectChatClient({ baseUrl: 'http://127.evil.com' })).toThrow(
      'requires HTTPS'
    );
    expect(() => createProjectChatClient({ baseUrl: 'http://127.0.0.1.evil.com' })).toThrow(
      'requires HTTPS'
    );
  });

  test('can explicitly clear stale task metadata during a presence update', async () => {
    let capturedBody = '';
    const member = agent();
    const client = createProjectChatClient({
      fetchImplementation: async (_input, init) => {
        capturedBody = String(init?.body);
        return new Response(JSON.stringify(member), {
          headers: { 'Content-Type': 'application/json' },
          status: 200
        });
      }
    });

    await client.updatePresence({ state: 'idle', taskTitle: null });
    expect(JSON.parse(capturedBody)).toEqual({ state: 'idle', taskTitle: null });
  });

  test('preserves structured server failures without echoing request data', async () => {
    const client = createProjectChatClient({
      fetchImplementation: async () => new Response(JSON.stringify({
        error: { code: 'message_rejected', message: 'Message was not accepted.' }
      }), {
        headers: { 'Content-Type': 'application/json' },
        status: 400
      })
    });

    try {
      await client.listMembers();
      throw new Error('Expected listMembers to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectChatRequestError);
      expect((error as ProjectChatRequestError).code).toBe('message_rejected');
      expect((error as ProjectChatRequestError).status).toBe(400);
    }
  });
});
