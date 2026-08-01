import type { LocalBox } from "./prototype-design-analysis";
import type { PrototypeViewportKind } from "../../../src/shared/prototype-canvas";

export type PrototypeDesignGridEdge = "bottom" | "left" | "right" | "top";
export type PrototypeDesignGridMode = "fibonacci" | "linear";

export interface PrototypeDesignFibonacciStep {
  multiplier: number;
  visible: boolean;
}

export const prototypeDesignFibonacciMultipliers = [
  1, 2, 3, 5, 8, 13, 21, 34, 55, 89,
] as const;
export const PROTOTYPE_DESIGN_DEFAULT_FIBONACCI_STEP_COUNT = 5;

export function prototypeDesignDefaultFibonacciSteps(
  count = PROTOTYPE_DESIGN_DEFAULT_FIBONACCI_STEP_COUNT,
): PrototypeDesignFibonacciStep[] {
  return prototypeDesignFibonacciMultipliers
    .slice(0, count)
    .map((multiplier, index, steps) => ({
      multiplier,
      visible: index === steps.length - 1,
    }));
}

export function prototypeDesignAddFibonacciStep(
  steps: PrototypeDesignFibonacciStep[],
) {
  const multiplier = prototypeDesignFibonacciMultipliers[steps.length];
  return multiplier ? [...steps, { multiplier, visible: true }] : steps;
}

export function prototypeDesignToggleFibonacciStep(
  steps: PrototypeDesignFibonacciStep[],
  multiplier: number,
) {
  const visibleCount = steps.filter((step) => step.visible).length;
  return steps.map((step) =>
    step.multiplier === multiplier && (!step.visible || visibleCount > 1)
      ? { ...step, visible: !step.visible }
      : step,
  );
}

export function prototypeDesignShowHighestFibonacciSteps(
  steps: PrototypeDesignFibonacciStep[],
  count: number,
) {
  const visibleCount = Math.max(1, Math.min(steps.length, Math.round(count)));
  return steps.map((step, index) => ({
    ...step,
    visible: index >= steps.length - visibleCount,
  }));
}

const prototypeDesignViewportGridCaps: Record<
  PrototypeViewportKind,
  number
> = {
  desktop: Number.POSITIVE_INFINITY,
  phone: 32,
  tablet: 96,
};

export function prototypeDesignResponsiveFibonacciSteps(
  steps: PrototypeDesignFibonacciStep[],
  base: number,
  viewport: PrototypeViewportKind,
) {
  const visibleCount = steps.filter((step) => step.visible).length;
  const cap = prototypeDesignViewportGridCaps[viewport];
  const highestEligibleIndex = steps.reduce(
    (highest, step, index) =>
      base * step.multiplier <= cap ? index : highest,
    0,
  );
  const firstVisibleIndex = Math.max(
    0,
    highestEligibleIndex - visibleCount + 1,
  );
  return steps.map((step, index) => ({
    ...step,
    visible: index >= firstVisibleIndex && index <= highestEligibleIndex,
  }));
}

export function prototypeDesignGridLevelEntries(
  base: number,
  mode: PrototypeDesignGridMode,
  fibonacciSteps = prototypeDesignDefaultFibonacciSteps(),
) {
  const steps =
    mode === "fibonacci"
      ? fibonacciSteps
      : [1, 2, 4].map((multiplier) => ({ multiplier, visible: true }));
  return steps
    .map((step, paletteIndex) => ({
      level: base * step.multiplier,
      paletteIndex,
      visible: step.visible,
    }))
    .filter((step) => step.visible);
}

export function prototypeDesignGridLevels(
  base: number,
  mode: PrototypeDesignGridMode,
  fibonacciSteps?: PrototypeDesignFibonacciStep[],
) {
  return prototypeDesignGridLevelEntries(base, mode, fibonacciSteps).map(
    (step) => step.level,
  );
}

export function prototypeDesignPrimaryGridLevel(
  base: number,
  mode: PrototypeDesignGridMode,
  fibonacciSteps?: PrototypeDesignFibonacciStep[],
) {
  return Math.max(
    base,
    ...prototypeDesignGridLevels(base, mode, fibonacciSteps),
  );
}

export function prototypeDesignFinerFibonacciSteps(
  steps: PrototypeDesignFibonacciStep[],
  parentMultiplier?: number,
) {
  const parentIndex = parentMultiplier
    ? steps.findIndex((step) => step.multiplier === parentMultiplier)
    : steps.reduce(
        (lastVisible, step, index) => (step.visible ? index : lastVisible),
        -1,
      );
  const nextIndex = Math.max(0, parentIndex - 1);
  return steps.map((step, index) => ({
    ...step,
    visible: index === nextIndex,
  }));
}

export interface PrototypeDesignGridCell {
  height: number;
  key: string;
  left: number;
  orientation: "horizontal" | "vertical";
  size: number;
  top: number;
  width: number;
}

export interface PrototypeDesignGridLayerViolation {
  box: LocalBox;
  edges: PrototypeDesignGridEdge[];
  key: string;
  label: string;
}

export interface PrototypeDesignGridAnalysis {
  cells: PrototypeDesignGridCell[];
  layers: PrototypeDesignGridLayerViolation[];
}

export type PrototypeDesignGridAxis = "both" | "columns" | "rows";

export interface PrototypeDesignGuide {
  coordinate: number;
  key: string;
  orientation: "horizontal" | "vertical";
}

export interface PrototypeDesignGuideViolation {
  box: LocalBox;
  guides: string[];
  key: string;
  label: string;
}

interface Point {
  x: number;
  y: number;
}

interface GridInspectableLayer {
  box: LocalBox;
  gridExemptEdges?: PrototypeDesignGridEdge[];
  label: string;
}

