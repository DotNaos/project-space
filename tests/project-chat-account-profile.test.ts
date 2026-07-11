import { describe, expect, test } from 'bun:test';

import { createProjectChatAccountProfileReader } from '../server/project-chat/account-profile';

describe('Project Chat account profile defaults', () => {
  test('prefers normalized Clerk name and image without reading GitHub', async () => {
    let githubReads = 0;
    const read = createProjectChatAccountProfileReader({
      cacheTtlMs: 60_000,
      async readClerkProfile() {
        return {
          firstName: '  Olli ',
          imageUrl: 'https://img.clerk.test/avatar.png',
          lastName: ' Schütz  '
        };
      },
      async readGitHubToken() {
        githubReads += 1;
        return { accessToken: 'must-not-be-used' };
      }
    });

    await expect(read('user-olli')).resolves.toEqual({
      avatarUrl: 'https://img.clerk.test/avatar.png',
      defaultsResolved: true,
      displayName: 'Olli Schütz'
    });
    expect(githubReads).toBe(0);
  });

  test('uses the connected GitHub profile as a fallback and caches it briefly', async () => {
    let now = 1_000;
    let fetches = 0;
    const read = createProjectChatAccountProfileReader({
      cacheTtlMs: 100,
      fetchImplementation: (async (_input, init) => {
        fetches += 1;
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer github-token');
        return Response.json({
          avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
          login: 'schuetzoliver00',
          name: 'Oliver Schütz'
        });
      }) as typeof fetch,
      now: () => now,
      async readClerkProfile() {
        return null;
      },
      async readGitHubToken() {
        return { accessToken: 'github-token' };
      }
    });

    const expected = {
      avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4',
      defaultsResolved: true,
      displayName: 'Oliver Schütz'
    };
    await expect(read('user-olli')).resolves.toEqual(expected);
    await expect(read('user-olli')).resolves.toEqual(expected);
    expect(fetches).toBe(1);
    now += 101;
    await expect(read('user-olli')).resolves.toEqual(expected);
    expect(fetches).toBe(2);
  });

  test('drops unsafe provider values instead of failing authentication', async () => {
    const read = createProjectChatAccountProfileReader({
      async readClerkProfile() {
        return {
          firstName: 'Olli\nAdmin',
          imageUrl: 'javascript:alert(1)'
        };
      },
      async readGitHubToken() {
        return null;
      }
    });

    await expect(read('user-olli')).resolves.toEqual({
      avatarUrl: undefined,
      defaultsResolved: true,
      displayName: undefined
    });
  });

  test('marks transient provider failures unresolved instead of replacing persisted defaults', async () => {
    let now = 1_000;
    let unavailable = false;
    const read = createProjectChatAccountProfileReader({
      cacheTtlMs: 100,
      now: () => now,
      async readClerkProfile() {
        if (unavailable) {
          throw new Error('temporary Clerk outage');
        }
        return {
          firstName: 'Oliver',
          imageUrl: 'https://img.clerk.test/avatar.png',
          lastName: 'Schütz'
        };
      },
      async readGitHubToken() {
        if (unavailable) {
          throw new Error('temporary database outage');
        }
        return null;
      }
    });

    await expect(read('user-olli')).resolves.toMatchObject({
      defaultsResolved: true,
      displayName: 'Oliver Schütz'
    });
    unavailable = true;
    now += 101;
    await expect(read('user-olli')).resolves.toEqual({
      avatarUrl: undefined,
      defaultsResolved: false,
      displayName: undefined
    });
  });
});
