import type { LocalBox } from "./prototype-design-analysis";
import {
  prototypeDesignGridHint,
  prototypeDesignGridReferenceLabel,
} from "./prototype-design-grid-copy";
import type {
  PrototypeDesignFibonacciStep,
  PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { prototypeDesignPrimaryGridLevel } from "./prototype-design-grid-analysis";
import { PrototypeDesignGridBackdrop } from "./prototype-design-overlays";
import { prototypeDesignResponsiveColumns } from "./prototype-design-columns";

export function PrototypeDesignGridStatus({
  affectedLayers,
  box,
  canvasWidth,
  fibonacciSteps,
  gridContrast,
  gridMode,
  gridSize,
  gridViolations,
  guideViolations,
  inner,
  locked,
  scope,
  showGridViolations,
}: {
  affectedLayers: number;
  box?: LocalBox;
  canvasWidth: number;
  fibonacciSteps: PrototypeDesignFibonacciStep[];
  gridContrast: number;
  gridMode: PrototypeDesignGridMode;
  gridSize: number;
  gridViolations: number;
  guideViolations: number;
  inner: boolean;
  locked: boolean;
  scope: "global" | "selection";
  showGridViolations: boolean;
}) {
  const activeLevel = prototypeDesignPrimaryGridLevel(
    gridSize,
    gridMode,
    fibonacciSteps,
  );
  const columns = scope === "global"
    ? prototypeDesignResponsiveColumns(canvasWidth)
    : undefined;
  return (
    <PrototypeDesignGridBackdrop
      box={scope === "global" ? undefined : box}
      columns={columns}
      contrast={gridContrast}
      fibonacciSteps={fibonacciSteps}
      gridMode={gridMode}
      gridSize={gridSize}
      hint={`${columns ? `${columns.count} columns · ${columns.gutter}px gutter · ${columns.margin}px margin · ` : ""}${prototypeDesignGridHint({
        activeLayerSize: activeLevel,
        affectedLayers,
        gridMode,
        gridViolations,
        guideViolations,
        inner,
        locked,
        scope,
        showGridViolations,
      })}`}
    />
  );
}

export function PrototypeDesignReferenceLabel({
  activeLayerSize,
  approvedAncestors,
  box,
  currentScopeApproved,
  label,
  scope,
  measurement,
}: {
  activeLayerSize?: number;
  approvedAncestors: number;
  box: LocalBox;
  currentScopeApproved: boolean;
  label: string;
  measurement(pixels: number): string;
  scope: "global" | "selection";
}) {
  return (
    <div
      className="prototype-design-tool__label"
      style={{ left: Math.max(8, box.left), top: Math.max(28, box.top + 8) }}
    >
      {approvedAncestors ? `${approvedAncestors} parent${approvedAncestors === 1 ? "" : "s"} ✓ · ` : ""}
      {currentScopeApproved ? "Current approved ✓" : "Current review"} ·{" "}
      {prototypeDesignGridReferenceLabel(activeLayerSize, scope)}: {label} ·{" "}
      {measurement(box.width)} × {measurement(box.height)}
    </div>
  );
}
