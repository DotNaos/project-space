import { afterEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {}
}));
mock.module('@/shared/project-space-api', () => ({
  launcherAppLabels: {}
}));

const { initialProjectMainView, parseProjectRoute, routeForView, writeRoute } = await import(
  '../src/features/project-desktop/hooks/use-project-desktop'
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

  test('shows a direct chat route before slower project discovery finishes', () => {
    expect(initialProjectMainView('/chat')).toBe('chat');
    expect(initialProjectMainView('/projects')).toBe('root');
  });

  test('does not mistake unrelated nested paths for Project Chat', () => {
    expect(parseProjectRoute('/chatty')).toEqual({ view: 'root' });
    expect(parseProjectRoute('/chat/thread-id')).toEqual({ view: 'root' });
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
