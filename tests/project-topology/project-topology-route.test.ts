import { describe, expect, test } from 'bun:test';
import {
  initialProjectMainView,
  parseProjectRoute,
  routeForView
} from '../../src/features/project-desktop/hooks/project-desktop-routing';

describe('project topology route', () => {
  test('round-trips the dedicated topology destination', () => {
    expect(routeForView('topology')).toBe('/topology');
    expect(parseProjectRoute('/topology')).toEqual({ view: 'topology' });
    expect(parseProjectRoute('/topology/')).toEqual({ view: 'topology' });
    expect(initialProjectMainView('/topology')).toBe('topology');
  });

  test('does not claim unrelated topology-prefixed paths', () => {
    expect(parseProjectRoute('/topology/task-a')).toEqual({ view: 'root' });
    expect(parseProjectRoute('/topology-old')).toEqual({ view: 'root' });
  });
});
