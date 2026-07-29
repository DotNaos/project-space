import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { PrototypeReviewCodexImageStore } from '../server/prototype-review-codex-images';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function start(store: PrototypeReviewCodexImageStore) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (!await store.handleRequest(request, response, url)) response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return `http://127.0.0.1:${address.port}`;
}

describe('prototype review Codex images', () => {
  test('validates, stores, previews, and resolves opaque local images', async () => {
    const store = new PrototypeReviewCodexImageStore(async () => undefined);
    const origin = await start(store);
    try {
      const upload = await fetch(`${origin}/api/prototype-review/codex-images`, {
        body: image,
        headers: { 'Content-Type': 'image/png' },
        method: 'POST'
      });
      expect(upload.status).toBe(201);
      const payload = await upload.json() as { id: string; previewUrl: string };
      expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);

      const preview = await fetch(`${origin}${payload.previewUrl}`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await preview.arrayBuffer())).toEqual(image);

      const paths = await store.resolve([payload.id]);
      expect(paths).toHaveLength(1);
      expect(paths[0]).toEndWith(`${payload.id}.png`);
    } finally {
      await store.close();
    }
  });

  test('rejects unsupported bytes and authorization failures', async () => {
    const store = new PrototypeReviewCodexImageStore(async () => {
      throw new Error('not authorized');
    });
    const origin = await start(store);
    try {
      const response = await fetch(`${origin}/api/prototype-review/codex-images`, {
        body: image,
        headers: { 'Content-Type': 'image/png' },
        method: 'POST'
      });
      expect(response.status).toBe(400);
      await expect(store.resolve(['9cb4681a-52f4-4c20-8c2f-377120980ebf']))
        .rejects.toThrow('not authorized');
    } finally {
      await store.close();
    }
  });

  test('keeps pending images available across local runtime restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'project-space-codex-images-persistent-'));
    const firstStore = new PrototypeReviewCodexImageStore(
      async () => undefined,
      undefined,
      root
    );
    const firstOrigin = await start(firstStore);
    try {
      const upload = await fetch(`${firstOrigin}/api/prototype-review/codex-images`, {
        body: image,
        headers: { 'Content-Type': 'image/png' },
        method: 'POST'
      });
      expect(upload.status).toBe(201);
      const payload = await upload.json() as { id: string; previewUrl: string };
      await firstStore.close();

      const secondStore = new PrototypeReviewCodexImageStore(
        async () => undefined,
        undefined,
        root
      );
      const secondOrigin = await start(secondStore);
      try {
        const preview = await fetch(`${secondOrigin}${payload.previewUrl}`);
        expect(preview.status).toBe(200);
        expect(Buffer.from(await preview.arrayBuffer())).toEqual(image);
        expect(await secondStore.resolve([payload.id])).toEqual([
          join(root, `${payload.id}.png`)
        ]);
      } finally {
        await secondStore.close();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
