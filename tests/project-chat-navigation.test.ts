import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {},
  refreshProjectSpaceAuthToken: () => null
}));
mock.module('@/api/codex-sessions-client', () => ({
  createCodexSessionsClient: () => ({})
}));
mock.module('@/shared/project-space-api', () => ({
  launcherAppLabels: {}
}));

const { initialProjectMainView, parseProjectRoute, routeForView, writeRoute } = await import(
  '../src/features/project-desktop/hooks/use-project-desktop'
);
const { parseProjectChatRoute, projectChatRoute } = await import(
  '../src/features/project-chat/project-chat-route'
);

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, 'window');
    return;
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow
  });
});

describe('Project Chat navigation', () => {
  test('writes the canonical chat route', () => {
    expect(routeForView('chat')).toBe('/chat');
  });

  test('restores chat from canonical and trailing-slash URLs', () => {
    expect(parseProjectRoute('/chat')).toEqual({ view: 'chat' });
    expect(parseProjectRoute('/chat/')).toEqual({ view: 'chat' });
  });

  test('restores stable project-room routes without using display names', () => {
    const projectId = 'github:12345';
    expect(projectChatRoute(projectId)).toBe('/chat/projects/github%3A12345');
    expect(parseProjectChatRoute('/chat/projects/github%3A12345')).toEqual({
      matches: true,
      projectId
    });
    expect(parseProjectRoute('/chat/projects/github%3A12345')).toEqual({ view: 'chat' });
    expect(initialProjectMainView('/chat/projects/github%3A12345')).toBe('chat');
  });

  test('supports the direct project Chat tab route', () => {
    expect(routeForView('project', 'github:DotNaos/project-space', 'chat')).toBe(
      '/projects/github%3ADotNaos%2Fproject-space/chat'
    );
    expect(parseProjectRoute('/projects/github%3ADotNaos%2Fproject-space/chat')).toMatchObject({
      projectId: 'github:DotNaos/project-space',
      projectTab: 'chat',
      view: 'project'
    });
  });

  test('shows a direct chat route before slower project discovery finishes', () => {
    expect(initialProjectMainView('/chat')).toBe('chat');
    expect(initialProjectMainView('/projects')).toBe('root');
  });

  test('does not mistake unrelated nested paths for Project Chat', () => {
    expect(parseProjectRoute('/chatty')).toEqual({ view: 'root' });
    expect(parseProjectRoute('/chat/thread-id')).toEqual({ view: 'root' });
    expect(parseProjectChatRoute('/chat/projects/id/extra').matches).toBe(false);
  });

  test('pushes chat into browser history without losing search or hash state', () => {
    const pushedUrls: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          pushState(_state: unknown, _unused: string, url: string) {
            pushedUrls.push(url);
          },
          replaceState() {
            throw new Error('The chat route should be pushed, not replaced.');
          }
        },
        location: {
          hash: '#agents',
          pathname: '/',
          search: '?projectSpaceApi=http%3A%2F%2F127.0.0.1%3A45873'
        }
      }
    });

    writeRoute('chat');

    expect(pushedUrls).toEqual([
      '/chat?projectSpaceApi=http%3A%2F%2F127.0.0.1%3A45873#agents'
    ]);
  });
});
