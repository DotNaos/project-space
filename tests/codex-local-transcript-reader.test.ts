import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { LocalCodexTranscriptReader } from '../server/codex-sessions/transcript-reader';
import type { CodexSessionStreamEvent } from '../src/shared/codex-sessions-api';

const threadId = '019fa483-564c-7b01-9d89-5f8ef37af7d0';
const turnId = '019fabaf-9a30-7300-82f7-12e9158f92c5';
const imageDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function record(type: string, payload: Record<string, unknown>, timestamp: string) {
  return JSON.stringify({ payload, timestamp, type });
}

async function fixture(lines: string[]) {
  const root = await mkdtemp(resolve(tmpdir(), 'codex-transcript-'));
  const directory = resolve(root, '2026', '07', '29');
  await mkdir(directory, { recursive: true });
  const path = resolve(
    directory,
    `rollout-2026-07-29T10-00-00-${threadId}.jsonl`
  );
  await writeFile(path, `${lines.join('\n')}\n`);
  return { path, root };
}

describe('local Codex transcript reader', () => {
  test('confirms the exact client message persisted by the owning task', async () => {
    const clientId = 'codex:steer:confirmed-operation';
    const { root } = await fixture([
      record('session_meta', { id: threadId }, '2026-07-29T10:00:00.000Z'),
      record('event_msg', {
        turn_id: turnId,
        type: 'task_started'
      }, '2026-07-29T10:00:01.000Z'),
      record('event_msg', {
        client_id: clientId,
        message: 'Persisted text',
        type: 'user_message'
      }, '2026-07-29T10:00:02.000Z')
    ]);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });

    expect(await reader.waitForUserMessage(threadId, clientId, 100)).toBe(turnId);
    expect(await reader.waitForUserMessage(threadId, 'missing-client', 10)).toBeUndefined();
  });

  test('reads a bounded visible transcript without App Server history', async () => {
    const { root } = await fixture([
      record('session_meta', { id: threadId }, '2026-07-29T10:00:00.000Z'),
      record('event_msg', { turn_id: turnId, type: 'task_started' }, '2026-07-29T10:00:01.000Z'),
      record('response_item', {
        content: [
          { text: 'Make the connection reliable.', type: 'input_text' },
          { image_url: imageDataUrl, type: 'input_image' }
        ],
        role: 'user',
        type: 'message'
      }, '2026-07-29T10:00:01.900Z'),
      record('event_msg', {
        message: [
          '<in-app-browser-context source="ambient-ui-state">hidden context</in-app-browser-context>',
          '## My request for Codex:',
          'Make the connection reliable.'
        ].join('\n'),
        type: 'user_message'
      }, '2026-07-29T10:00:02.000Z'),
      record('event_msg', {
        message: '**Working on it.**',
        type: 'agent_message'
      }, '2026-07-29T10:00:03.000Z'),
      record('response_item', {
        call_id: 'command-1',
        input: 'do-not-render-this-command',
        name: 'exec',
        type: 'custom_tool_call'
      }, '2026-07-29T10:00:04.000Z'),
      record('response_item', {
        call_id: 'command-1',
        output: 'do-not-render-this-output',
        type: 'custom_tool_call_output'
      }, '2026-07-29T10:00:05.000Z'),
      record('response_item', {
        arguments: '{"q":"do-not-render-this-query"}',
        call_id: 'web-1',
        name: 'run',
        namespace: 'web',
        type: 'function_call'
      }, '2026-07-29T10:00:06.000Z'),
      record('response_item', {
        call_id: 'web-1',
        output: 'do-not-render-this-web-result',
        type: 'function_call_output'
      }, '2026-07-29T10:00:07.000Z'),
      record('response_item', {
        arguments: 'do-not-render-this-browser-input',
        call_id: 'browser-1',
        name: 'js',
        namespace: 'mcp__node_repl',
        type: 'function_call'
      }, '2026-07-29T10:00:08.000Z'),
      record('response_item', {
        call_id: 'browser-1',
        output: 'do-not-render-this-browser-output',
        type: 'function_call_output'
      }, '2026-07-29T10:00:07.000Z')
    ]);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });

    expect(await reader.read(threadId)).toEqual({
      active: true,
      turns: [{
        id: turnId,
        items: [
          expect.objectContaining({
            images: [
              expect.objectContaining({
                dataUrl: imageDataUrl,
                mediaType: 'image/png'
              })
            ],
            kind: 'user-message',
            status: 'completed',
            text: 'Make the connection reliable.'
          }),
          expect.objectContaining({
            kind: 'agent-message',
            status: 'in-progress',
            text: '**Working on it.**'
          }),
          expect.objectContaining({
            detail: 'Ran a command',
            kind: 'command',
            status: 'completed'
          }),
          expect.objectContaining({
            detail: 'Searched the web',
            kind: 'mcp-tool',
            status: 'completed'
          }),
          expect.objectContaining({
            detail: 'Checked the browser',
            kind: 'mcp-tool',
            status: 'completed'
          })
        ],
        startedAt: '2026-07-29T10:00:01.000Z',
        status: 'in-progress'
      }]
    });
    expect(JSON.stringify((await reader.read(threadId)).turns)).not.toContain(
      'do-not-render'
    );
  });

  test('attaches a new image to its matching steered user message', async () => {
    const { root } = await fixture([
      record('session_meta', { id: threadId }, '2026-07-29T10:00:00.000Z'),
      record('event_msg', { turn_id: turnId, type: 'task_started' }, '2026-07-29T10:00:01.000Z'),
      record('event_msg', {
        message: 'Earlier message',
        type: 'user_message'
      }, '2026-07-29T10:00:02.000Z'),
      record('response_item', {
        content: [
          { text: 'New image message', type: 'input_text' },
          {
            text: '<image name=[Image #1] path="/private/tmp/image.png">',
            type: 'input_text'
          },
          { image_url: imageDataUrl, type: 'input_image' },
          { text: '</image>', type: 'input_text' }
        ],
        role: 'user',
        type: 'message'
      }, '2026-07-29T10:00:03.000Z'),
      record('event_msg', {
        message: 'New image message',
        type: 'user_message'
      }, '2026-07-29T10:00:04.000Z')
    ]);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });

    const transcript = await reader.read(threadId);
    const userMessages = transcript.turns[0]!.items.filter(
      (item) => item.kind === 'user-message'
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).not.toHaveProperty('images');
    expect(userMessages[1]).toMatchObject({
      images: [
        expect.objectContaining({
          dataUrl: imageDataUrl,
          mediaType: 'image/png'
        })
      ],
      text: 'New image message'
    });
  });

  test('emits only appended activity and completes the floating response', async () => {
    const first = [
      record('session_meta', { id: threadId }, '2026-07-29T10:00:00.000Z'),
      record('event_msg', { turn_id: turnId, type: 'task_started' }, '2026-07-29T10:00:01.000Z')
    ];
    const { path, root } = await fixture(first);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });
    await reader.read(threadId);
    const events: CodexSessionStreamEvent[] = [];
    const controller = new AbortController();
    const watching = reader.watch(threadId, (event) => events.push(event), controller.signal);

    await Bun.sleep(50);
    await writeFile(path, `${[
      ...first,
      record('event_msg', { message: 'Live reply', type: 'agent_message' }, '2026-07-29T10:00:02.000Z'),
      record('event_msg', {
        completed_at: '2026-07-29T10:00:03.000Z',
        turn_id: turnId,
        type: 'task_complete'
      }, '2026-07-29T10:00:03.000Z')
    ].join('\n')}\n`);
    await Bun.sleep(650);
    controller.abort();
    await watching;

    expect(events.map((event) => event.type)).toEqual([
      'item',
      'item',
      'turn-completed'
    ]);
    expect(events[0]).toMatchObject({
      item: { kind: 'agent-message', status: 'in-progress', text: 'Live reply' },
      type: 'item'
    });
    expect(events[1]).toMatchObject({
      item: { kind: 'agent-message', status: 'completed', text: 'Live reply' },
      type: 'item'
    });
    expect((await reader.read(threadId)).active).toBe(false);
  });

  test('broadcasts events consumed by delivery confirmation to the live history', async () => {
    const clientId = 'codex:turn:frontend-confirmation';
    const first = [
      record('session_meta', { id: threadId }, '2026-07-29T10:00:00.000Z'),
      record('event_msg', { turn_id: turnId, type: 'task_started' }, '2026-07-29T10:00:01.000Z')
    ];
    const { path, root } = await fixture(first);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });
    await reader.read(threadId);
    const events: CodexSessionStreamEvent[] = [];
    const controller = new AbortController();
    const watching = reader.watch(threadId, (event) => events.push(event), controller.signal);

    await Bun.sleep(20);
    await writeFile(path, `${[
      ...first,
      record('event_msg', {
        client_id: clientId,
        message: 'Visible immediately after confirmation',
        type: 'user_message'
      }, '2026-07-29T10:00:02.000Z')
    ].join('\n')}\n`);

    expect(await reader.waitForUserMessage(threadId, clientId, 100)).toBe(turnId);
    controller.abort();
    await watching;

    expect(events).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({
        kind: 'user-message',
        text: 'Visible immediately after confirmation'
      }),
      type: 'item'
    }));
  });

  test('rejects a mismatched rollout identity', async () => {
    const { root } = await fixture([
      record(
        'session_meta',
        { id: '019fa483-564c-7b01-9d89-5f8ef37af7d1' },
        '2026-07-29T10:00:00.000Z'
      )
    ]);
    const reader = new LocalCodexTranscriptReader({ sessionsRoot: root });
    await expect(reader.read(threadId)).rejects.toThrow(
      'history identity could not be verified'
    );
  });
});
