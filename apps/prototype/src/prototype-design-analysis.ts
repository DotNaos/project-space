const EDGE_ALIGNMENT_TOLERANCE = 0.5;

export type PrototypeDesignUnit = "grid" | "px" | "rem";

export interface LocalBox {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
}

export interface MeasuredElement {
  box: LocalBox;
  edges: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
  gridExemptEdges?: Array<"bottom" | "left" | "right" | "top">;
  label: string;
}

export interface PrototypeDesignInspection {
  active: LocalBox;
  anchors: MeasuredElement[];
  approved: MeasuredElement[];
  inner: MeasuredElement | null;
  label: string;
  target: LocalBox;
}

export interface PrototypeDesignPixelMeasurement {
  end: { x: number; y: number };
  start: { x: number; y: number };
}

export interface PrototypeDesignCollisionRegion {
  height: number;
  key: string;
  kind: "boundary-overflow" | "edge-overhang" | "line-intersection";
  label: string;
  left: number;
  top: number;
  width: number;
}

export interface PrototypeDesignAlignmentRegion {
  height: number;
  key: string;
  kind: "box" | "edge";
  left: number;
  orientation?: "horizontal" | "vertical";
  top: number;
  width: number;
}

function compactNumber(value: number) {
  return String(Math.round(value * 100) / 100);
}

export function formatPrototypeDesignMeasurement(
  pixels: number,
  gridSize: number,
  unit: PrototypeDesignUnit,
  rootFontSize = 16,
) {
  if (unit === "px") return `${compactNumber(pixels)}px`;
  if (unit === "rem") {
    return `${compactNumber(pixels / rootFontSize)}rem`;
  }
  return `${compactNumber(pixels / gridSize)} grid`;
}

function boxesMatch(first: LocalBox, second: LocalBox) {
  return (
    Math.abs(first.left - second.left) < 1 &&
    Math.abs(first.right - second.right) < 1 &&
    Math.abs(first.top - second.top) < 1 &&
    Math.abs(first.bottom - second.bottom) < 1
  );
}

function containsBox(container: LocalBox, inner: LocalBox) {
  return (
    container.left <= inner.left + 1 &&
    container.right >= inner.right - 1 &&
    container.top <= inner.top + 1 &&
    container.bottom >= inner.bottom - 1
  );
}

function overlapsBox(first: LocalBox, second: LocalBox) {
  return !(
    first.right <= second.left + 1 ||
    first.left >= second.right - 1 ||
    first.bottom <= second.top + 1 ||
    first.top >= second.bottom - 1
  );
}

function boxDistance(first: LocalBox, second: LocalBox) {
  const horizontal = Math.max(
    first.left - second.right,
    second.left - first.right,
    0,
  );
  const vertical = Math.max(
    first.top - second.bottom,
    second.top - first.bottom,
    0,
  );
  return Math.hypot(horizontal, vertical);
}

