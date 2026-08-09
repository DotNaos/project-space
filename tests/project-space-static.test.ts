import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { serveProjectSpaceStatic } from '../server/project-space-static';

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('Project Space static shell', () => {
  test('prevents framing and never caches the HTML app shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-space-static-'));
    roots.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Project Space</title>');
    const server = createServer((request, response) => {
      serveProjectSpaceStatic(response, root, new URL(request.url ?? '/', 'http://test').pathname);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/prototype-review`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  test('does not disable normal browser caching for built assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-space-static-'));
    roots.push(root);
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Project Space</title>');
    await writeFile(join(root, 'app-deadbeef.js'), 'globalThis.projectSpace = true;');
    const server = createServer((request, response) => {
      serveProjectSpaceStatic(response, root, new URL(request.url ?? '/', 'http://test').pathname);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/app-deadbeef.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBeNull();
  });
});
