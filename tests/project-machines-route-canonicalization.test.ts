import { afterEach, describe, expect, test } from 'bun:test';
import {
  initialProjectMainView,
  parseProjectNavigationRoute,
  parseProjectRoute,
  replaceLegacyMachinesRoute,
  routeForView
} from '../src/features/project-desktop/hooks/project-desktop-routing';

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

describe('Machines route canonicalization', () => {
  test('uses the dedicated Machines destination for machine navigation', () => {
    expect(routeForView('machines')).toBe('/machines');
    expect(routeForView('machine', 'machine:os-pc')).toBe('/machines');
    expect(routeForView('machine', 'machine:os-pc', 'terminal')).toBe('/machines');
  });

  test('parses the canonical and former nested Machines routes as Machines', () => {
    for (const pathname of [
      '/machines',
      '/machines/',
      '/machines/machine%3Aos-pc',
      '/machines/machine%3Aos-pc/projects',
      '/machines/machine%3Aos-pc/terminal'
    ]) {
      expect(parseProjectRoute(pathname)).toEqual({ view: 'machines' });
    }

    expect(parseProjectRoute('/machineship')).toEqual({ view: 'root' });
  });

  test('starts Machines directly even when unrelated discovery data is unavailable', () => {
    expect(initialProjectMainView('/settings')).toBe('settings');
    expect(initialProjectMainView('/machines/connector-id')).toBe('machines');
  });

  test('replace-navigates a legacy URL without losing search or hash state', () => {
    const replacedUrls: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          pushState() {
            throw new Error('Legacy Machines routes must be replaced, not pushed.');
          },
          replaceState(_state: unknown, _unused: string, url: string) {
            replacedUrls.push(url);
          }
        },
        location: {
          hash: '#connectors',
          pathname: '/machines/machine%3Aos-pc/projects',
          search: '?source=legacy'
        }
      }
    });

    expect(replaceLegacyMachinesRoute('/machines/machine%3Aos-pc/projects')).toBe(true);

    expect(replacedUrls).toEqual(['/machines?source=legacy#connectors']);
  });

  test('canonicalizes a legacy history entry while parsing browser navigation', () => {
    const replacedUrls: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        history: {
          replaceState(_state: unknown, _unused: string, url: string) {
            replacedUrls.push(url);
          }
        },
        location: {
          hash: '#connector',
          pathname: '/machines/old-machine/terminal',
          search: '?from=history'
        }
      }
    });

    expect(parseProjectNavigationRoute('/machines/old-machine/terminal')).toEqual({
      view: 'machines'
    });
    expect(replacedUrls).toEqual(['/machines?from=history#connector']);
  });

  test('does not rewrite unrelated paths', () => {
    expect(replaceLegacyMachinesRoute('/machineship')).toBe(false);
  });
});
