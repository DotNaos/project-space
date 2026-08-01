import type { MeasuredElement } from "./prototype-design-analysis";
import {
  prototypeDesignGridAnalysis,
  type PrototypeDesignGridAnalysis,
  type PrototypeDesignGridEdge,
} from "./prototype-design-grid-analysis";

const edgeNames: Record<PrototypeDesignGridEdge, string> = {
  bottom: "bottom",
  left: "left",
  right: "right",
  top: "top",
};

function distanceToGrid(value: number, size: number) {
  const remainder = ((value % size) + size) % size;
  return Math.min(remainder, size - remainder);
}

export function prototypeDesignPriorityAnalysis(
  anchors: MeasuredElement[],
  gridSize: number,
) {
  const ordered = [...anchors].sort(
    (first, second) =>
      second.box.width * second.box.height -
      first.box.width * first.box.height,
  );
  const violations = ordered.flatMap((anchor) => {
    const analysis = prototypeDesignGridAnalysis([anchor], [gridSize]);
    return analysis.layers.length ? [{ analysis, anchor }] : [];
  });
  const first = violations[0];
  const analysis: PrototypeDesignGridAnalysis = first?.analysis ?? {
    cells: [],
    layers: [],
  };
  const edge = analysis.layers[0]?.edges[0];
  const offset = edge
    ? distanceToGrid(first.anchor.box[edge], gridSize)
    : 0;
  return {
    analysis,
    nextFix:
      first && edge
        ? `${first.anchor.label}: ${edgeNames[edge]} edge is ${Math.round(offset * 10) / 10}px off the ${gridSize}px grid`
        : null,
    remainingEdges: violations.reduce(
      (total, violation) => total + violation.analysis.layers[0].edges.length,
      0,
    ),
    remainingLayers: violations.length,
  };
}