function distanceToGrid(value: number, size: number) {
  const remainder = ((value % size) + size) % size;
  return Math.min(remainder, size - remainder);
}

function edgeCoordinatesWithinBoundary(
  box: LocalBox,
  edge: PrototypeDesignGridEdge,
  boundary: LocalBox,
  tolerance: number,
) {
  const coordinates = edge === "left" || edge === "right"
    ? [box[edge] - boundary.left, boundary.right - box[edge]]
    : [box[edge] - boundary.top, boundary.bottom - box[edge]];
  if (
    (edge === "top" && Math.abs(box.bottom - boundary.bottom) <= tolerance) ||
    (edge === "bottom" && Math.abs(box.top - boundary.top) <= tolerance)
  ) {
    coordinates.push(box.height);
  }
  if (
    (edge === "left" && Math.abs(box.right - boundary.right) <= tolerance) ||
    (edge === "right" && Math.abs(box.left - boundary.left) <= tolerance)
  ) {
    coordinates.push(box.width);
  }
  return coordinates;
}

export function prototypeDesignGridEdgeOffset(
  box: LocalBox,
  edge: PrototypeDesignGridEdge,
  size: number,
  boundary?: LocalBox,
  tolerance = 0.75,
) {
  const coordinates = boundary
    ? edgeCoordinatesWithinBoundary(box, edge, boundary, tolerance)
    : [box[edge]];
  return Math.min(...coordinates.map((coordinate) => distanceToGrid(coordinate, size)));
}

export function prototypeDesignSnapPoint(
  point: Point,
  size: number,
  bounds?: { height: number; width: number },
): Point {
  if (!Number.isFinite(size) || size <= 0) return point;
  const snap = (value: number) => Math.round(value / size) * size;
  return {
    x: Math.max(
      0,
      Math.min(bounds?.width ?? Number.POSITIVE_INFINITY, snap(point.x)),
    ),
    y: Math.max(
      0,
      Math.min(bounds?.height ?? Number.POSITIVE_INFINITY, snap(point.y)),
    ),
  };
}

export function prototypeDesignGuideViolations(
  guides: PrototypeDesignGuide[],
  layers: GridInspectableLayer[],
  tolerance = 0.5,
) {
  const violations: PrototypeDesignGuideViolation[] = [];
  for (const layer of layers) {
    const crossing = guides.filter((guide) =>
      guide.orientation === "vertical"
        ? guide.coordinate > layer.box.left + tolerance &&
          guide.coordinate < layer.box.right - tolerance
        : guide.coordinate > layer.box.top + tolerance &&
          guide.coordinate < layer.box.bottom - tolerance,
    );
    if (crossing.length === 0) continue;
    violations.push({
      box: layer.box,
      guides: crossing.map((guide) => guide.key),
      key: `guide-${layer.label}-${Math.round(layer.box.left)}-${Math.round(layer.box.top)}`,
      label: layer.label,
    });
  }
  return violations;
}

function edgeCells(box: LocalBox, edge: PrototypeDesignGridEdge, size: number) {
  const vertical = edge === "left" || edge === "right";
  const coordinate = box[edge];
  const fixed = Math.floor(coordinate / size) * size;
  const start = Math.floor((vertical ? box.top : box.left) / size) * size;
  const end = Math.ceil((vertical ? box.bottom : box.right) / size) * size;
  const left = vertical ? fixed : start;
  const top = vertical ? start : fixed;
  return [
    {
      height: vertical ? end - start : size,
      key: `${size}-${left}-${top}-${vertical ? "v" : "h"}`,
      left,
      orientation: vertical ? "vertical" : "horizontal",
      size,
      top,
      width: vertical ? size : end - start,
    },
  ] satisfies PrototypeDesignGridCell[];
}

export function prototypeDesignGridAnalysis(
  layers: GridInspectableLayer[],
  sizes: number[],
  tolerance = 0.75,
  boundary?: LocalBox,
  axis: PrototypeDesignGridAxis = "both",
): PrototypeDesignGridAnalysis {
  const validSizes = [...new Set(sizes)]
    .filter((size) => Number.isFinite(size) && size > 0)
    .sort((first, second) => first - second);
  if (validSizes.length === 0) return { cells: [], layers: [] };

  const cells = new Map<string, PrototypeDesignGridCell>();
  const violations: PrototypeDesignGridLayerViolation[] = [];
  for (const layer of layers) {
    const edges = (["top", "right", "bottom", "left"] as const).filter(
      (edge) => {
        if (axis === "columns" && (edge === "top" || edge === "bottom")) {
          return false;
        }
        if (axis === "rows" && (edge === "left" || edge === "right")) {
          return false;
        }
        if (layer.gridExemptEdges?.includes(edge)) return false;
        if (boundary && Math.abs(layer.box[edge] - boundary[edge]) <= tolerance) {
          return false;
        }
        const coordinates = boundary
          ? edgeCoordinatesWithinBoundary(
              layer.box,
              edge,
              boundary,
              tolerance,
            )
          : [layer.box[edge]];
        return !validSizes.some(
          (size) =>
            coordinates.some(
              (coordinate) => distanceToGrid(coordinate, size) <= tolerance,
            ),
        );
      },
    );
    if (edges.length === 0) continue;

    violations.push({
      box: layer.box,
      edges,
      key: `${layer.label}-${Math.round(layer.box.left * 10)}-${Math.round(layer.box.top * 10)}`,
      label: layer.label,
    });
    for (const edge of edges) {
      for (const cell of edgeCells(layer.box, edge, validSizes[0])) {
        cells.set(cell.key, cell);
      }
    }
  }

  return { cells: [...cells.values()], layers: violations };
}
