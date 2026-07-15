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

describe('legacy Machines route canonicalization', () => {
  test('uses Settings as the only destination for machine navigation', () => {
    expect(routeForView('machines')).toBe('/settings');
    expect(routeForView('machine', 'machine:os-pc')).toBe('/settings');
    expect(routeForView('machine', 'machine:os-pc', 'terminal')).toBe('/settings');
  });

  test('parses every former Machines route as Settings', () => {
    for (const pathname of [
      '/machines',
      '/machines/',
      '/machines/machine%3Aos-pc',
      '/machines/machine%3Aos-pc/projects',
      '/machines/machine%3Aos-pc/terminal'
    ]) {
      expect(parseProjectRoute(pathname)).toEqual({ view: 'settings' });
    }

    expect(parseProjectRoute('/machineship')).toEqual({ view: 'root' });
  });

  test('starts Settings directly even when unrelated discovery data is unavailable', () => {
    expect(initialProjectMainView('/settings')).toBe('settings');
    expect(initialProjectMainView('/machines/connector-id')).toBe('settings');
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

    expect(replacedUrls).toEqual(['/settings?source=legacy#connectors']);
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
      view: 'settings'
    });
    expect(replacedUrls).toEqual(['/settings?from=history#connector']);
  });

  test('does not rewrite unrelated paths', () => {
    expect(replaceLegacyMachinesRoute('/machineship')).toBe(false);
  });
});
