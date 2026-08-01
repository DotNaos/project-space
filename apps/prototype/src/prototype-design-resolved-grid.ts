import {
  prototypeDesignPrimaryGridLevel,
  type PrototypeDesignFibonacciStep,
  type PrototypeDesignGridMode,
} from "./prototype-design-grid-analysis";
import type { PrototypeDesignLayerGrid } from "./use-prototype-layer-grids";

export function prototypeDesignResolvedGrid(
  profile: PrototypeDesignLayerGrid | null,
  fallback: {
    contrast: number;
    fibonacciSteps: PrototypeDesignFibonacciStep[];
    mode: PrototypeDesignGridMode;
    size: number;
  },
) {
  const grid = profile ?? fallback;
  return [
    grid.contrast,
    grid.fibonacciSteps,
    grid.mode,
    grid.size,
    prototypeDesignPrimaryGridLevel(
      grid.size,
      grid.mode,
      grid.fibonacciSteps,
    ),
  ] as const;
}
