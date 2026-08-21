import { describe, expect, test } from 'bun:test';

import { presentCodexTurns } from '../server/codex-sessions/public-presenter';
import { safeTranscriptActivity } from '../server/codex-sessions/transcript-activities';

describe('Codex tool activity descriptions', () => {
  test('uses structured App Server command actions without exposing commands or output', () => {
    const turns = presentCodexTurns({
      id: 'thread-1',
      status: { type: 'idle' },
      turns: [{
        id: 'turn-1',
        items: [{
          aggregatedOutput: 'private output',
          command: 'rg --hidden secret-pattern /private/repository',
          commandActions: [{
            command: 'rg --hidden secret-pattern /private/repository',
            path: '/private/repository/server',
            query: 'tool call',
            type: 'search'
          }],
          id: 'command-1',
          status: 'completed',
          type: 'commandExecution'
        }],
        status: 'completed'
      }]
    });

    expect(turns[0]?.items[0]).toEqual(expect.objectContaining({
      detail: 'Searched for tool call',
      kind: 'command'
    }));
    expect(JSON.stringify(turns)).not.toContain('secret-pattern');
    expect(JSON.stringify(turns)).not.toContain('private output');
  });

  test('describes file changes, app actions, web searches, and delegation', () => {
    const turns = presentCodexTurns({
      id: 'thread-1',
      status: { type: 'idle' },
      turns: [{
        id: 'turn-1',
        items: [{
          changes: [
            { diff: 'private diff', kind: 'update', path: '/repo/server/reader.ts' },
            { diff: 'private diff', kind: 'add', path: '/repo/tests/reader.test.ts' }
          ],
          id: 'files-1',
          status: 'completed',
          type: 'fileChange'
        }, {
          appContext: { actionName: 'Create calendar event' },
          arguments: { private: true },
          id: 'mcp-1',
          status: 'completed',
          tool: 'create_event',
          type: 'mcpToolCall'
        }, {
          id: 'web-1',
          query: 'Codex App Server protocol',
          type: 'webSearch'
        }, {
          id: 'collab-1',
          status: 'completed',
          tool: 'spawnAgent',
          type: 'collabAgentToolCall'
        }],
        status: 'completed'
      }]
    });

    expect(turns[0]?.items.map((item) => item.detail)).toEqual([
      'Updated reader.ts, Added reader.test.ts',
      'Create calendar event',
      'Searched the web for Codex App Server protocol',
      'Delegated a task'
    ]);
    expect(JSON.stringify(turns)).not.toContain('private diff');
    expect(JSON.stringify(turns)).not.toContain('"private":true');
  });

  test('derives safe local transcript summaries from tool input', () => {
    expect(safeTranscriptActivity('custom_tool_call', {
      input: 'const r = await tools.exec_command({"cmd":"git status --short"});',
      name: 'exec'
    })).toEqual({ detail: 'Checked Git status', kind: 'command' });
    expect(safeTranscriptActivity('function_call', {
      arguments: JSON.stringify({ search_query: [{ q: 'HeroUI disclosure' }] }),
      name: 'run',
      namespace: 'web'
    })).toEqual({ detail: 'Searched the web for HeroUI disclosure', kind: 'mcp-tool' });
  });
});
