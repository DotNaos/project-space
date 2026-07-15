import { describe, expect, test } from 'bun:test';
import {
  initialProjectMainView,
  parseProjectRoute,
  routeForView
} from '../../src/features/project-desktop/hooks/project-desktop-routing';

describe('project topology route', () => {
  test('folds the old topology destination into the default Home summary', () => {
    expect(routeForView('topology')).toBe('/');
    expect(parseProjectRoute('/topology')).toEqual({ view: 'root' });
    expect(parseProjectRoute('/topology/')).toEqual({ view: 'root' });
    expect(initialProjectMainView('/topology')).toBe('root');
  });

  test('does not claim unrelated topology-prefixed paths', () => {
    expect(parseProjectRoute('/topology/task-a')).toEqual({ view: 'root' });
    expect(parseProjectRoute('/topology-old')).toEqual({ view: 'root' });
  });
});
