import { describe, expect, test } from 'bun:test';
import type { GitHistoryCommit } from '../src/shared/project-space-api';
import {
  GRAPH_LANE_WIDTH,
  GRAPH_ROW_HEIGHT,
  gitGraphPreviewColumn,
  gitGraphPreviewEdgePath,
  gitGraphPreviewPassthroughSegments,
  gitGraphLaneX,
  gitGraphSegmentPath,
  layoutGitGraph
} from '../src/features/project-desktop/components/git-graph-layout';

function commit(hash: string, parents: string[] = []): GitHistoryCommit {
  return {
    author: 'Test',
    date: '2026-07-09',
    hash,
    parents,
    refs: [],
    subject: hash
  };
}

function controls(path: string) {
  const number = '(-?\\d+(?:\\.\\d+)?)';
  const match = new RegExp(`^M ${number} ${number} C ${number} ${number}, ${number} ${number}, ${number} ${number}$`).exec(path);

  if (!match) {
    throw new Error(`Expected cubic path, got ${path}`);
  }

  return match.slice(1).map(Number);
}

describe('git graph renderer paths', () => {
  test('renders same-lane segments as straight vertical cables', () => {
    expect(
      gitGraphSegmentPath({
        color: '#0085d9',
        fromColumn: 1,
        half: 'full',
        toColumn: 1
      })
    ).toBe(`M ${gitGraphLaneX(1)} 0 L ${gitGraphLaneX(1)} ${GRAPH_ROW_HEIGHT}`);
  });

  test('renders cross-lane top segments as local vertical-port splines', () => {
    const path = gitGraphSegmentPath({
      color: '#d9008f',
      fromColumn: 0,
      half: 'top',
      toColumn: 2
    });
    const [startX, startY, c1X, c1Y, c2X, c2Y, endX, endY] = controls(path);

    expect(startX).toBe(gitGraphLaneX(0));
    expect(startY).toBe(0);
    expect(c1X).toBe(startX);
    expect(c1Y).toBeGreaterThan(startY);
    expect(c2X).toBe(endX);
    expect(c2Y).toBeLessThan(endY);
    expect(endX).toBe(gitGraphLaneX(2));
    expect(endY).toBe(GRAPH_ROW_HEIGHT / 2);
  });

  test('renders cross-lane bottom segments as local vertical-port splines', () => {
    const path = gitGraphSegmentPath({
      color: '#d9008f',
      fromColumn: 3,
      half: 'bottom',
      toColumn: 1
    });
    const [startX, startY, c1X, c1Y, c2X, c2Y, endX, endY] = controls(path);

    expect(startX).toBe(gitGraphLaneX(3));
    expect(startY).toBe(GRAPH_ROW_HEIGHT / 2);
    expect(c1X).toBe(startX);
    expect(c1Y).toBeGreaterThan(startY);
    expect(c2X).toBe(endX);
    expect(c2Y).toBeLessThan(endY);
    expect(endX).toBe(gitGraphLaneX(1));
    expect(endY).toBe(GRAPH_ROW_HEIGHT);
  });

  test('keeps every commit on exactly one row', () => {
    const commits = [
      commit('main-tip', ['merge']),
      commit('feature-tip', ['merge']),
      commit('merge', ['main-parent', 'feature-parent']),
      commit('main-parent'),
      commit('feature-parent')
    ];

    const graph = layoutGitGraph(commits, new Map());
    const hashes = graph.rows.map((row) => row.commit.hash);

    expect(graph.rows).toHaveLength(commits.length);
    expect(new Set(hashes).size).toBe(commits.length);
  });

  test('does not draw huge arches for cross-lane cables', () => {
    const path = gitGraphSegmentPath({
      color: '#d9008f',
      fromColumn: 0,
      half: 'bottom',
      toColumn: 5
    });
    const [, startY, , c1Y, , c2Y, , endY] = controls(path);

    expect(c1Y).toBeGreaterThanOrEqual(startY);
    expect(c1Y).toBeLessThanOrEqual(endY);
    expect(c2Y).toBeGreaterThanOrEqual(startY);
    expect(c2Y).toBeLessThanOrEqual(endY);
  });

  test('keeps preview branches on the same lane when the base has no child above it', () => {
    expect(
      gitGraphPreviewColumn(
        {
          color: '#0085d9',
          column: 1,
          commit: commit('base'),
          segments: [
            {
              color: '#0085d9',
              fromColumn: 1,
              half: 'bottom',
              toColumn: 1
            }
          ]
        },
        2
      )
    ).toBe(1);
  });

  test('moves preview branches to a free lane when the base lane continues upward', () => {
    expect(
      gitGraphPreviewColumn(
        {
          color: '#0085d9',
          column: 1,
          commit: commit('base'),
          segments: [
            {
              color: '#0085d9',
              fromColumn: 1,
              half: 'top',
              toColumn: 1
            },
            {
              color: '#d9008f',
              fromColumn: 2,
              half: 'full',
              toColumn: 2
            }
          ]
        },
        3
      )
    ).toBe(0);
  });

  test('renders preview branch edges with the same local spline rule', () => {
    const path = gitGraphPreviewEdgePath({
      childBottomY: -9,
      childColumn: 0,
      parentColumn: 1,
      parentTopY: 9
    });
    const [startX, startY, c1X, c1Y, c2X, c2Y, endX, endY] = controls(path);

    expect(startX).toBe(gitGraphLaneX(1));
    expect(startY).toBe(9);
    expect(c1X).toBe(startX);
    expect(c1Y).toBeLessThan(startY);
    expect(c2X).toBe(endX);
    expect(c2Y).toBeGreaterThan(endY);
    expect(endX).toBe(gitGraphLaneX(0));
    expect(endY).toBe(-9);
  });

  test('renders only upward active lanes through the preview row', () => {
    expect(
      gitGraphPreviewPassthroughSegments({
        color: '#0085d9',
        column: 1,
        commit: commit('base'),
        segments: [
          {
            color: '#0085d9',
            fromColumn: 1,
            half: 'top',
            toColumn: 1
          },
          {
            color: '#d9008f',
            fromColumn: 2,
            half: 'full',
            toColumn: 2
          },
          {
            color: '#00d90a',
            fromColumn: 1,
            half: 'bottom',
            toColumn: 3
          }
        ]
      })
    ).toEqual([
      { color: '#0085d9', column: 1 },
      { color: '#d9008f', column: 2 }
    ]);
  });
});
