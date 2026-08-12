import type { IncomingMessage } from 'node:http';

import { afterEach, describe, expect, test } from 'bun:test';

import { requestPublicOrigin } from '../server/public-origin';

const originalPublicOrigin = process.env.PROJECT_SPACE_PUBLIC_ORIGIN;

afterEach(() => {
  if (originalPublicOrigin === undefined) {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;
  } else {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = originalPublicOrigin;
  }
});

function request(headers: IncomingMessage['headers'], encrypted = false) {
  return { headers, socket: { encrypted } } as IncomingMessage;
}

describe('public request origin', () => {
  test('uses an explicitly configured deployment origin', () => {
    process.env.PROJECT_SPACE_PUBLIC_ORIGIN = 'https://beta.projects.os-home.net';

    expect(requestPublicOrigin(request({ host: 'attacker.invalid' }))).toBe(
      'https://beta.projects.os-home.net'
    );
  });

  test('accepts a plain local origin and rejects unsafe forwarded hosts', () => {
    delete process.env.PROJECT_SPACE_PUBLIC_ORIGIN;

    expect(requestPublicOrigin(request({ host: '127.0.0.1:4173' }))).toBe(
      'http://127.0.0.1:4173'
    );
    expect(
      requestPublicOrigin(
        request({
          host: '127.0.0.1:4173',
          'x-forwarded-host': 'example.com/$(touch injected)',
          'x-forwarded-proto': 'https'
        })
      )
    ).toBe('https://projects.os-home.net');
  });
});
