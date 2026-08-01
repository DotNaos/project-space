import type { PrototypeDesignGridMode } from "./prototype-design-grid-analysis";

export function prototypeDesignGridModeLabel(mode: PrototypeDesignGridMode) {
  return mode === "fibonacci" ? "Fibonacci" : "Linear";
}

export function prototypeDesignGridHint({
  affectedLayers,
  activeLayerSize,
  gridMode,
  gridViolations,
  guideViolations,
  inner,
  locked,
  scope,
  showGridViolations,
}: {
  affectedLayers: number;
  activeLayerSize?: number;
  gridMode: PrototypeDesignGridMode;
  gridViolations: number;
  guideViolations: number;
  inner: boolean;
  locked: boolean;
  scope: "global" | "selection";
  showGridViolations: boolean;
}) {
  if (inner) {
    return `${gridViolations} overlaps · L enters finer grid · ${guideViolations} guide violations · ⌥Click/P pin`;
  }
  const mode = prototypeDesignGridModeLabel(gridMode);
  if (!locked) return `${mode} grid · Select an element · ⌥G closes`;
  const layer = activeLayerSize
    ? `${scope === "global" ? "Root" : "Layer"} grid ${activeLayerSize}px · `
    : "";
  const violations = showGridViolations
    ? `${affectedLayers} affected layers · ${gridViolations} off-grid edges`
    : "Grid violations hidden";
  return `${layer}${mode} · ${scope === "global" ? "Global audit" : "Selection"} · ${violations} · ${guideViolations} guide violations`;
}

export function prototypeDesignGridReferenceLabel(
  activeLayerSize: number | undefined,
  scope: "global" | "selection",
) {
  if (activeLayerSize) {
    return `${scope === "global" ? "Root" : "Layer"} grid ${activeLayerSize}px`;
  }
  return scope === "global" ? "App root" : "Unapproved";
}
