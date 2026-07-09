import type { GitHistoryCommit } from '@/shared/project-space-api';

export const GRAPH_COMMIT_LIMIT = 300;
export const GRAPH_LANE_WIDTH = 14;
export const GRAPH_ROW_HEIGHT = 32;

export const gitGraphPalette = [
  '#0085d9',
  '#d9008f',
  '#00d90a',
  '#d98500',
  '#a300d9',
  '#ff4d4d',
  '#00d9cc',
  '#e138e8',
  '#f5c400',
  '#6d8cff',
  '#00b36b',
  '#ff6f00',
  '#b967ff',
  '#ff3d7f',
  '#33d6ff',
  '#9ad900'
];

export type GraphCommit = GitHistoryCommit;

export interface GitGraphRowSegment {
  color: string;
  fromColumn: number;
  half: 'top' | 'bottom' | 'full';
  isSynthetic?: boolean;
  toColumn: number;
}

export interface GitGraphRow {
  color: string;
  column: number;
  commit: GraphCommit;
  segments: GitGraphRowSegment[];
}

interface Lane {
  color: string;
  hash: string;
}

export function layoutGitGraph(
  commits: GraphCommit[],
  branchColorByTipHash: Map<string, string>
): { maxLanes: number; rows: GitGraphRow[] } {
  const lanes: Array<Lane | null> = [];
  const rows: GitGraphRow[] = [];
  let colorCursor = 0;
  let maxLanes = 1;

  function takeColor() {
    const color = gitGraphPalette[colorCursor % gitGraphPalette.length];
    colorCursor += 1;
    return color;
  }

  function firstFreeLane() {
    const index = lanes.findIndex((lane) => lane === null);
    return index === -1 ? lanes.length : index;
  }

  for (const commit of commits) {
    const waiting: number[] = [];
    lanes.forEach((lane, index) => {
      if (lane?.hash === commit.hash) {
        waiting.push(index);
      }
    });

    let column: number;
    let color: string;

    if (waiting.length > 0) {
      column = waiting[0];
      color = lanes[column]?.color ?? takeColor();
    } else {
      column = firstFreeLane();
      color = branchColorByTipHash.get(commit.hash) ?? takeColor();
      lanes[column] = { color, hash: commit.hash };
    }

    const segments: GitGraphRowSegment[] = [];
    const isNewLaneAtCommit = waiting.length === 0;

    lanes.forEach((lane, index) => {
      if (!lane) {
        return;
      }

      if (lane.hash === commit.hash) {
        if (isNewLaneAtCommit && index === column) {
          return;
        }

        segments.push({ color: lane.color, fromColumn: index, half: 'top', toColumn: column });
        return;
      }

      segments.push({ color: lane.color, fromColumn: index, half: 'full', toColumn: index });
    });

    for (const index of waiting) {
      lanes[index] = null;
    }

    const [firstParent, ...otherParents] = commit.parents;

    if (firstParent) {
      lanes[column] = { color, hash: firstParent };
      segments.push({ color, fromColumn: column, half: 'bottom', toColumn: column });
    } else {
      lanes[column] = null;
    }

    for (const parent of otherParents) {
      const existing = lanes.findIndex((lane) => lane?.hash === parent);

      if (existing >= 0) {
        segments.push({
          color: lanes[existing]?.color ?? color,
          fromColumn: column,
          half: 'bottom',
          toColumn: existing
        });
        continue;
      }

      const free = firstFreeLane();
      const parentColor = branchColorByTipHash.get(parent) ?? takeColor();
      lanes[free] = { color: parentColor, hash: parent };
      segments.push({ color: parentColor, fromColumn: column, half: 'bottom', toColumn: free });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    maxLanes = Math.max(maxLanes, lanes.length, column + 1);
    rows.push({ color, column, commit, segments });
  }

  return { maxLanes, rows };
}

export function gitGraphLaneX(column: number) {
  return column * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function localSpline(fromX: number, fromY: number, toX: number, toY: number) {
  const dy = Math.abs(toY - fromY);
  const direction = toY >= fromY ? 1 : -1;
  const k = clamp(dy * 0.42, 6, 12);

  return `M ${fromX} ${fromY} C ${fromX} ${fromY + direction * k}, ${toX} ${toY - direction * k}, ${toX} ${toY}`;
}

export function gitGraphSegmentPath(segment: GitGraphRowSegment) {
  const fromX = gitGraphLaneX(segment.fromColumn);
  const toX = gitGraphLaneX(segment.toColumn);
  const mid = GRAPH_ROW_HEIGHT / 2;

  if (segment.half === 'full') {
    return `M ${fromX} 0 L ${fromX} ${GRAPH_ROW_HEIGHT}`;
  }

  if (segment.half === 'top') {
    if (fromX === toX) {
      return `M ${fromX} 0 L ${toX} ${mid}`;
    }

    return localSpline(fromX, 0, toX, mid);
  }

  if (fromX === toX) {
    return `M ${fromX} ${mid} L ${toX} ${GRAPH_ROW_HEIGHT}`;
  }

  return localSpline(fromX, mid, toX, GRAPH_ROW_HEIGHT);
}

export function colorForBranchIndex(index: number) {
  return gitGraphPalette[index % gitGraphPalette.length];
}

export function gitGraphPreviewColumn(row: GitGraphRow, maxLanes: number) {
  const occupiedTopLanes = new Set<number>();

  for (const segment of row.segments) {
    if (segment.half !== 'top' && segment.half !== 'full') {
      continue;
    }

    occupiedTopLanes.add(segment.fromColumn);
    occupiedTopLanes.add(segment.toColumn);
  }

  if (!occupiedTopLanes.has(row.column)) {
    return row.column;
  }

  const searchLimit = Math.max(maxLanes + 2, row.column + 3);

  for (let distance = 1; distance <= searchLimit; distance += 1) {
    const right = row.column + distance;

    if (!occupiedTopLanes.has(right)) {
      return right;
    }

    const left = row.column - distance;

    if (left >= 0 && !occupiedTopLanes.has(left)) {
      return left;
    }
  }

  return Math.max(maxLanes, row.column + 1);
}

export function gitGraphPreviewPassthroughSegments(row: GitGraphRow) {
  const columns = new Map<number, string>();

  for (const segment of row.segments) {
    if (segment.half !== 'top' && segment.half !== 'full') {
      continue;
    }

    if (!columns.has(segment.fromColumn)) {
      columns.set(segment.fromColumn, segment.color);
    }
  }

  return Array.from(columns, ([column, color]) => ({ color, column }));
}

export function gitGraphPreviewEdgePath({
  childBottomY,
  childColumn,
  parentColumn,
  parentTopY
}: {
  childBottomY: number;
  childColumn: number;
  parentColumn: number;
  parentTopY: number;
}) {
  const parentX = gitGraphLaneX(parentColumn);
  const childX = gitGraphLaneX(childColumn);

  if (parentX === childX) {
    return `M ${parentX} ${parentTopY} L ${childX} ${childBottomY}`;
  }

  return localSpline(parentX, parentTopY, childX, childBottomY);
}
