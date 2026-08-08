import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

describe('Project Space entry security policy', () => {
  test('allows the review shell to read an exact pull request preview', async () => {
    const source = await readFile('index.html', 'utf8');

    expect(source).toContain(
      "connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:* https://api.clerk.com https://*.clerk.accounts.dev https://*.clerk.dev https://*.projects.os-home.net"
    );
  });
});
