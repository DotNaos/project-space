import { appendFile, mkdtemp, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT,
  readCodexBrowserSnapshot
} from '../server/codex-sessions/browser-snapshot-reader';

const machineId = 'machine-one';
const threadId = '019f5a78-3c4c-7082-bb45-5411be7d9b9a';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function rollout(
  records: unknown[],
  recordedThreadId = threadId,
  fileThreadId = threadId
) {
  const root = await mkdtemp(resolve(tmpdir(), 'codex-browser-snapshot-'));
  roots.push(root);
  const directory = resolve(root, '2026', '07', '15');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `rollout-2026-07-15T10-00-00-${fileThreadId}.jsonl`);
  await writeFile(path, [
    record('session_meta', { id: recordedThreadId }),
    ...records
  ].map(JSON.stringify).join('\n'));
  return root;
}

function record(type: string, payload: Record<string, unknown>, timestamp = '2026-07-15T10:00:00.000Z') {
  return { payload, timestamp, type };
}

function taskStarted(turnId = 'turn-one') {
  return record('event_msg', { type: 'task_started', turn_id: turnId });
}

function taskComplete(turnId = 'turn-one') {
  return record('event_msg', { type: 'task_complete', turn_id: turnId });
}

function browserUse(screenshot?: Record<string, unknown>) {
  return record('event_msg', {
    result: {
      Ok: {
        _meta: {
          'codex/browserUse': true,
          'codex/toolSurface': {
            kind: 'browserUse',
            ...(screenshot ? { screenshot } : {})
          }
        }
      }
    },
    type: 'mcp_tool_call_end'
  }, '2026-07-15T10:00:01.000Z');
}

function browserUseContent(mimeType: string, data: string) {
  return record('event_msg', {
    result: {
      Ok: {
        _meta: {
          'codex/browserUse': true,
          'codex/toolSurface': { backend: 'iab', browserId: 'private-runtime', kind: 'browserUse' }
        },
        content: [{ data, mimeType, type: 'image' }],
        isError: false
      }
    },
    type: 'mcp_tool_call_end'
  }, '2026-07-15T10:00:01.000Z');
}

