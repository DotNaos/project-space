import type { PrototypeViewportKind } from "../../../src/shared/prototype-canvas";
import {
  prototypeDesignResponsiveFibonacciSteps,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import { prototypeDesignResolvedGrid } from "./prototype-design-resolved-grid";
import { usePrototypeLayerGrids } from "./use-prototype-layer-grids";

export function usePrototypeResponsiveLayerGrid({
  contrast,
  fibonacciSteps,
  mode,
  root,
  size,
  target,
  viewport,
}: {
  contrast: number;
  fibonacciSteps: PrototypeDesignFibonacciStep[];
  mode: PrototypeDesignGridMode;
  root: HTMLElement | null;
  size: number;
  target: HTMLElement | null;
  viewport: PrototypeViewportKind;
}) {
  const rootFibonacciSteps = prototypeDesignResponsiveFibonacciSteps(
    fibonacciSteps,
    size,
    viewport,
  );
  const layerGrids = usePrototypeLayerGrids({
    contrast,
    fibonacciSteps: rootFibonacciSteps,
    mode,
    size,
  });
  const activeLayerGrid = layerGrids.profileFor(target, root);
  const [
    activeGridContrast,
    activeFibonacciSteps,
    activeGridMode,
    activeGridSize,
    activeGridLevel,
  ] = prototypeDesignResolvedGrid(activeLayerGrid, {
    contrast,
    fibonacciSteps: rootFibonacciSteps,
    mode,
    size,
  });
  return {
    activeFibonacciSteps,
    activeGridContrast,
    activeGridLevel,
    activeGridMode,
    activeGridSize,
    activeLayerGrid,
    layerGrids,
  };
}
