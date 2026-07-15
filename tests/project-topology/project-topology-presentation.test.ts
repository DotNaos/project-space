import { describe, expect, test } from 'bun:test';
import type { TopologyTranscriptItem } from '../../src/features/project-topology/project-topology-types';
import {
  orderedTopologyTranscriptItems,
  topologyBoundBrowserCapability,
  topologyBrowserPresentation,
  topologyTaskHeader,
  topologyTranscriptItemText,
  topologyTranscriptPresentation,
  topologyTranscriptPreviewItems
} from '../../src/features/project-topology/project-topology-presentation';

function item(
  id: string,
  order: number,
  kind: TopologyTranscriptItem['kind'] = 'agent-message'
): TopologyTranscriptItem {
  return {
    id,
    kind,
    order,
    text: id,
    turnId: 'turn-a',
    turnStatus: 'in-progress'
  };
}

describe('project topology presentation', () => {
  test('renders transcript items in their real turn order without mutating the source', () => {
    const source = [item('third', 2), item('first', 0), item('second', 1)];

    expect(orderedTopologyTranscriptItems(source).map(({ id }) => id)).toEqual([
      'first', 'second', 'third'
    ]);
    expect(source.map(({ id }) => id)).toEqual(['third', 'first', 'second']);
  });

  test('keeps overview previews bounded to the latest ordered real items', () => {
    const transcript = {
      checkedAt: '2026-07-14T00:00:00.000Z',
      data: [item('three', 3), item('one', 1), item('two', 2)],
      state: 'ready' as const
    };

    expect(topologyTranscriptPreviewItems(transcript, 2).map(({ id }) => id)).toEqual([
      'two', 'three'
    ]);
  });

  test('preserves stale transcript content and its evidence warning', () => {
    const presentation = topologyTranscriptPresentation({
      data: [item('safe-item', 0)],
      lastSafeAt: '2026-07-13T23:59:00.000Z',
      reason: 'The connector is offline.',
      state: 'stale'
    });

    expect(presentation).toMatchObject({
      detail: 'The connector is offline.',
      label: 'Stale transcript',
      lastSafeAt: '2026-07-13T23:59:00.000Z',
      state: 'stale'
    });
    expect(presentation.items.map(({ id }) => id)).toEqual(['safe-item']);
  });

  test('never fabricates transcript or browser content for unavailable evidence', () => {
    expect(topologyTranscriptPresentation({
      reason: 'The exact task could not be read.',
      state: 'blocked'
    })).toEqual({
      detail: 'The exact task could not be read.',
      items: [],
      label: 'Transcript unavailable',
      state: 'blocked'
    });
    expect(topologyBrowserPresentation({
      reason: 'No safe frame transport is available.',
      state: 'unavailable'
    })).toEqual({
      label: 'Browser unavailable',
      reason: 'No safe frame transport is available.',
      state: 'unavailable'
    });
  });

  test('blocks a browser capability bound to another exact task', () => {
    expect(topologyBoundBrowserCapability({
      browser: {
        checkedAt: '2026-07-14T00:00:00.000Z',
        frameUrl: '/safe/frame',
        interaction: 'read-only',
        machineId: 'machine-b',
        sessionId: 'browser-a',
        state: 'ready',
        threadId: 'thread-a',
        tools: {}
      },
      machineId: 'machine-a',
      threadId: 'thread-a'
    })).toEqual({
      checkedAt: '2026-07-14T00:00:00.000Z',
      reason: 'The browser capability does not match this exact task.',
      state: 'blocked'
    });
  });

  test('only includes issue and branch labels when the task proves them', () => {
    const header = topologyTaskHeader({
      agentLabel: 'Fayn-EVT6AF',
      branchName: undefined,
      issue: undefined,
      title: 'Stored task title'
    } as Parameters<typeof topologyTaskHeader>[0]);

    expect(header).toEqual({
      agentLabel: 'Fayn-EVT6AF',
      title: 'Stored task title'
    });
  });

  test('uses truthful kind labels only when an item has no returned text', () => {
    expect(topologyTranscriptItemText({
      ...item('status-a', 0, 'status'),
      text: '   '
    })).toBe('Status update');
  });
});