export function prototypeDesignApprovedBounds(
  target: LocalBox,
  approved: LocalBox[],
): LocalBox {
  let left = target.left;
  let right = target.right;
  let top = target.top;
  let bottom = target.bottom;
  const horizontalEdgeRange = Math.max(32, target.width * 0.12);
  const verticalEdgeRange = Math.max(32, target.height * 0.12);

  for (const box of approved) {
    const coversWidth = box.width >= target.width * 0.5;
    const coversHeight = box.height >= target.height * 0.5;

    if (coversWidth && box.bottom >= target.bottom - verticalEdgeRange) {
      bottom = Math.min(bottom, box.top);
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (coversWidth && box.top <= target.top + verticalEdgeRange) {
      top = Math.max(top, box.bottom);
      left = Math.max(left, box.left);
      right = Math.min(right, box.right);
    }
    if (coversHeight && box.left <= target.left + horizontalEdgeRange) {
      left = Math.max(left, box.right);
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    if (coversHeight && box.right >= target.right - horizontalEdgeRange) {
      right = Math.min(right, box.left);
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
  }

  if (right <= left || bottom <= top) return target;
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
  };
}

export function prototypeDesignUnapprovedAnchors(
  anchors: MeasuredElement[],
  active: LocalBox,
  approved: LocalBox[],
) {
  return anchors.filter(
    (anchor) =>
      (overlapsBox(active, anchor.box) ||
        boxDistance(active, anchor.box) <= 64) &&
      !approved.some((approvedBox) => boxesMatch(approvedBox, anchor.box)),
  );
}

export function prototypeDesignBoundaryCollisionRegions(
  active: LocalBox,
  anchors: MeasuredElement[],
): PrototypeDesignCollisionRegion[] {
  return anchors.flatMap((anchor) => {
    const box = anchor.box;
    if (containsBox(box, active) || containsBox(active, box)) return [];
    const exceedsBoundary =
      box.left < active.left - EDGE_ALIGNMENT_TOLERANCE ||
      box.right > active.right + EDGE_ALIGNMENT_TOLERANCE ||
      box.top < active.top - EDGE_ALIGNMENT_TOLERANCE ||
      box.bottom > active.bottom + EDGE_ALIGNMENT_TOLERANCE;
    if (!exceedsBoundary || boxDistance(active, box) > 64) return [];
    return [
      {
        height: box.height,
        key: `boundary-${anchor.label}-${Math.round(box.left)}-${Math.round(box.top)}`,
        kind: "boundary-overflow" as const,
        label: "boundary",
        left: box.left,
        top: box.top,
        width: box.width,
      },
    ];
  });
}

function edgesAlign(first: number, second: number) {
  return Math.abs(first - second) <= EDGE_ALIGNMENT_TOLERANCE;
}

export function prototypeDesignAlignmentRegions(
  inner: LocalBox,
  anchors: MeasuredElement[],
): PrototypeDesignAlignmentRegion[] {
  const regions = new Map<string, PrototypeDesignAlignmentRegion>();
  const addBox = (box: LocalBox) => {
    const key = `box-${Math.round(box.left * 10)}-${Math.round(box.top * 10)}-${Math.round(box.width * 10)}-${Math.round(box.height * 10)}`;
    regions.set(key, {
      height: box.height,
      key,
      kind: "box",
      left: box.left,
      top: box.top,
      width: box.width,
    });
  };
  const addVertical = (left: number, box: LocalBox) => {
    const key = `edge-vertical-${Math.round(left * 10)}-${Math.round(box.top * 10)}-${Math.round(box.height * 10)}`;
    regions.set(key, {
      height: box.height,
      key,
      kind: "edge",
      left: left - 1,
      orientation: "vertical",
      top: box.top,
      width: 2,
    });
  };
  const addHorizontal = (top: number, box: LocalBox) => {
    const key = `edge-horizontal-${Math.round(top * 10)}-${Math.round(box.left * 10)}-${Math.round(box.width * 10)}`;
    regions.set(key, {
      height: 2,
      key,
      kind: "edge",
      left: box.left,
      orientation: "horizontal",
      top: top - 1,
      width: box.width,
    });
  };

  for (const anchor of anchors) {
    const box = anchor.box;
    if (boxesMatch(box, inner)) continue;

    const hasAlignment =
      edgesAlign(box.left, inner.left) ||
      edgesAlign(box.right, inner.right) ||
      edgesAlign(box.top, inner.top) ||
      edgesAlign(box.bottom, inner.bottom);
    if (!hasAlignment) continue;

    addBox(box);
    addBox(inner);

    if (edgesAlign(box.left, inner.left)) {
      addVertical(inner.left, box);
      addVertical(inner.left, inner);
    }
    if (edgesAlign(box.right, inner.right)) {
      addVertical(inner.right, box);
      addVertical(inner.right, inner);
    }
    if (edgesAlign(box.top, inner.top)) {
      addHorizontal(inner.top, box);
      addHorizontal(inner.top, inner);
    }
    if (edgesAlign(box.bottom, inner.bottom)) {
      addHorizontal(inner.bottom, box);
      addHorizontal(inner.bottom, inner);
    }
  }

  return [...regions.values()];
}

export function prototypeDesignCollisionRegions(
  inner: LocalBox,
  anchors: MeasuredElement[],
): PrototypeDesignCollisionRegion[] {
  const regions = new Map<string, PrototypeDesignCollisionRegion>();
  const add = (
    edge: string,
    kind: PrototypeDesignCollisionRegion["kind"],
    left: number,
    top: number,
    width: number,
    height: number,
    pixels: number,
  ) => {
    if (width < 1 || height < 1 || pixels < 1) return;
    const key = [
      edge,
      Math.round(left),
      Math.round(top),
      Math.round(width),
      Math.round(height),
    ].join("-");
    regions.set(key, {
      height,
      key,
      kind,
      label: `${Math.round(pixels)}px`,
      left,
      top,
      width,
    });
  };

  for (const anchor of anchors) {
    const box = anchor.box;
    if (boxesMatch(box, inner) || !containsBox(box, inner)) continue;

    for (const [edge, y, thickness] of [
      ["top", box.top, anchor.edges.top],
      ["bottom", box.bottom, anchor.edges.bottom],
    ] as const) {
      if (thickness <= 0) continue;
      const height = Math.max(2, thickness);
      const top = y - height / 2;
      add(
        `${edge}-left`,
        "edge-overhang",
        box.left,
        top,
        inner.left - box.left,
        height,
        inner.left - box.left,
      );
      add(
        `${edge}-right`,
        "edge-overhang",
        inner.right,
        top,
        box.right - inner.right,
        height,
        box.right - inner.right,
      );
    }

    for (const [edge, x, thickness] of [
      ["left", box.left, anchor.edges.left],
      ["right", box.right, anchor.edges.right],
    ] as const) {
      if (thickness <= 0) continue;
      const width = Math.max(2, thickness);
      const left = x - width / 2;
      add(
        `${edge}-top`,
        "edge-overhang",
        left,
        box.top,
        width,
        inner.top - box.top,
        inner.top - box.top,
      );
      add(
        `${edge}-bottom`,
        "edge-overhang",
        left,
        inner.bottom,
        width,
        box.bottom - inner.bottom,
        box.bottom - inner.bottom,
      );
    }
  }

  for (const anchor of anchors) {
    const box = anchor.box;
    if (boxesMatch(box, inner) || containsBox(box, inner)) continue;

    const verticalIntersection = [inner.left, inner.right].some(
      (line) => line > box.left + 1 && line < box.right - 1,
    );
    const horizontalIntersection = [inner.top, inner.bottom].some(
      (line) => line > box.top + 1 && line < box.bottom - 1,
    );
    if (!verticalIntersection && !horizontalIntersection) continue;

    const key = [
      "intersection",
      Math.round(box.left),
      Math.round(box.top),
      Math.round(box.width),
      Math.round(box.height),
    ].join("-");
    regions.set(key, {
      height: box.height,
      key,
      kind: "line-intersection",
      label: "line overlap",
      left: box.left,
      top: box.top,
      width: box.width,
    });
  }

  return [...regions.values()];
}
