import { describe, expect, test } from 'bun:test';

import {
  prototypeAccessEndpoint,
  prototypeAccessTargetUrl
} from '../src/api/prototype-access-client';
import { exactPrototypeReviewReturn } from '../src/auth/project-space-auth-return';

describe('prototype review authentication return', () => {
  test('preserves the exact repository, PR, Change, surface, head, and presentation route', () => {
    const route =
      `/prototype-review?repository=DotNaos%2Fproject-space&pr=395&head=${'a'.repeat(40)}` +
      '&change=secure-live-context&surface=native&viewport=tablet&orientation=landscape&theme=dark';
    expect(exactPrototypeReviewReturn(`https://projects.os-home.net${route}`)).toBe(route);
  });

  test('rejects non-review, credentialed, invalid, and oversized return values', () => {
    expect(exactPrototypeReviewReturn('https://projects.os-home.net/')).toBe('/');
    expect(exactPrototypeReviewReturn('https://user:pass@projects.os-home.net/prototype-review'))
      .toBe('/');
    expect(exactPrototypeReviewReturn('not a url')).toBe('/');
    expect(exactPrototypeReviewReturn(
      `https://projects.os-home.net/prototype-review?change=${'x'.repeat(5_000)}`
    )).toBe('/');
  });

  test('sends viewing credentials only to the exact canonical PR prototype origin', () => {
    expect(prototypeAccessEndpoint(
      'https://pr-395.projects.os-home.net/prototype/desktop/',
      395
    )).toBe(
      'https://pr-395.projects.os-home.net/api/pull-request-previews/prototype-access'
    );
    expect(prototypeAccessEndpoint(
      'https://pr-394.projects.os-home.net/prototype/desktop/',
      395
    )).toBeUndefined();
    expect(prototypeAccessEndpoint(
      'https://attacker.example/prototype/desktop/',
      395
    )).toBeUndefined();
    expect(prototypeAccessEndpoint(
      'https://pr-395.projects.os-home.net/api/machines',
      395
    )).toBeUndefined();
  });

  test('binds the exact public Change to the protected prototype entry URL', () => {
    expect(prototypeAccessTargetUrl(
      'https://pr-395.projects.os-home.net/prototype/desktop/?viewport=desktop',
      'secure-live-context'
    )).toBe(
      'https://pr-395.projects.os-home.net/prototype/desktop/?viewport=desktop&change=secure-live-context'
    );
    expect(prototypeAccessTargetUrl(
      'https://pr-395.projects.os-home.net/prototype/desktop/',
      '../other-change'
    )).toBeUndefined();
  });
});
