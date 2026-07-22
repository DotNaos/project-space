export interface RoadmapDropNodeRect {
  bottom: number;
  issueId: number;
  left: number;
  right: number;
  top: number;
}

export interface RoadmapDropMarker {
  height: number;
  labelSide: 'left' | 'right';
  left: number;
  top: number;
}

export interface RoadmapGeometricDropTarget {
  insertionIndex: number;
  marker?: RoadmapDropMarker;
}

interface DropTargetOptions {
  graphRect: Pick<DOMRect, 'bottom' | 'height' | 'left' | 'right' | 'top' | 'width'>;
  nodeRects: readonly RoadmapDropNodeRect[];
  orderedIssueIds: readonly number[];
  point: { x: number; y: number };
  range: { maximum: number; minimum: number };
}

interface DropRow {
  bottom: number;
  centerY: number;
  nodes: RoadmapDropNodeRect[];
  top: number;
}

export function roadmapGeometricDropTarget({
  graphRect,
  nodeRects,
  orderedIssueIds,
  point,
  range
}: DropTargetOptions): RoadmapGeometricDropTarget | undefined {
  if (
    point.x < graphRect.left
    || point.x > graphRect.right
    || point.y < graphRect.top
    || point.y > graphRect.bottom
    || range.minimum > range.maximum
  ) return undefined;

  const positions = new Map(orderedIssueIds.map((issueId, index) => [issueId, index]));
  const plannedRects = nodeRects.filter((rect) => positions.has(rect.issueId));
  if (plannedRects.length === 0) {
    const prepend = point.x <= graphRect.left + graphRect.width / 2;
    return {
      insertionIndex: prepend ? range.minimum : range.maximum,
      marker: {
        height: Math.min(120, graphRect.height / 3),
        labelSide: prepend ? 'right' : 'left',
        left: Math.max(8, Math.min(graphRect.width - 8, point.x - graphRect.left)),
        top: Math.max(8, graphRect.height / 2 - 60)
      }
    };
  }

  const visiblePositions = plannedRects.flatMap((rect) => {
    const position = positions.get(rect.issueId);
    return position === undefined ? [] : [position];
  });
  const minimumVisible = Math.min(...visiblePositions);
  const maximumVisible = Math.max(...visiblePositions);
  const row = nearestDropRow(dropRows(plannedRects), point.y);
  if (!row) return undefined;
  const nodes = [...row.nodes].sort((left, right) => centerX(left) - centerX(right));
  const gaps = nodes.flatMap((node, index) => {
    const durableIndex = positions.get(node.issueId);
    if (durableIndex === undefined) return [];
    const before = index === 0
      ? [{
          insertionIndex: durableIndex === minimumVisible ? range.minimum : durableIndex,
          x: node.left - 12
        }]
      : [];
    const next = nodes[index + 1];
    const afterX = next ? (node.right + next.left) / 2 : node.right + 12;
    const afterIndex = next
      ? positions.get(next.issueId)
      : durableIndex === maximumVisible ? range.maximum : durableIndex + 1;
    return afterIndex === undefined
      ? before
      : [...before, { insertionIndex: afterIndex, x: afterX }];
  }).filter((gap) => (
    gap.insertionIndex >= range.minimum && gap.insertionIndex <= range.maximum
  ));
  const gap = gaps.sort((left, right) => (
    Math.abs(point.x - left.x) - Math.abs(point.x - right.x)
  ))[0];
  if (!gap) return undefined;

  const left = Math.max(8, Math.min(graphRect.width - 8, gap.x - graphRect.left));
  return {
    insertionIndex: gap.insertionIndex,
    marker: {
      height: row.bottom - row.top + 16,
      labelSide: left < graphRect.width / 2 ? 'right' : 'left',
      left,
      top: Math.max(8, row.top - graphRect.top - 8)
    }
  };
}

export function roadmapGraphNodeRects(
  graph: HTMLElement,
  clip?: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>
): RoadmapDropNodeRect[] {
  return [...graph.querySelectorAll<HTMLElement>('[data-roadmap-issue-id]')].flatMap((node) => {
    const issueId = Number(node.dataset.roadmapIssueId);
    if (!Number.isSafeInteger(issueId)) return [];
    const rect = node.getBoundingClientRect();
    if (clip && (
      rect.right <= clip.left
      || rect.left >= clip.right
      || rect.bottom <= clip.top
      || rect.top >= clip.bottom
    )) return [];
    return [{
      bottom: rect.bottom,
      issueId,
      left: rect.left,
      right: rect.right,
      top: rect.top
    }];
  });
}

function dropRows(rects: readonly RoadmapDropNodeRect[]) {
  const rows: DropRow[] = [];
  [...rects].sort((left, right) => centerY(left) - centerY(right)).forEach((rect) => {
    const match = rows.find((row) => verticalDistance(row, centerY(rect)) <= rect.bottom - rect.top);
    if (match) {
      match.nodes.push(rect);
      match.top = Math.min(match.top, rect.top);
      match.bottom = Math.max(match.bottom, rect.bottom);
      match.centerY = (match.top + match.bottom) / 2;
      return;
    }
    rows.push({
      bottom: rect.bottom,
      centerY: centerY(rect),
      nodes: [rect],
      top: rect.top
    });
  });
  return rows;
}

function nearestDropRow(rows: readonly DropRow[], y: number) {
  return [...rows].sort((left, right) => (
    verticalDistance(left, y) - verticalDistance(right, y)
  ))[0];
}

function verticalDistance(row: Pick<DropRow, 'bottom' | 'top'>, y: number) {
  if (y < row.top) return row.top - y;
  if (y > row.bottom) return y - row.bottom;
  return 0;
}

function centerX(rect: Pick<RoadmapDropNodeRect, 'left' | 'right'>) {
  return (rect.left + rect.right) / 2;
}

function centerY(rect: Pick<RoadmapDropNodeRect, 'bottom' | 'top'>) {
  return (rect.top + rect.bottom) / 2;
}