describe('Codex browser snapshot reader', () => {
  test('bounds cached rollout paths and parsed frame state', async () => {
    const sizes: Array<{ paths: number; states: number }> = [];
    const firstThreadId = '019f5a78-3c4c-7082-bb45-000000000000';
    let firstRoot = '';
    for (let index = 0; index < CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT + 6; index += 1) {
      const cachedThreadId = `019f5a78-3c4c-7082-bb45-${index.toString(16).padStart(12, '0')}`;
      const root = await rollout([], cachedThreadId, cachedThreadId);
      if (index === 0) firstRoot = root;
      await readCodexBrowserSnapshot(machineId, cachedThreadId, {
        onCache: (current) => sizes.push(current),
        sessionsRoot: root
      });
    }

    expect(Math.max(...sizes.map((size) => size.paths))).toBe(CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT);
    expect(Math.max(...sizes.map((size) => size.states))).toBe(CODEX_BROWSER_SNAPSHOT_CACHE_LIMIT);
    const lookups: string[] = [];
    await readCodexBrowserSnapshot(machineId, firstThreadId, {
      onLookup: () => lookups.push('lookup'),
      sessionsRoot: firstRoot
    });
    expect(lookups).toEqual(['lookup']);
  });

  test('backs off repeated missing rollout hierarchy scans', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'codex-browser-snapshot-missing-'));
    roots.push(root);
    const lookups: string[] = [];
    const options = {
      onLookup: () => lookups.push('lookup'),
      sessionsRoot: root
    };

    await readCodexBrowserSnapshot(machineId, threadId, options);
    await readCodexBrowserSnapshot(machineId, threadId, options);

    expect(lookups).toEqual(['lookup']);
  });

  test('coalesces different missing task lookups into one bounded hierarchy scan', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'codex-browser-snapshot-missing-many-'));
    roots.push(root);
    const lookups: string[] = [];
    const options = {
      onLookup: () => lookups.push('lookup'),
      sessionsRoot: root
    };

    await Promise.all([
      readCodexBrowserSnapshot(machineId, '019f5a78-3c4c-7082-bb45-000000000001', options),
      readCodexBrowserSnapshot(machineId, '019f5a78-3c4c-7082-bb45-000000000002', options),
      readCodexBrowserSnapshot(machineId, '019f5a78-3c4c-7082-bb45-000000000003', options)
    ]);

    expect(lookups).toEqual(['lookup']);
  });

  test('reuses rollout lookup and reads only newly appended JSONL bytes', async () => {
    const root = await rollout([taskStarted()]);
    const path = resolve(
      root,
      '2026',
      '07',
      '15',
      `rollout-2026-07-15T10-00-00-${threadId}.jsonl`
    );
    const lookups: string[] = [];
    const reads: Array<{ end: number; start: number }> = [];
    const options = {
      onLookup: () => lookups.push('lookup'),
      onRead: ({ end, start }: { end: number; start: number }) => reads.push({ end, start }),
      sessionsRoot: root
    };

    await readCodexBrowserSnapshot(machineId, threadId, options);
    const initialSize = (await stat(path)).size;
    await appendFile(path, `\n${JSON.stringify(browserUse({
      pageUrl: 'https://example.test/private',
      url: `data:image/jpeg;base64,${Buffer.from('next-frame').toString('base64')}`
    }))}`);
    const finalSize = (await stat(path)).size;

    expect(await readCodexBrowserSnapshot(machineId, threadId, options)).toMatchObject({
      state: 'live',
      turnId: 'turn-one'
    });
    await readCodexBrowserSnapshot(machineId, threadId, options);

    expect(lookups).toEqual(['lookup']);
    expect(reads).toEqual([
      { end: initialSize - 1, start: 0 },
      { end: finalSize - 1, start: initialSize }
    ]);
  });

  test('streams rollouts larger than 128 MiB without discarding the active browser', async () => {
    const root = await rollout([taskStarted()]);
    const path = resolve(root, '2026', '07', '15', `rollout-2026-07-15T10-00-00-${threadId}.jsonl`);
    const file = await open(path, 'a');
    try {
      await file.write('\n');
      const paddingStart = (await file.stat()).size;
      await file.truncate(paddingStart + 129 * 1024 * 1024);
      await file.write(`\n${JSON.stringify(browserUse({
        pageUrl: 'https://large.example/private',
        url: `data:image/jpeg;base64,${Buffer.from('large-rollout-frame').toString('base64')}`
      }))}`);
    } finally {
      await file.close();
    }

    expect(await readCodexBrowserSnapshot(machineId, threadId, { sessionsRoot: root }))
      .toMatchObject({
        pageUrl: 'https://large.example',
        state: 'live',
        turnId: 'turn-one'
      });
  });

  test('resets cached parsing after truncation and file replacement', async () => {
    const root = await rollout([
      taskStarted(),
      browserUse({
        pageUrl: 'https://first.example/path',
        url: `data:image/jpeg;base64,${Buffer.from('first-frame').toString('base64')}`
      })
    ]);
    const path = resolve(root, '2026', '07', '15', `rollout-2026-07-15T10-00-00-${threadId}.jsonl`);
    const options = { sessionsRoot: root };
    expect(await readCodexBrowserSnapshot(machineId, threadId, options)).toMatchObject({ state: 'live' });

    await writeFile(path, [record('session_meta', { id: threadId }), taskStarted('turn-two')]
      .map(JSON.stringify).join('\n'));
    expect(await readCodexBrowserSnapshot(machineId, threadId, options)).toMatchObject({
      state: 'never-used'
    });

    await rename(path, `${path}.replaced`);
    await writeFile(path, [
      record('session_meta', { id: threadId }),
      taskStarted('turn-three'),
      browserUse({
        pageUrl: 'https://replacement.example/path',
        url: `data:image/jpeg;base64,${Buffer.from('replacement-frame').toString('base64')}`
      })
    ].map(JSON.stringify).join('\n'));
    expect(await readCodexBrowserSnapshot(machineId, threadId, options)).toMatchObject({
      pageUrl: 'https://replacement.example',
      state: 'live',
      turnId: 'turn-three'
    });
  });

  test('distinguishes never-used and loading browser states', async () => {
    const neverUsedRoot = await rollout([taskStarted()]);
    const loadingRoot = await rollout([taskStarted(), browserUse()]);

    expect(await readCodexBrowserSnapshot(machineId, threadId, {
      now: () => new Date('2026-07-15T10:00:02.000Z'),
      sessionsRoot: neverUsedRoot
    })).toEqual({
      checkedAt: '2026-07-15T10:00:02.000Z',
      machineId,
      state: 'never-used',
      threadId
    });
    expect(await readCodexBrowserSnapshot(machineId, threadId, {
      now: () => new Date('2026-07-15T10:00:02.000Z'),
      sessionsRoot: loadingRoot
    })).toMatchObject({
      machineId,
      observedAt: '2026-07-15T10:00:01.000Z',
      state: 'loading',
      threadId,
      turnId: 'turn-one'
    });
  });

  test('returns a sanitized live frame without browser runtime identifiers', async () => {
    const imageDataUrl = `data:image/jpeg;base64,${Buffer.from('safe-frame').toString('base64')}`;
    const root = await rollout([
      taskStarted(),
      browserUse({
        browserId: 'must-not-leak',
        pageUrl: 'https://example.test/private/path?token=secret',
        tabId: '42',
        url: imageDataUrl
      })
    ]);

    const result = await readCodexBrowserSnapshot(machineId, threadId, { sessionsRoot: root });

    expect(result).toMatchObject({
      imageDataUrl,
      machineId,
      pageUrl: 'https://example.test',
      state: 'live',
      threadId,
      turnId: 'turn-one'
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('tabId');
    expect(JSON.stringify(result)).not.toContain('token=secret');

    if (!result.imageRevision) throw new Error('expected image revision');
    expect(await readCodexBrowserSnapshot(machineId, threadId, {
      afterImageRevision: result.imageRevision,
      sessionsRoot: root
    })).toMatchObject({
      imageRevision: result.imageRevision,
      imageUnchanged: true,
      state: 'live'
    });
  });

  test('reads the current emitted image content shape from real Codex rollouts', async () => {
    const data = Buffer.from('emitted-frame').toString('base64');
    const root = await rollout([taskStarted(), browserUseContent('image/jpeg', data)]);

    const result = await readCodexBrowserSnapshot(machineId, threadId, { sessionsRoot: root });

    expect(result).toMatchObject({
      imageDataUrl: `data:image/jpeg;base64,${data}`,
      state: 'live',
      turnId: 'turn-one'
    });
    expect(JSON.stringify(result)).not.toContain('private-runtime');
  });

  test('preserves the final frame after its turn ends without marking it live', async () => {
    const root = await rollout([
      taskStarted(),
      browserUse({
        pageUrl: 'http://localhost:3000/project',
        url: `data:image/png;base64,${Buffer.from('ended-frame').toString('base64')}`
      }),
      taskComplete()
    ]);

    const result = await readCodexBrowserSnapshot(machineId, threadId, { sessionsRoot: root });

    expect(result).toMatchObject({
      imageDataUrl: `data:image/png;base64,${Buffer.from('ended-frame').toString('base64')}`,
      pageUrl: 'http://localhost:3000',
      state: 'ended',
      turnId: 'turn-one'
    });
  });

  test('starts each new turn with no inherited browser activity', async () => {
    const root = await rollout([
      taskStarted(),
      browserUse({
        pageUrl: 'https://first.example/path',
        url: `data:image/png;base64,${Buffer.from('first-turn').toString('base64')}`
      }),
      taskComplete(),
      taskStarted('turn-two')
    ]);

    expect(await readCodexBrowserSnapshot(machineId, threadId, { sessionsRoot: root }))
      .toMatchObject({ state: 'never-used' });
  });

  test('fails closed for malformed frames and mismatched rollout identity', async () => {
    const invalidFrameRoot = await rollout([
      taskStarted(),
      browserUse({ pageUrl: 'file:///private/data', url: 'data:text/html;base64,SGVsbG8=' })
    ]);
    const wrongIdentityRoot = await rollout([], '019f5a78-3c4c-7082-bb45-5411be7d9b9b');

    expect(await readCodexBrowserSnapshot(machineId, threadId, {
      sessionsRoot: invalidFrameRoot
    })).toMatchObject({ state: 'unavailable' });
    expect(await readCodexBrowserSnapshot(machineId, threadId, {
      sessionsRoot: wrongIdentityRoot
    })).toMatchObject({
      reason: 'The Codex task identity could not be verified.',
      state: 'unavailable'
    });
  });
});
