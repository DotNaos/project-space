import type { PrototypeViewportKind } from "../../../src/shared/prototype-canvas";
import type { MeasuredElement } from "./prototype-design-analysis";
import {
  prototypeDesignGridAnalysis,
  prototypeDesignGridEdgeOffset,
  prototypeDesignPrimaryGridLevel,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGridAnalysis,
  type PrototypeDesignGridEdge,
  type PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { prototypeDesignDescendantAnchors } from "./prototype-design-dom";

export interface PrototypeDesignAuditNode {
  children: PrototypeDesignAuditNode[];
  element: MeasuredElement;
}

export interface PrototypeDesignAutoAuditResult {
  analysis: PrototypeDesignGridAnalysis;
  approved: MeasuredElement[];
  depth: number;
  failure: MeasuredElement | null;
  gridSize: number;
  message: string | null;
  passedLayers: number;
  trail: MeasuredElement[];
  violationsAtStop: number;
}

export function prototypeDesignAuditTree(
  root: HTMLElement,
  measure: (element: HTMLElement) => MeasuredElement,
  maximumDepth = 12,
): PrototypeDesignAuditNode {
  const build = (element: HTMLElement, depth: number): PrototypeDesignAuditNode => ({
    children:
      depth >= maximumDepth
        ? []
        : prototypeDesignDescendantAnchors(element).map((child) =>
            build(child, depth + 1),
          ),
    element: measure(element),
  });
  return build(root, 0);
}

const edgeNames: Record<PrototypeDesignGridEdge, string> = {
  bottom: "bottom",
  left: "left",
  right: "right",
  top: "top",
};

function uniqueElements(elements: MeasuredElement[]) {
  return [...new Map(elements.map((element) => [
    `${element.label}-${element.box.left}-${element.box.top}-${element.box.width}-${element.box.height}`,
    element,
  ])).values()];
}

function elementArea(element: MeasuredElement) {
  return element.box.width * element.box.height;
}

function edgeOrientation(edge: PrototypeDesignGridEdge) {
  return edge === "left" || edge === "right" ? "vertical" : "horizontal";
}

function sharesEveryViolationEdge(
  candidate: {
    analysis: PrototypeDesignGridAnalysis;
    child: PrototypeDesignAuditNode;
  },
  other: {
    analysis: PrototypeDesignGridAnalysis;
    child: PrototypeDesignAuditNode;
  },
) {
  const candidateEdges = candidate.analysis.layers[0]?.edges ?? [];
  const otherEdges = other.analysis.layers[0]?.edges ?? [];
  return candidateEdges.length > 0 && candidateEdges.every((edge) =>
    otherEdges.some(
      (otherEdge) =>
        edgeOrientation(edge) === edgeOrientation(otherEdge) &&
        Math.abs(
          candidate.child.element.box[edge] -
            other.child.element.box[otherEdge],
        ) <= 0.75,
    ),
  );
}

export function prototypeDesignAuditGridLevels(
  base: number,
  mode: PrototypeDesignGridMode,
  fibonacciSteps: PrototypeDesignFibonacciStep[],
  maximumDepth = 12,
) {
  const root = prototypeDesignPrimaryGridLevel(
    base,
    mode,
    fibonacciSteps,
  );
  const configured = mode === "fibonacci"
    ? fibonacciSteps.map((step) => base * step.multiplier)
    : [base, base * 2, base * 4];
  const detailFloor = Math.min(base, 4);
  const levels = [...new Set([...configured, detailFloor, 4])]
    .filter((level) => level > 0 && level <= root)
    .sort((first, second) => second - first);
  while (levels.length < maximumDepth) {
    levels.push(levels.at(-1) ?? detailFloor);
  }
  return levels.slice(0, maximumDepth);
}

export function prototypeDesignResponsiveAuditGridLevels(
  viewport: PrototypeViewportKind,
  maximumDepth = 12,
) {
  const structuralGrid = viewport === "phone" ? 4 : 8;
  const levels = structuralGrid === 4 ? [4] : [8, 4];
  while (levels.length < maximumDepth) levels.push(4);
  return levels.slice(0, maximumDepth);
}

export function prototypeDesignAutoAudit(
  root: PrototypeDesignAuditNode,
  gridLevels: number[],
): PrototypeDesignAutoAuditResult {
  const emptyAnalysis: PrototypeDesignGridAnalysis = { cells: [], layers: [] };

  const visit = (
    node: PrototypeDesignAuditNode,
    depth: number,
    approved: MeasuredElement[],
    trail: MeasuredElement[],
    passedLayers: number,
  ): PrototypeDesignAutoAuditResult => {
    const gridSize = gridLevels[Math.min(depth, gridLevels.length - 1)] ?? 1;
    if (node.children.length === 0) {
      return {
        analysis: emptyAnalysis,
        approved: uniqueElements([...approved, node.element]),
        depth,
        failure: null,
        gridSize,
        message: null,
        passedLayers,
        trail,
        violationsAtStop: 0,
      };
    }

    const checks = node.children.map((child) => ({
      analysis: prototypeDesignGridAnalysis(
        [child.element],
        [gridSize],
        0.75,
        node.element.box,
        "columns",
      ),
      child,
    }));
    const rawViolations = checks.filter(
      (check) => check.analysis.layers.length > 0,
    );
    const transferredToSibling = rawViolations.filter((candidate) =>
      rawViolations.some(
        (other) =>
          other !== candidate &&
          elementArea(candidate.child.element) > elementArea(other.child.element) &&
          sharesEveryViolationEdge(candidate, other),
      ),
    );
    const violations = rawViolations
      .filter((check) => !transferredToSibling.includes(check))
      .sort(
        (first, second) =>
          second.child.element.box.width * second.child.element.box.height -
          first.child.element.box.width * first.child.element.box.height,
      );
    const passed = checks
      .filter((check) => check.analysis.layers.length === 0)
      .map((check) => check.child.element)
      .concat(transferredToSibling.map((check) => check.child.element));

    if (violations.length > 0) {
      const first = violations[0];
      const edge = first.analysis.layers[0]?.edges[0];
      const offset = edge
        ? prototypeDesignGridEdgeOffset(
            first.child.element.box,
            edge,
            gridSize,
            node.element.box,
          )
        : 0;
      return {
        analysis: first.analysis,
        approved: uniqueElements([...approved, ...passed]),
        depth,
        failure: first.child.element,
        gridSize,
        message: edge
          ? `${first.child.element.label}: ${edgeNames[edge]} edge is ${Math.round(offset * 10) / 10}px off the ${gridSize}px grid`
          : null,
        passedLayers: passedLayers + passed.length,
        trail,
        violationsAtStop: violations.length,
      };
    }

    const layerApproved = uniqueElements([
      ...approved,
      ...node.children.map((child) => child.element),
    ]);
    const orderedChildren = [...node.children].sort(
      (first, second) =>
        second.element.box.width * second.element.box.height -
        first.element.box.width * first.element.box.height,
    );
    let accumulated = layerApproved;
    let totalPassed = passedLayers + node.children.length;
    for (const child of orderedChildren) {
      const result = visit(
        child,
        depth + 1,
        accumulated,
        [...trail, node.element],
        totalPassed,
      );
      if (result.failure) return result;
      accumulated = result.approved;
      totalPassed = result.passedLayers;
    }
    return {
      analysis: emptyAnalysis,
      approved: uniqueElements([...accumulated, node.element]),
      depth,
      failure: null,
      gridSize,
      message: null,
      passedLayers: totalPassed,
      trail,
      violationsAtStop: 0,
    };
  };

  return visit(root, 0, [], [], 0);
}
